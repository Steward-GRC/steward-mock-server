// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Category access (steward-gateway internal/resolvers/raci_resolver.go): each category's own RACI
// rules as steward-core stores them, the access simulator, the approver pool and
// resolveUserLabels. Nothing here decides: the simulator, the pool and the viewer's approver check
// ask access-rules.ts, which maps the categories onto the one ordered engine (ordered.ts) that
// steward-gateway runs through go-authz.
//
// The simulator's subject is the person's id, IdP groups and the root flag, as the gateway's
// personFromSubject, so a site admin who is not root follows the rows like everyone.

import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import {
  decideCategory,
  NOBODY,
  personOf,
  poolOf,
  raciDecision,
} from "#product/access-rules.ts";
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
import { asUser } from "#product/resolvers/users.ts";

const categoryOf = (id: string) => data().categories.find((c) => c.id === id);

/**
 * Whether the person reads a policy homed in the category, by the same rules the simulator runs:
 * steward-workflow asks the access model this about every approver before it seats them. A person
 * the mock does not know reads nothing.
 */
export const readsCategory = (userId: string, categoryId: string): boolean => {
  const person = people().find((p) => p.id === userId);
  if (!categoryOf(categoryId) || !person) return false;
  return decideCategory(personOf(person), categoryId).read.allowed;
};

/**
 * What the gateway's ruleInputToProto and core's ValidateCategoryRules do with the rules before
 * storing: Everyone carries no reference (the gateway clears it), a group or user rule names its
 * subject, and a cell the client left out is blank.
 */
const validated = (category: Category, rules: RaciRule[]): RaciRule[] =>
  rules.map((rule, index) => {
    if (rule.subjectKind !== "EVERYONE" && rule.subjectRef.trim() === "")
      throw refuse(
        "BAD_USER_INPUT",
        `authz: invalid access rule (category ${category.name}, rule ${String(index + 1)}, subject)`,
      );
    return {
      ...rule,
      manage: rule.manage ?? "BLANK",
      subjectRef: rule.subjectKind === "EVERYONE" ? "" : rule.subjectRef,
    };
  });

const sameGrants = (a: RaciRule, b: RaciRule) =>
  a.read === b.read &&
  a.ack === b.ack &&
  a.approve === b.approve &&
  a.author === b.author &&
  a.manage === b.manage;

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
    /** The approver pool: the category's owners (inherited) and everyone whose Approve allows. */
    categoryApprovers: (
      _root,
      given: { categoryId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      found(categoryOf(given.categoryId), "category");
      const candidates = people().filter((p) => !p.deletedAt);
      return poolOf(candidates, given.categoryId, "approve").map((entry) =>
        asUser(candidates.find((p) => p.id === entry.person)!),
      );
    },
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
      found(categoryOf(given.categoryId), "category");
      const draft = given.draftRules ?? undefined;
      if (given.userId === "")
        return raciDecision(decideCategory(NOBODY, given.categoryId, draft));
      const person = found(
        people().find((p) => p.id === given.userId),
        "user",
      );
      return raciDecision(
        decideCategory(personOf(person), given.categoryId, draft),
      );
    },
    /** True when the caller holds Approve in at least one category (a row, an owner or root). */
    viewerIsApprover: (_root, _given, context: Context) => {
      const person = caller(context);
      return data().categories.some(
        (c) => decideCategory(personOf(person), c.id).approve.allowed,
      );
    },
  },
};
