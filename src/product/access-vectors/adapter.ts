// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Maps the shared access vectors (decide.json, the approved model) onto the mock's current rule
// model (category RACI rules, resolvers/raci.ts), and describes the differences. Pure: no server,
// no state. Report only; nothing here changes how the mock decides.
//
// The old model, against the approved one:
//  - Subjects: USER (a person id), GROUP (an IdP group name, matched case-insensitively) and
//    EVERYONE. There is no role subject, so `role:` entries cannot match anyone.
//  - Actions: read, ack, approve, author as four cells per rule. No `manage`, no implications
//    declared in data. The resolver adds its own: an allowed author or approve confers read, and
//    read gates author and approve ("requires read").
//  - Order: rules are walked top-down, target category first and then each ancestor; for each
//    action the first rule with a non-blank cell that matches decides, whatever its effect. So the
//    first match wins, where the approved model lets a deny beat an allow in the same category.
//  - Chain: no stopInheriting flag, no "*" last stop, a depth cap of 16, unknown category is an
//    error (NOT_FOUND) where the approved model default-denies.
//  - Owners read, approve and author anywhere in their chain; the adapter gives no category owners.
//
// Mapping assumptions (the adapter makes these, so a difference is not a mapping mistake):
//  A1. A vector category id is a mock category (id and name), its `parents` entry is parentId.
//  A2. `user:<id>` becomes a USER rule on that id; `group:<g>` a GROUP rule named g. The person is
//      a mock person with that id and those groups. Their roles are not given to the mock.
//  A3. An entry sets every cell in the closure of its action under `implies` (author sets author
//      and read; manage sets author, approve and read) to its effect, so one entry means what the
//      approved model says it means. Entries on actions that are not read, author, approve or
//      manage have no cell and are dropped: in the approved model they can only answer a question
//      about that same action, which is never asked of a representable case.
//  A4. Within a category the deny entries are written first, then the allow entries, each in their
//      given order, so the mock's first match comes as close as it can to "deny beats allow". The
//      report also runs each case with the rows in the given order, as a sensitivity check: the
//      cases whose verdict changes show where the mock's first-match order matters.
//  A5. Entries naming a role the person does not hold are dropped (inert in both models).
//  A6. A category the vector never names (not in `categories`, not in `parents`) is, in the
//      approved model, simply one with no entries and no parent, so the adapter creates it empty and
//      asks it. The mock itself answers NOT_FOUND for a category that does not exist, a behavioural
//      gap this report does not count.
//  A7. Answers are compared on allowed. The mock's `reason` is compared softly (see REPORT.md).
//  A8. When "*" itself is asked, it is an ordinary category with its own entries and parents.
//
// UNREPRESENTABLE (the old model cannot express the case, so asking it would not test its rules):
//  U1. The asked action is manage or unknown: simulateCategory answers read, ack, approve, author.
//  U2. A `role:` entry the person holds could decide it: the old model has no role subject.
//  U3. A matching entry in "*" when another category is asked: there is no last stop.
//  U4. A stopInheriting category on the chain above which a matching entry exists: no such flag.

export interface Action {
  id: string;
  implies?: string[];
}

export interface Counts {
  differs: number;
  same: number;
  unrepresentable: number;
}

export interface Entry {
  action: string;
  effect: "allow" | "deny";
  subject: string;
}

export interface MockRule {
  ack: "ALLOW" | "BLANK" | "DENY";
  approve: "ALLOW" | "BLANK" | "DENY";
  author: "ALLOW" | "BLANK" | "DENY";
  read: "ALLOW" | "BLANK" | "DENY";
  subjectKind: "GROUP" | "USER";
  subjectRef: string;
}

export interface Outcome {
  /** The same case with the rows kept in the vectors' given order (sensitivity run). */
  given?: { allowed: boolean; reason: string } | { error: string };
  mapped: Plan;
  mock?: { allowed: boolean; reason: string } | { error: string };
  vector: VectorCase;
}

export type Plan =
  | {
      askedAction: "approve" | "author" | "read";
      askedCategory: string;
      categories: { id: string; parentId: null | string; rules: MockRule[] }[];
      kind: "map";
      person: { groups: string[]; id: string };
    }
  | { kind: "unrepresentable"; reason: string };

