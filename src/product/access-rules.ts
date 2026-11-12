// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Category access as steward-gateway decides it (access_ordered.go, raci_map.go): the categories'
// rows and owners become an ordered.RuleSet, the person becomes an ordered.Person, and the one
// engine in ordered.ts answers. The simulator, the approver pool, the policy read model and the
// move gate all ask here, so there is a single evaluator.
//
// A rule is one row: a subject and a cell (blank, allow, deny) for each of Read, Author,
// Approve, Manage and Ack. Blank cells have no entry. The root seat (the account with the root
// flag, as the engine's role "root") always holds Read, Author and Manage; a deny against it on
// those is kept and reported as a configured block, never applied. Approve and Ack follow the rows
// for root, and a site admin who is not root follows them like everyone.

import type { RaciGrant, RaciRule } from "#product/data/library.ts";
import type { StewardPerson } from "#product/data/people.ts";

import { stewardData } from "#product/data.ts";
import { idpGroupsOf, isRoot } from "#product/groups.ts";
import {
  decide,
  type Decision,
  defaultActions,
  type Entry,
  EVERYONE,
  type Model,
  type Person,
  pool,
  type PoolEntry,
  type RuleSet,
} from "#product/ordered.ts";

/** The engine role of the one root seat; it comes from the root flag, never a name or an id. */
const ROOT_ROLE = "root";

/** steward-gateway's maxCategoryDepth: how far up a chain is followed. */
const MAX_DEPTH = 16;

export const ACTIONS = ["read", "author", "approve", "manage", "ack"] as const;
export type AccessAction = (typeof ACTIONS)[number];

/**
 * The engine's configuration: the five actions (Manage implies Read and Author, Approve and
 * Author imply Read, Ack requires Read, owners hold Read, Author, Approve and Manage but not Ack)
 * and the root seat, exempt for Read, Author and Manage only.
 */
export const accessModel = (): Model => ({
  actions: defaultActions(),
  superusers: {
    actions: ["read", "author", "manage"],
    subjects: [`role:${ROOT_ROLE}`],
  },
});

/** The acknowledge rule alone, with Ack's Read requirement lifted. */
const ackUngatedModel = (): Model => ({
  ...accessModel(),
  actions: defaultActions().map((a) =>
    a.id === "ack" ? { ...a, requires: [] } : a,
  ),
});

const categoryOf = (id: string) =>
  stewardData().categories.find((c) => c.id === id);

/** The category's id and its ancestors', nearest first. */
export const lineageOf = (categoryId: string): string[] => {
  const ids: string[] = [];
  for (
    let at = categoryOf(categoryId);
    at && ids.length < MAX_DEPTH;
    at = at.parentId ? categoryOf(at.parentId) : undefined
  )
    ids.push(at.id);
  return ids;
};

const subjectOf = (rule: Pick<RaciRule, "subjectKind" | "subjectRef">) => {
  if (rule.subjectKind === "GROUP") return `group:${rule.subjectRef}`;
  if (rule.subjectKind === "USER") return `user:${rule.subjectRef}`;
  return EVERYONE;
};

/** A row as engine cells: one entry per non-blank cell, in the order of the five actions. */
const entriesOf = (rule: RaciRule): Entry[] => {
  const subject = subjectOf(rule);
  const cells: [AccessAction, RaciGrant][] = [
    ["read", rule.read],
    ["author", rule.author],
    ["approve", rule.approve],
    ["manage", rule.manage],
    ["ack", rule.ack],
  ];
  return cells.flatMap(([action, grant]) =>
    grant === "BLANK"
      ? []
      : [{ action, effect: grant === "ALLOW" ? "allow" : "deny", subject }],
  );
};

/** The engine's reading of a subject string, as a rule's kind and reference. */
const ruleSubjectOf = (
  subject: string,
): Pick<RaciRule, "subjectKind" | "subjectRef"> => {
  if (subject === EVERYONE) return { subjectKind: "EVERYONE", subjectRef: "" };
  if (subject.startsWith("group:"))
    return { subjectKind: "GROUP", subjectRef: subject.slice("group:".length) };
  return { subjectKind: "USER", subjectRef: subject.replace(/^user:/, "") };
};

interface Access {
  leaf: string;
  names: Map<string, string>;
  rules: RuleSet;
}

/**
 * One category's rules and its ancestors', ready to decide. Owners are people and are matched as
 * "user:<id>". `draft` replaces the category's own rows only, as the simulator's draft does;
 * ancestors and owners stay as stored.
 */
const loadAccess = (categoryId: string, draft?: RaciRule[]): Access => {
  const ids = lineageOf(categoryId);
  const access: Access = {
    leaf: categoryId,
    names: new Map(),
    rules: { categories: {}, parents: {} },
  };
  for (const [index, id] of ids.entries()) {
    const category = categoryOf(id)!;
    const own = index === 0 && draft ? draft : category.rules;
    access.rules.categories[id] = {
      entries: own.flatMap((rule) => entriesOf(rule)),
      owners: category.owners.map((owner) => `user:${owner}`),
    };
    access.names.set(id, category.name);
    const parent = ids[index + 1];
    if (parent) access.rules.parents[id] = parent;
  }
  return access;
};

