// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The ordered access engine, the one place the mock decides category access. It is a port of
// go-authz's ordered package (decide.go, model.go, pool.go), the engine steward-gateway runs, and
// ordered.test.ts runs go-authz's shared vectors through it.
//
// The model: a rule set holds categories, each with entries (a subject, an action and an effect)
// and owners. Entries that share a subject form a row. For one action the rows of the category
// are read from the top, then its parent's, and so on; the first row that matches the person and
// has a cell for the asked action decides, and an empty cell is skipped. Owners have the actions
// the model gives them whatever any row says. An allowed higher action gives the lower actions it
// implies, even over an explicit deny of the lower one. An action that requires another is denied
// when the required one is. A superuser seat (the root) is exempt only for the access actions it
// lists, and a deny that would have applied is reported as the decision's configuredBlock;
// approve, ack and any obligation are never exempt. The default is deny.
//
// Nothing here knows the mock's data: access-rules.ts maps categories and people onto it.

/** The subject every person has. */
export const EVERYONE = "everyone:*";

/** An action owed rather than held (approve, ack): owners hold it only when the action says so. */
export const OBLIGATION = "obligation";

export interface Action {
  id: string;
  /** Actions an allow of this one gives, transitively. */
  implies?: string[];
  kind?: string;
  /** Whether owners hold the action; unset means every action that is not an obligation. */
  ownerHas?: boolean;
  /** Actions that must also be answered allowed. */
  requires?: string[];
}

export interface Category {
  /** The cells, in order; the first appearance of a subject fixes its row. */
  entries: Entry[];
  /** Subjects (of a kind the model allows) that own the category and everything below it. */
  owners?: string[];
  /** Ignored, as in go-authz: inherited rows always apply. */
  stopInheriting?: boolean;
}

export interface Decision {
  allowed: boolean;
  /** Where the owner or the superuser seat applied. */
  at: string;
  /** With reason "superuser": the entry that would have denied the seat. */
  configuredBlock: Entry | null;
  /** The entry that decided; after a conferred answer, the higher action's entry. */
  decidedBy: Entry | null;
  /** With reason "requires": the required action that was not allowed. */
  gatedBy: string;
  reason: Reason;
  /** The 1-based position of the deciding row when a row decided directly; 0 for none. */
  row: number;
}

export type Effect = "allow" | "deny";

/** One cell: a subject, an action and an effect; category names where it lives in a decision. */
export interface Entry {
  action: string;
  category?: string;
  effect: Effect;
  subject: string;
}

export interface Model {
  actions: Action[];
  implicitSubjects?: string[];
  ownerActions?: string[];
  ownerKinds?: string[];
  superusers?: null | Superusers;
}

/** Whom a decision is about: "user:<id>", "group:<g>", "role:<r>" and the extra subjects. */
export interface Person {
  groups?: string[];
  id: string;
  roles?: string[];
  subjects?: string[];
}

export interface PoolEntry {
  category: string;
  /** True when the deciding row is the Everyone row. */
  everyone?: boolean;
  person: string;
  reason: Reason;
  /** The 0-based position of the deciding row in its category, when a row decided directly. */
  row?: number;
}

/** Why a decision came out as it did. */
export type Reason =
  | "default-deny"
  | "entry"
  | "owner"
  | "requires"
  | "superuser";

export interface RuleSet {
  categories: Record<string, Category>;
  /** A child category to its parent; a category that is not a key is a root. */
  parents: Record<string, string>;
}

export interface Superusers {
  actions: string[];
  subjects: string[];
}

/** The five actions of the shared vectors. */
export const defaultActions = (): Action[] => [
  { id: "read" },
  { id: "author", implies: ["read"] },
  { id: "approve", implies: ["read"], kind: OBLIGATION, ownerHas: true },
  { id: "manage", implies: ["author", "read"] },
  { id: "ack", kind: OBLIGATION, requires: ["read"] },
];

const subjectKind = (subject: string) => {
  const at = subject.indexOf(":");
  return at === -1 ? "" : subject.slice(0, at);
};

const subjectsOf = (model: Model, person: Person) => {
  const set = new Set<string>();
  if (person.id !== "") set.add(`user:${person.id}`);
  for (const group of person.groups ?? []) set.add(`group:${group}`);
  for (const role of person.roles ?? []) set.add(`role:${role}`);
  for (const subject of person.subjects ?? []) set.add(subject);
  for (const subject of model.implicitSubjects ?? [EVERYONE]) set.add(subject);
  return set;
};

/** Entries grouped into rows by subject, in order of first appearance. */
const rowsOf = (entries: Entry[]) => {
  const rows: { cells: Entry[]; subject: string }[] = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    let at = index.get(entry.subject);
    if (at === undefined) {
      at = rows.length;
      index.set(entry.subject, at);
      rows.push({ cells: [], subject: entry.subject });
    }
    rows[at]!.cells.push(entry);
  }
  return rows;
};

/** Every action an entry on `id` covers: itself and all it implies, transitively. */
const closure = (id: string, byId: Map<string, Action>) => {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.pop()!;
    for (const implied of byId.get(next)?.implies ?? [])
      if (!seen.has(implied)) {
        seen.add(implied);
        queue.push(implied);
      }
  }
  return seen;
};

const defaultDeny = (): Decision => ({
  allowed: false,
  at: "",
  configuredBlock: null,
  decidedBy: null,
  gatedBy: "",
  reason: "default-deny",
  row: 0,
});

class Evaluation {
  readonly byId: Map<string, Action>;
  readonly category: string;
  readonly chain: string[] = [];
  readonly model: Model;
  readonly rules: RuleSet;
  readonly subjects: Set<string>;

