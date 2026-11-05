// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Category access (steward-gateway internal/resolvers/raci_resolver.go): each category's own RACI
// rules as steward-core stores them, the access simulator, and resolveUserLabels. The simulator
// evaluates the category chain the way steward-authz's Compile and Resolve do (resolve.go at the
// gateway's pinned commit): owners anywhere in the chain read, approve and author; then every
// rule top-down, the target category first, the first non-blank cell deciding; anything left is
// denied. Read gates the other three, and an allowed author or approve confers read. The
// simulator's subject is the person's id and IdP groups only, as the gateway's meritSubject, so
// the site-admin read never applies there.
//
// These rules drive the simulator only; the mock's read model (access.ts) still decides from the
// categories' owners and approve and author lists.

import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { type Category, type RaciRule } from "#product/data/library.ts";
import {
  caller,
  data,
  found,
  people,
  record,
  refuse,
  siteAdmin,
  withAnyRole,
} from "#product/resolvers/shared.ts";

/** steward-gateway's maxCategoryDepth: how far up a chain is followed. */
const MAX_DEPTH = 16;

type Action = "ack" | "approve" | "author" | "read";

interface Decision {
  allowed: boolean;
  reason: string;
}

interface Subject {
  groups: string[];
  userId: string;
}

const categoryOf = (id: string) => data().categories.find((c) => c.id === id);

/** The category and its ancestors, target first, as buildCategoryChain walks them. */
const chainOf = (category: Category): Category[] => {
  const chain: Category[] = [];
  for (
    let at: Category | undefined = category;
    at && chain.length < MAX_DEPTH;
    at = at.parentId ? categoryOf(at.parentId) : undefined
  )
    chain.push(at);
  return chain;
};

/** steward-authz's RuleSubject.matches: group names case-insensitively, user ids exactly. */
const matches = (rule: RaciRule, subject: Subject) => {
  if (rule.subjectKind === "EVERYONE") return true;
  if (rule.subjectKind === "USER") return rule.subjectRef === subject.userId;
  const wanted = rule.subjectRef.toLowerCase();
  return subject.groups.some((g) => g.toLowerCase() === wanted);
};

const DEFAULT_DENY: Decision = {
  allowed: false,
  reason: "no rule → default deny",
};
const OWNER: Decision = {
  allowed: true,
  reason: "owner (auto read/approve/author)",
};

/** RuleDecision.String for a rule: "rule #2 deny group All staff", "↳ Workplace #1 allow everyone". */
const ruleReason = (
  category: Category,
  depth: number,
  index: number,
  rule: RaciRule,
  allowed: boolean,
) => {
  const location =
    depth > 0
      ? `↳ ${category.name} #${String(index + 1)}`
      : `rule #${String(index + 1)}`;
  const who = rule.subjectKind.toLowerCase();
  const named = rule.subjectRef ? `${who} ${rule.subjectRef}` : who;
  return `${location} ${allowed ? "allow" : "deny"} ${named}`;
};

/** One action's decision, before the read gate. */
const decide = (
  chain: Category[],
  rulesOf: (category: Category, depth: number) => RaciRule[],
  subject: Subject,
  action: Action,
): Decision => {
  if (action !== "ack" && chain.some((c) => c.owners.includes(subject.userId)))
    return OWNER;
  for (const [depth, category] of chain.entries())
    for (const [index, rule] of rulesOf(category, depth).entries()) {
      const grant = rule[action];
      if (grant === "BLANK" || !matches(rule, subject)) continue;
      const allowed = grant === "ALLOW";
      return {
        allowed,
        reason: ruleReason(category, depth, index, rule, allowed),
      };
    }
  return DEFAULT_DENY;
};

/** steward-authz's Resolve: read gates the rest, and author or approve confers read. */
const resolve = (
  chain: Category[],
  rulesOf: (category: Category, depth: number) => RaciRule[],
  subject: Subject,
) => {
  const one = (action: Action) => decide(chain, rulesOf, subject, action);
  let read = one("read");
  if (!read.allowed) {
    if (one("author").allowed)
      read = { allowed: true, reason: "author implies read" };
    else if (one("approve").allowed)
      read = { allowed: true, reason: "approver implies read" };
  }
  const gated = (action: Action): Decision =>
    read.allowed ? one(action) : { allowed: false, reason: "requires read" };
  const ack = gated("ack");
  const approve = gated("approve");
  const author = gated("author");
  return {
    ack: ack.allowed,
    ackReason: ack.reason,
    approve: approve.allowed,
    approveReason: approve.reason,
    author: author.allowed,
    authorReason: author.reason,
    read: read.allowed,
    readReason: read.reason,
  };
};