export interface VectorCase {
  action: string;
  category: string;
  expect: {
    allowed: boolean;
    decidedBy: {
      action: string;
      category: string;
      effect: string;
      subject: string;
    } | null;
    reason: "default-deny" | "entry";
  };
  name: string;
  person: { groups: string[]; id: string; roles: string[] };
  ruleSet: {
    categories: Record<string, { entries: Entry[]; stopInheriting?: boolean }>;
    parents: Record<string, string>;
  };
}

export interface Vectors {
  actions: Action[];
  cases: VectorCase[];
  version: number;
}

const KNOWN = ["read", "author", "approve"] as const;

const bad = (message: string): never => {
  throw new Error(`decide.json: ${message}`);
};
const is = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads and checks decide.json; throws a message naming what is wrong. */
export const parseVectors = (text: string): Vectors => {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("decide.json is not valid JSON");
  }
  if (!is(file) || file.version !== 1) return bad("version must be 1");
  if (!Array.isArray(file.actions)) return bad("actions must be a list");
  const actions = file.actions as Action[];
  for (const [index, action] of actions.entries())
    if (!is(action) || typeof action.id !== "string")
      bad(`action ${String(index)} has no id`);
  if (!Array.isArray(file.cases)) return bad("cases must be a list");
  const names = new Set<string>();
  for (const [index, raw] of (file.cases as unknown[]).entries()) {
    const at = `case ${String(index)}`;
    if (!is(raw) || typeof raw.name !== "string" || raw.name === "")
      bad(`${at} has no name`);
    const item = raw as Record<string, unknown>;
    const name = item.name as string;
    if (names.has(name)) bad(`repeated case name "${name}"`);
    names.add(name);
    const where = `${at} "${name}"`;
    if (typeof item.category !== "string") bad(`${where} has no category`);
    if (typeof item.action !== "string") bad(`${where} has no action`);
    const person = item.person;
    if (
      !is(person) ||
      typeof person.id !== "string" ||
      !Array.isArray(person.groups) ||
      !Array.isArray(person.roles)
    )
      bad(`${where} has a bad person`);
    const ruleSet = item.ruleSet;
    if (!is(ruleSet) || !is(ruleSet.categories) || !is(ruleSet.parents))
      bad(`${where} has a bad ruleSet`);
    const set = ruleSet as { categories: Record<string, unknown> };
    for (const [id, category] of Object.entries(set.categories)) {
      if (!is(category) || !Array.isArray(category.entries))
        bad(`${where} category ${id} has no entries list`);
      for (const entry of (category as { entries: unknown[] }).entries) {
        if (!is(entry)) bad(`${where} has an entry that is not an object`);
        const row = entry as Record<string, unknown>;
        if (
          typeof row.subject !== "string" ||
          !/^(user|group|role):./.test(row.subject)
        )
          bad(
            `${where} has a bad entry subject ${JSON.stringify(row.subject)}`,
          );
        if (row.effect !== "allow" && row.effect !== "deny")
          bad(`${where} has a bad entry effect ${JSON.stringify(row.effect)}`);
        if (typeof row.action !== "string")
          bad(`${where} has an entry without an action`);
      }
    }
    const expect = item.expect;
    if (
      !is(expect) ||
      typeof expect.allowed !== "boolean" ||
      (expect.reason !== "entry" && expect.reason !== "default-deny")
    )
      bad(`${where} has a bad expect`);
  }
  return file as unknown as Vectors;
};

/** The action and everything it implies, transitively and cycle safe. */
const closureOf = (action: string, actions: Action[]): Set<string> => {
  const seen = new Set<string>([action]);
  const todo = [action];
  while (todo.length > 0) {
    const current = todo.pop();
    const next = actions.find((a) => a.id === current);
    for (const implied of next?.implies ?? [])
      if (!seen.has(implied)) {
        seen.add(implied);
        todo.push(implied);
      }
  }
  return seen;
};

const subjectsOf = (person: VectorCase["person"]) => [
  `user:${person.id}`,
  ...person.groups.map((g) => `group:${g}`),
  ...person.roles.map((r) => `role:${r}`),
];