/** The engine's person: the id, the IdP groups (matched exactly) and the root role. */
export const personOf = (person: StewardPerson): Person => ({
  groups: idpGroupsOf(person),
  id: person.id,
  roles: isRoot(person) ? [ROOT_ROLE] : [],
});

/** The baseline: no one in particular, which only the Everyone rows reach. */
export const NOBODY: Person = { id: "" };

export interface CategoryDecisions {
  ack: Decision;
  /** The acknowledge rule without its Read requirement. */
  ackUngated: boolean;
  approve: Decision;
  author: Decision;
  manage: Decision;
  names: Map<string, string>;
  read: Decision;
}

/** Every action's decision for the person on the category (the nothing-at-all for an unknown one). */
export const decideCategory = (
  person: Person,
  categoryId: string,
  draft?: RaciRule[],
): CategoryDecisions => {
  const access = loadAccess(categoryId, draft);
  const model = accessModel();
  const ask = (m: Model, action: AccessAction) =>
    decide(m, access.rules, person, access.leaf, action);
  return {
    ack: ask(model, "ack"),
    ackUngated: ask(ackUngatedModel(), "ack").allowed,
    approve: ask(model, "approve"),
    author: ask(model, "author"),
    manage: ask(model, "manage"),
    names: access.names,
    read: ask(model, "read"),
  };
};

/** Owners first, then root if a row allows, then the people the rows allow. */
export const poolOf = (
  people: StewardPerson[],
  categoryId: string,
  action: AccessAction,
): PoolEntry[] => {
  const access = loadAccess(categoryId);
  return pool(
    accessModel(),
    access.rules,
    people.map((p) => personOf(p)),
    access.leaf,
    action,
  );
};

/** Whether the person (a mock person) is allowed the action on the category. */
export const can = (
  person: StewardPerson,
  categoryId: string,
  action: AccessAction,
): boolean => decideCategory(personOf(person), categoryId)[action].allowed;

// -- the simulator's report ------------------------------------------------------------------

type Code = "DEFAULT_DENY" | "ENTRY" | "OWNER" | "REQUIRES" | "ROOT";

const codeOf = (decision: Decision): Code => {
  switch (decision.reason) {
    case "entry": {
      return "ENTRY";
    }
    case "owner": {
      return "OWNER";
    }
    case "requires": {
      return "REQUIRES";
    }
    case "superuser": {
      return "ROOT";
    }
    default: {
      return "DEFAULT_DENY";
    }
  }
};

/** raci_map.go's entryLabel: the row that decided, and where it lives. */
const labelOf = (entry: Entry, names: Map<string, string>) => {
  const { subjectKind, subjectRef } = ruleSubjectOf(entry.subject);
  const who =
    subjectKind === "EVERYONE"
      ? "Everyone"
      : `${subjectKind.toLowerCase()} ${subjectRef}`;
  const where = entry.category ? names.get(entry.category) : undefined;
  return where ? `${who} in ${where}` : who;
};

/** raci_map.go's reasonText: the human reason; the structured code travels beside it. */
const reasonText = (decision: Decision, names: Map<string, string>) => {
  switch (decision.reason) {
    case "entry": {
      return `${decision.allowed ? "allowed" : "denied"} by ${labelOf(decision.decidedBy!, names)}`;
    }
    case "owner": {
      return "allowed: owner of the category or a parent";
    }
    case "requires": {
      return `denied: requires ${decision.gatedBy}`;
    }
    case "superuser": {
      return decision.configuredBlock
        ? `blocked: a deny for ${labelOf(decision.configuredBlock, names)} is configured, but root is always allowed and ignores it`
        : "allowed: root";
    }
    default: {
      return "denied: no rule decides";
    }
  }
};

/** The RaciDecision the simulator answers. */
export const raciDecision = (decisions: CategoryDecisions) => {
  const configuredBlock = ACTIONS.flatMap((action) => {
    const block = decisions[action].configuredBlock;
    return block
      ? [
          {
            action: action.toUpperCase(),
            categoryId: block.category ?? "",
            ...ruleSubjectOf(block.subject),
          },
        ]
      : [];
  });
  const field = (action: AccessAction) => ({
    [`${action}Code`]: codeOf(decisions[action]),
    [`${action}Reason`]: reasonText(decisions[action], decisions.names),
    [action]: decisions[action].allowed,
  });
  return {
    ...field("read"),
    ...field("author"),
    ...field("approve"),
    ...field("manage"),
    ...field("ack"),
    configuredBlock,
  };
};