/** steward-authz's CategoryRuleset.Validate, as steward-core runs it before storing. */
const validated = (category: Category, rules: RaciRule[]): RaciRule[] => {
  for (const [index, rule] of rules.entries()) {
    const named = rule.subjectRef.trim() !== "";
    const valid =
      rule.subjectKind === "EVERYONE" ? rule.subjectRef === "" : named;
    if (!valid)
      throw refuse(
        "BAD_USER_INPUT",
        `authz: invalid access rule (category ${category.name}, rule ${String(index + 1)}, subject)`,
      );
  }
  return rules.map((r) => ({ ...r }));
};

const sameGrants = (a: RaciRule, b: RaciRule) =>
  a.read === b.read &&
  a.ack === b.ack &&
  a.approve === b.approve &&
  a.author === b.author;

/** Rules grouped by subject, in order. */
const bySubject = (rules: RaciRule[]) => {
  const map = new Map<string, RaciRule[]>();
  for (const rule of rules) {
    const key = `${rule.subjectKind}\u0000${rule.subjectRef}`;
    map.set(key, [...(map.get(key) ?? []), rule]);
  }
  return map;
};

/**
 * steward-core's emitCategoryRuleAudit: rules are paired by subject in order, and each pair
 * created, removed or changed is one entry under the category.
 */
const auditChange = (
  actor: StewardPerson,
  category: Category,
  before: RaciRule[],
  after: RaciRule[],
) => {
  const olds = bySubject(before);
  const news = bySubject(after);
  const keys = [...new Set([...news.keys(), ...olds.keys()])].toSorted();
  const subject = {
    groupId: category.id,
    groupName: category.name,
    id: category.id,
    kind: "category",
    label: category.name,
  };
  for (const key of keys) {
    const was = olds.get(key) ?? [];
    const now = news.get(key) ?? [];
    for (let index = 0; index < Math.max(was.length, now.length); index++) {
      const old = was[index];
      const next = now[index];
      if (!old) record("category_rule.created", actor, subject);
      else if (!next) record("category_rule.deleted", actor, subject);
      else if (!sameGrants(old, next))
        record("category_rule.updated", actor, subject);
    }
  }
};

export const raciResolvers: Resolvers = {
  Mutation: {
    setCategoryRuleset: (
      _root,
      given: { categoryId: string; rules: RaciRule[] },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const category = found(categoryOf(given.categoryId), "category");
      const rules = validated(category, given.rules);
      const before = category.rules;
      category.rules = rules;
      auditChange(actor, category, before, rules);
      return { categoryId: category.id, rules };
    },
  },
  Query: {
    categoryRuleset: (
      _root,
      given: { categoryId: string },
      context: Context,
    ) => {
      withAnyRole(context, "template-admin");
      return {
        categoryId: given.categoryId,
        rules: categoryOf(given.categoryId)?.rules ?? [],
      };
    },
    resolveUserLabels: (_root, given: { ids: string[] }, context: Context) => {
      caller(context);
      return given.ids.map((id) => {
        const person = people().find((p) => p.id === id);
        return {
          email: person?.email || null,
          id,
          name: person?.name || person?.email || id,
        };
      });
    },
    simulateCategory: (
      _root,
      given: {
        categoryId: string;
        draftRules?: null | RaciRule[];
        userId: string;
      },
      context: Context,
    ) => {
      withAnyRole(context, "template-admin");
      const chain = chainOf(found(categoryOf(given.categoryId), "category"));
      const draft = given.draftRules;
      const rulesOf = (category: Category, depth: number) =>
        depth === 0 && draft !== null && draft !== undefined
          ? draft
          : category.rules;
      if (given.userId === "")
        return resolve(chain, rulesOf, { groups: [], userId: "" });
      const person = found(
        people().find((p) => p.id === given.userId),
        "user",
      );
      return resolve(chain, rulesOf, {
        groups: person.idpGroups,
        userId: person.id,
      });
    },
  },
};