/** The question asked of the mock also needs read, which gates author and approve. */
const concerns = (entry: Entry, asked: string, actions: Action[]) => {
  const closure = closureOf(entry.action, actions);
  return closure.has(asked) || closure.has("read");
};

const chainOf = (vector: VectorCase): string[] => {
  const chain: string[] = [];
  for (
    let at: string | undefined = vector.category;
    at !== undefined && !chain.includes(at);
    at = vector.ruleSet.parents[at]
  )
    chain.push(at);
  return chain;
};

const ruleOf = (entry: Entry, actions: Action[]): MockRule | undefined => {
  const [kind, reference] = [
    entry.subject.slice(0, entry.subject.indexOf(":")),
    entry.subject.slice(entry.subject.indexOf(":") + 1),
  ];
  if (kind === "role") return undefined;
  const closure = closureOf(entry.action, actions);
  const grant = entry.effect === "allow" ? "ALLOW" : "DENY";
  const rule: MockRule = {
    ack: "BLANK",
    approve: "BLANK",
    author: "BLANK",
    read: "BLANK",
    subjectKind: kind === "user" ? "USER" : "GROUP",
    subjectRef: reference,
  };
  let any = false;
  for (const known of KNOWN)
    if (closure.has(known)) {
      rule[known] = grant;
      any = true;
    }
  return any ? rule : undefined;
};

/** Maps one case onto the mock's rules, or says why it cannot. */
export const plan = (
  vector: VectorCase,
  actions: Action[],
  denyFirst = true,
): Plan => {
  const { action: asked, person, ruleSet } = vector;
  if (!KNOWN.includes(asked as (typeof KNOWN)[number]))
    return {
      kind: "unrepresentable",
      reason:
        asked === "manage"
          ? "U1: simulateCategory has no manage question"
          : `U1: the mock has no action "${asked}"`,
    };
  const subjects = subjectsOf(person);
  const holds = (entry: Entry) => subjects.includes(entry.subject);
  const entriesOf = (id: string) => ruleSet.categories[id]?.entries ?? [];

  for (const [id, category] of Object.entries(ruleSet.categories))
    for (const entry of category.entries)
      if (
        entry.subject.startsWith("role:") &&
        holds(entry) &&
        concerns(entry, asked, actions)
      )
        return {
          kind: "unrepresentable",
          reason: `U2: ${id} has ${entry.subject} ${entry.effect} ${entry.action}; the mock has no role subject`,
        };

  if (vector.category !== "*")
    for (const entry of entriesOf("*"))
      if (holds(entry) && concerns(entry, asked, actions))
        return {
          kind: "unrepresentable",
          reason: `U3: "*" has ${entry.subject} ${entry.effect} ${entry.action}; the mock has no last stop`,
        };

  const chain = chainOf(vector);
  for (const [position, id] of chain.entries()) {
    if (ruleSet.categories[id]?.stopInheriting !== true) continue;
    const above = chain
      .slice(position + 1)
      .find((up) =>
        entriesOf(up).some(
          (candidate) =>
            holds(candidate) && concerns(candidate, asked, actions),
        ),
      );
    if (above !== undefined)
      return {
        kind: "unrepresentable",
        reason: `U4: ${id} stops inheriting above a matching entry in ${above}; the mock has no stopInheriting`,
      };
  }

  const ids = new Set<string>();
  const addId = (id: string) => {
    if (id !== "*" || vector.category === "*") ids.add(id);
  };
  addId(vector.category);
  for (const id of Object.keys(ruleSet.categories)) addId(id);
  for (const [child, parent] of Object.entries(ruleSet.parents)) {
    addId(child);
    addId(parent);
  }

  const categories = [...ids].map((id) => {
    const rows = (effect?: Entry["effect"]) =>
      entriesOf(id)
        .filter((entry) => effect === undefined || entry.effect === effect)
        .flatMap((entry) => ruleOf(entry, actions) ?? []);
    return {
      id,
      parentId: ruleSet.parents[id] ?? null,
      rules: denyFirst ? [...rows("deny"), ...rows("allow")] : rows(),
    };
  });
  return {
    askedAction: asked as (typeof KNOWN)[number],
    askedCategory: vector.category,
    categories,
    kind: "map",
    person: { groups: [...person.groups], id: person.id },
  };
};