  constructor(model: Model, rules: RuleSet, person: Person, category: string) {
    this.model = model;
    this.rules = rules;
    this.category = category;
    this.byId = new Map(model.actions.map((a) => [a.id, a]));
    this.subjects = subjectsOf(model, person);
    // A cycle in the parents ends the walk.
    for (
      let at: string | undefined = category;
      at !== undefined && !this.chain.includes(at);
      at = rules.parents[at]
    )
      this.chain.push(at);
  }

  answer(action: string, rulesOnly: boolean): Decision {
    const own = this.core(action, rulesOnly);
    if (own.allowed) return own;
    const conferred = this.confer(action, rulesOnly);
    if (!conferred) return own;
    // The row of a conferred answer is the row of the asked action's own deny, when that deny
    // sits in the same category as the higher entry; otherwise the answer has no row of its own.
    const sameCategory =
      own.decidedBy !== null &&
      conferred.decidedBy !== null &&
      own.decidedBy.category === conferred.decidedBy.category;
    return { ...conferred, row: sameCategory ? own.row : 0 };
  }

  /** An allowed higher action gives the action it implies, even over a deny of the lower one. */
  confer(action: string, rulesOnly: boolean): Decision | undefined {
    for (const higher of this.model.actions) {
      if (higher.id === action || !closure(higher.id, this.byId).has(action))
        continue;
      const decision = this.core(higher.id, rulesOnly);
      if (decision.allowed) return decision;
    }
    return undefined;
  }

  /** One action with no implication and no gating; rulesOnly leaves the superuser seat out. */
  core(action: string, rulesOnly: boolean): Decision {
    const seat = this.model.superusers;
    if (!rulesOnly && seat && this.superuserHas(action))
      for (const subject of seat.subjects)
        if (this.subjects.has(subject))
          return {
            ...defaultDeny(),
            allowed: true,
            at: this.category,
            reason: "superuser",
          };
    if (this.ownerHas(action)) {
      const kinds = this.model.ownerKinds ?? ["user"];
      for (const category of this.chain)
        for (const owner of this.rules.categories[category]?.owners ?? [])
          if (kinds.includes(subjectKind(owner)) && this.subjects.has(owner))
            return {
              ...defaultDeny(),
              allowed: true,
              at: category,
              reason: "owner",
            };
    }
    for (const category of this.chain)
      for (const [index, row] of rowsOf(
        this.rules.categories[category]?.entries ?? [],
      ).entries()) {
        if (!this.subjects.has(row.subject)) continue;
        const cell = row.cells.find((c) => c.action === action);
        if (cell)
          return {
            ...defaultDeny(),
            allowed: cell.effect === "allow",
            decidedBy: {
              action: cell.action,
              category,
              effect: cell.effect,
              subject: cell.subject,
            },
            reason: "entry",
            row: index + 1,
          };
      }
    return defaultDeny();
  }

  ownerHas(id: string) {
    if (this.model.ownerActions) return this.model.ownerActions.includes(id);
    const action = this.byId.get(id);
    if (action?.ownerHas !== undefined) return action.ownerHas;
    return action?.kind !== OBLIGATION;
  }

  /** Approve, ack and any obligation are never exempt, even when the host lists them. */
  superuserHas(id: string) {
    return (
      (this.model.superusers?.actions.includes(id) ?? false) &&
      this.byId.get(id)?.kind !== OBLIGATION &&
      id !== "approve" &&
      id !== "ack"
    );
  }
}

/**
 * Whether the person may do the action in the category. An unknown action is a default deny. The
 * superuser seat is checked first, then owners, then the rows.
 */
export const decide = (
  model: Model,
  rules: RuleSet,
  person: Person,
  category: string,
  action: string,
): Decision => {
  const known = model.actions.find((a) => a.id === action);
  if (!known) return defaultDeny();
  const evaluation = new Evaluation(model, rules, person, category);
  const decision = evaluation.answer(action, false);
  if (decision.reason === "superuser") {
    const byRows = evaluation.answer(action, true);
    if (!byRows.allowed && byRows.decidedBy)
      decision.configuredBlock = { ...byRows.decidedBy };
  }
  if (decision.allowed && decision.reason === "entry")
    for (const required of known.requires ?? [])
      if (!evaluation.answer(required, false).allowed)
        return { ...defaultDeny(), gatedBy: required, reason: "requires" };
  return decision;
};

/**
 * The people for whom the action is allowed in the category: owners first, then the superuser
 * seat, then the people a row allows, each in the order of `people`.
 */
export const pool = (
  model: Model,
  rules: RuleSet,
  people: Person[],
  category: string,
  action: string,
): PoolEntry[] => {
  const owners: PoolEntry[] = [];
  const seats: PoolEntry[] = [];
  const rows: PoolEntry[] = [];
  for (const person of people) {
    const decision = decide(model, rules, person, category, action);
    if (!decision.allowed) continue;
    if (decision.reason === "owner")
      owners.push({
        category: decision.at,
        person: person.id,
        reason: "owner",
      });
    else if (decision.reason === "superuser")
      seats.push({
        category: decision.at,
        person: person.id,
        reason: "superuser",
      });
    else {
      const entry: PoolEntry = {
        category: decision.decidedBy?.category ?? "",
        person: person.id,
        reason: decision.reason,
      };
      if (decision.row > 0) entry.row = decision.row - 1;
      if (decision.decidedBy?.subject === EVERYONE) entry.everyone = true;
      rows.push(entry);
    }
  }
  return [...owners, ...seats, ...rows];
};