export type Status = "differs" | "same" | "unrepresentable";

export const statusOf = (outcome: Outcome): Status => {
  if (outcome.mapped.kind === "unrepresentable") return "unrepresentable";
  const { mock } = outcome;
  if (!mock || "error" in mock) return "differs";
  return mock.allowed === outcome.vector.expect.allowed ? "same" : "differs";
};

export const summarise = (outcomes: Outcome[]): Counts => {
  const counts: Counts = { differs: 0, same: 0, unrepresentable: 0 };
  for (const outcome of outcomes) counts[statusOf(outcome)]++;
  return counts;
};

/** The deciding category the mock's reason names ("rule #1 ..." is the asked one). */
const mockCategory = (reason: string, asked: string): null | string => {
  if (/^rule #\d+/.test(reason)) return asked;
  const hop = /^↳ (.+) #\d+ (?:allow|deny)/.exec(reason);
  return hop?.[1] ?? null;
};

const expectedText = (vector: VectorCase) => {
  const { allowed, decidedBy } = vector.expect;
  const verdict = allowed ? "allow" : "deny";
  return decidedBy
    ? `${verdict} (${decidedBy.category}: ${decidedBy.effect} ${decidedBy.subject} ${decidedBy.action})`
    : `${verdict} (default deny)`;
};

const mockText = (outcome: Outcome) => {
  const { mock } = outcome;
  if (!mock) return "not asked";
  if ("error" in mock) return `error ${mock.error}`;
  return `${mock.allowed ? "allow" : "deny"} (${mock.reason})`;
};

/** Why a case differs, as a short class; the first that applies. */
export const reasonClass = (outcome: Outcome): string => {
  const { mapped, mock, vector } = outcome;
  if (mapped.kind === "unrepresentable") return mapped.reason.slice(0, 2);
  if (!mock) return "";
  if ("error" in mock)
    return "unknown category: the mock answers an error, the vectors default-deny";
  const sameVerdict = mock.allowed === vector.expect.allowed;
  if (sameVerdict) {
    const expectedAt = vector.expect.decidedBy?.category ?? null;
    const reasonDefault = mock.reason.startsWith("no rule");
    if (expectedAt === null && !reasonDefault)
      return "same verdict; reason: mock gives a different explanation";
    if (expectedAt !== null && reasonDefault)
      return "same verdict; reason: mock has no deciding rule";
    if (
      expectedAt !== null &&
      mockCategory(mock.reason, vector.category) !== null &&
      mockCategory(mock.reason, vector.category) !== expectedAt
    )
      return "same verdict; reason: decided in a different category";
    return "";
  }
  return classify(outcome);
};

const classify = (outcome: Outcome): string => {
  const { mapped, mock, vector } = outcome;
  if (mapped.kind !== "map" || !mock || "error" in mock) return "other";
  if (mock.reason === "requires read")
    return "read gate: the mock denies author or approve unless read is allowed";
  if (mock.reason.endsWith("implies read"))
    return "read implication: the mock confers read from an author or approve rule anywhere in the chain";
  const exact = new Set(
    [
      `user:${vector.person.id}`,
      ...vector.person.groups.map((g) => `group:${g}`),
    ].map((s) => s),
  );
  const folded = new Set([...exact].map((s) => s.toLowerCase()));
  for (const category of Object.values(vector.ruleSet.categories))
    for (const entry of category.entries)
      if (
        entry.subject.startsWith("group:") &&
        !exact.has(entry.subject) &&
        folded.has(entry.subject.toLowerCase())
      )
        return "group names: the mock matches them case-insensitively";
  for (const [id, category] of Object.entries(vector.ruleSet.categories)) {
    const matching = category.entries.filter((candidate) =>
      subjectsOf(vector.person).includes(candidate.subject),
    );
    if (
      matching.some((candidate) => candidate.effect === "allow") &&
      matching.some((candidate) => candidate.effect === "deny") &&
      id !== "*"
    )
      return "first match, not deny-wins: the mock lets the first non-blank rule decide";
  }
  return "chain: the mock decides per action over the whole chain, not at the nearest matching category";
};

const cell = (text: string) =>
  text.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");

export const renderReport = (outcomes: Outcome[], counts: Counts): string => {
  const lines: string[] = [
    "# Access vectors against the mock's current rules",
    "",
    "Generated by `npm run test:vectors-report` from `decide.json` (source in `VENDORED.md`). Report only: the mock's behaviour is not changed. Do not edit by hand.",
    "",
    "The mock is asked through its real `simulateCategory` resolution; the adapter and every mapping assumption (A1 to A7) and unrepresentable class (U1 to U4) are described at the top of `adapter.ts`.",
    "",
    "## Summary",
    "",
    "| Result | Cases |",
    "| --- | --- |",
    `| same | ${String(counts.same)} |`,
    `| differs | ${String(counts.differs)} |`,
    `| unrepresentable | ${String(counts.unrepresentable)} |`,
    `| total | ${String(outcomes.length)} |`,
    "",
  ];
  const byClass = new Map<string, number>();
  for (const outcome of outcomes) {
    const status = statusOf(outcome);
    if (status === "same") continue;
    const key =
      status === "unrepresentable"
        ? (outcome.mapped as { reason: string }).reason.slice(0, 2)
        : (reasonClass(outcome).split(":", 1)[0] ?? "");
    byClass.set(
      `${status}: ${key}`,
      (byClass.get(`${status}: ${key}`) ?? 0) + 1,
    );
  }
  lines.push("| Class | Cases |", "| --- | --- |");
  for (const [key, count] of [...byClass].toSorted((a, b) => b[1] - a[1]))
    lines.push(`| ${cell(key)} | ${String(count)} |`);
  lines.push(
    "",
    "## Read this with",
    "",
    "- `differs` counts verdict differences among the cases the old model can express after the A1 to A8 mapping; most of the gap is in the unrepresentable rows (no role subject, no `*` last stop, no stopInheriting, no manage).",
    "- Behaviour the vectors do not probe, so it is not counted: the mock answers NOT_FOUND for a category that does not exist (A6), matches group names case-insensitively (the vectors only probe the case of a `user:` id), gives category owners read, approve and author anywhere in their chain, and has an `ack` action and an EVERYONE subject.",
    "- The report is written beside the vendored vectors because `docs/` is git-ignored in this repo.",
    "",
  );
  const flipped = outcomes.filter(
    (o) =>
      o.given &&
      !("error" in o.given) &&
      o.given.allowed !== o.vector.expect.allowed,
  );
  lines.push(
    "## Sensitivity: rows in the vectors' given order",
    "",
    "Assumption A4 puts deny rows first. Keeping the rows as the vectors list them (the mock's first match decides) gives a different verdict from the expected one in these cases:",
    "",
    "| Case | Expected | Mock result (given order) | Reason class |",
    "| --- | --- | --- | --- |",
  );
  for (const o of flipped)
    lines.push(
      `| ${cell(o.vector.name)} | ${cell(expectedText(o.vector))} | ${cell(mockText({ ...o, mock: o.given }))} | first match, not deny-wins: the mock lets the first non-blank rule decide |`,
    );
  lines.push("");
  for (const [title, wanted] of [
    ["Differences", "differs"],
    ["Unrepresentable", "unrepresentable"],
    ["Same verdict", "same"],
  ] as const) {
    lines.push(
      `## ${title}`,
      "",
      "| Case | Expected | Mock result | Reason class |",
      "| --- | --- | --- | --- |",
    );
    for (const outcome of outcomes.filter((o) => statusOf(o) === wanted)) {
      const cls =
        wanted === "unrepresentable"
          ? (outcome.mapped as { reason: string }).reason
          : reasonClass(outcome);
      lines.push(
        `| ${cell(outcome.vector.name)} | ${cell(expectedText(outcome.vector))} | ${cell(wanted === "unrepresentable" ? "not asked" : mockText(outcome))} | ${cell(cls)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
};
