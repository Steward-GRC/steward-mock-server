// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Semantic versions and change types, as steward-core keeps them (steward-core#117). Pure rules
// with no state: the change type a version suggests against the one before it, the author's pick
// (raise freely, lower only with a reason and the first stage's agreement), the type a publish
// settles on, and the MAJOR.MINOR.FIX bump. resolvers read and write the state around these
// (version-numbers.ts).

import type { Section } from "#product/data/library.ts";

import { parseContent } from "#product/sections.ts";

/** The change-type record of one policy version (core's ChangeState). */
export interface ChangeState {
  /** The approvers who agreed to a lowering; filled when the first stage's quorum completes. */
  agreedBy: string[];
  reason: string;
  /** A lowering the author asked for that is still waiting for agreement. */
  requested: ChangeType | null;
  /** The user who picked a type; null when nobody did and the suggestion stands. */
  setBy: null | string;
  suggested: ChangeType;
  /** What the version publishes as. */
  type: ChangeType;
}

export type ChangeType = "FIX" | "MAJOR" | "MINOR";

export interface Classification {
  reasons: string[];
  type: ChangeType;
}

/** One side of a comparison: the stored content and the template version it is pinned to. */
export interface Revision {
  contentJson: string;
  /** null for a freeform document. */
  template: { sections: Section[]; templateId: string } | null;
}

export interface Semver {
  fix: number;
  major: number;
  minor: number;
}

/** The most words a change may add or drop and still be a Fix (core's FixWordLimit). */
export const FIX_WORD_LIMIT = 10;

export const REASON_REQUIRED =
  "a reason is required to set the change type below the suggested one";

const RANK: Record<ChangeType, number> = { FIX: 1, MAJOR: 3, MINOR: 2 };

export const rank = (type: ChangeType): number => RANK[type];

export const maxType = (a: ChangeType, b: ChangeType): ChangeType =>
  rank(a) >= rank(b) ? a : b;

export const isChangeType = (value: unknown): value is ChangeType =>
  typeof value === "string" && ["FIX", "MAJOR", "MINOR"].includes(value);

export const semverText = (v: Semver): string =>
  `${String(v.major)}.${String(v.minor)}.${String(v.fix)}`;

/** The next number after `previous` for a change type; the first version is 1.0.0. */
export const bump = (previous: null | Semver, type: ChangeType): Semver => {
  if (!previous) return { fix: 0, major: 1, minor: 0 };
  if (type === "MAJOR") return { fix: 0, major: previous.major + 1, minor: 0 };
  if (type === "MINOR")
    return { fix: 0, major: previous.major, minor: previous.minor + 1 };
  return { ...previous, fix: previous.fix + 1 };
};

const raise = (c: Classification, type: ChangeType, reason: string): void => {
  if (rank(type) > rank(c.type)) c.type = type;
  c.reasons.push(reason);
};

/**
 * core's obligationWords: the words that carry an obligation, a permission or a deadline. A change
 * that adds or drops one changes what readers must do.
 */
const OBLIGATION_WORDS = new Set(
  (
    "must shall may should required requires prohibited mandatory not never cannot no within " +
    "immediately deadline annually quarterly monthly weekly daily hourly day days week weeks " +
    "month months year years hour hours january february march april june july august " +
    "september october november december"
  ).split(" "),
);

/** A number or date, an amount, or a word that sets an obligation or a deadline. */
export const isObligationWord = (word: string): boolean => {
  if (/[$€£%]/.test(word) || /\p{Nd}/u.test(word)) return true;
  const bare = word
    .toLowerCase()
    .replace(/^[^\p{L}\p{Nd}]+/u, "")
    .replace(/[^\p{L}\p{Nd}]+$/u, "");
  return OBLIGATION_WORDS.has(bare);
};

/** The words an LCS diff of two texts adds or drops. */
export const changedWords = (before: string, after: string): string[] => {
  const left = before.split(/\s+/).filter(Boolean);
  const right = after.split(/\s+/).filter(Boolean);
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  const at = (row: number, column: number) => table[row]?.[column] ?? 0;
  for (let row = 1; row <= left.length; row++)
    for (let column = 1; column <= right.length; column++)
      (table[row] as number[])[column] =
        left[row - 1] === right[column - 1]
          ? at(row - 1, column - 1) + 1
          : Math.max(at(row - 1, column), at(row, column - 1));
  const out: string[] = [];
  let row = left.length;
  let column = right.length;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0 && left[row - 1] === right[column - 1]) {
      row--;
      column--;
    } else if (
      column > 0 &&
      (row === 0 || at(row, column - 1) >= at(row - 1, column))
    ) {
      out.push(right[column - 1] ?? "");
      column--;
    } else {
      out.push(left[row - 1] ?? "");
      row--;
    }
  }
  return out;
};

const requiredKeys = (sections: Section[]) =>
  new Set(sections.filter((s) => s.required).map((s) => s.key));

const boilerplateOf = (section: Section): string =>
  section.blocks
    .filter((b) => b.type.toLowerCase() === "boilerplate")
    .map((b) => b.contentJson ?? "")
    .join("\n");

/**
 * core's classifySections: a required section added, dropped or turned required is MAJOR; any
 * other section added or dropped, or changed boilerplate text, is MINOR. A retitle, a reorder or
 * a new heading level alone changes nothing.
 */
const classifySections = (
  c: Classification,
  from: Section[],
  to: Section[],
): void => {
  const fromKeys = new Set(from.map((s) => s.key));
  const toKeys = new Set(to.map((s) => s.key));
  const fromRequired = requiredKeys(from);
  const toRequired = requiredKeys(to);
  for (const key of toKeys) {
    if (!fromKeys.has(key) && toRequired.has(key))
      raise(c, "MAJOR", `required section added: ${key}`);
    else if (!fromKeys.has(key))
      raise(c, "MINOR", `optional section added: ${key}`);
    else if (toRequired.has(key) && !fromRequired.has(key))
      raise(c, "MAJOR", `section turned required: ${key}`);
  }
  for (const key of fromKeys) {
    if (!toKeys.has(key) && fromRequired.has(key))
      raise(c, "MAJOR", `required section removed: ${key}`);
    else if (!toKeys.has(key))
      raise(c, "MINOR", `optional section removed: ${key}`);
    else if (fromRequired.has(key) && !toRequired.has(key))
      raise(c, "MINOR", `section no longer required: ${key}`);
  }
  const before = new Map(from.map((s) => [s.key, boilerplateOf(s)]));
  for (const section of to) {
    const old = before.get(section.key);
    if (old !== undefined && old !== boilerplateOf(section))
      raise(c, "MINOR", `boilerplate text changed: ${section.key}`);
  }
};

/** core's ClassifyTemplateChange: a template version against the published one before it. */
export const classifyTemplateChange = (
  from: Section[],
  to: Section[],
): Classification => {
  const c: Classification = { reasons: [], type: "FIX" };
  classifySections(c, from, to);
  return c;
};

/**
 * core's ClassifyPolicyChange: structure first (a different template, or a switch between a
 * template and freeform, is MAJOR; a required section added or dropped is MAJOR and an optional
 * one MINOR), then the text (a changed number, date, amount or obligation word is MAJOR; a
 * section filled or emptied, or more than ten changed words, is MINOR; anything smaller is a
 * FIX). Content that cannot be read is MAJOR, the cautious side.
 */
export const classifyPolicyChange = (
  from: Revision,
  to: Revision,
): Classification => {
  const c: Classification = { reasons: [], type: "FIX" };
  if ((from.template === null) !== (to.template === null))
    raise(c, "MAJOR", "template added or removed");
  else if (
    from.template &&
    to.template &&
    from.template.templateId !== to.template.templateId
  )
    raise(c, "MAJOR", "a different template");
  else if (from.template && to.template)
    classifySections(c, from.template.sections, to.template.sections);

  const before = parseContent(from.contentJson);
  if (!before) {
    raise(c, "MAJOR", "the earlier content could not be read");
    return c;
  }
  const after = parseContent(to.contentJson);
  if (!after) {
    raise(c, "MAJOR", "the new content could not be read");
    return c;
  }
  const required = new Set<string>();
  for (const side of [from.template, to.template])
    if (side) for (const key of requiredKeys(side.sections)) required.add(key);

  let words = 0;
  let obligation = "";
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key) ?? "";
    const next = after.get(key) ?? "";
    if (old === next) continue;
    if (old === "")
      raise(
        c,
        required.has(key) ? "MAJOR" : "MINOR",
        `${required.has(key) ? "required section" : "section"} filled: ${key}`,
      );
    else if (next === "")
      raise(
        c,
        required.has(key) ? "MAJOR" : "MINOR",
        `${required.has(key) ? "required section" : "section"} emptied: ${key}`,
      );
    for (const word of changedWords(old, next)) {
      words++;
      if (obligation === "" && isObligationWord(word)) obligation = word;
    }
  }
  if (obligation)
    raise(
      c,
      "MAJOR",
      `the wording changes an obligation, date, number or amount (${obligation})`,
    );
  if (words > FIX_WORD_LIMIT)
    raise(c, "MINOR", `${String(words)} words changed`);
  return c;
};

export const initialState = (suggested: ChangeType): ChangeState => ({
  agreedBy: [],
  reason: "",
  requested: null,
  setBy: null,
  suggested,
  type: suggested,
});

/**
 * core's ResolveChange, the state after a submit against a fresh suggestion. `pick` is the
 * author's choice, or null to leave things as they were (a pending request or a standing pick
 * carries over; with neither the suggestion applies). A pick at or above the suggestion takes
 * effect at once. A pick below it needs a reason and is kept as a request, with the type staying
 * at the suggestion until the first stage agrees. An agreement already recorded for the same pick
 * survives while the suggestion is unchanged. Returns null when the reason is missing.
 */
export const resolveChange = (
  previous: ChangeState | null,
  suggested: ChangeType,
  pick: ChangeType | null,
  reasonGiven: string,
  actor: string,
): ChangeState | null => {
  let choice = pick;
  let setBy = actor;
  let reason = reasonGiven.trim();
  if (choice === null) {
    if (previous?.requested) choice = previous.requested;
    else if (previous?.setBy) choice = previous.type;
    else return initialState(suggested);
    setBy = previous.setBy ?? actor;
    if (reason === "") reason = previous.reason;
  }
  if (rank(choice) >= rank(suggested))
    return {
      agreedBy: [],
      reason,
      requested: null,
      setBy,
      suggested,
      type: choice,
    };
  if (reason === "") return null;
  if (
    previous &&
    previous.agreedBy.length > 0 &&
    previous.type === choice &&
    previous.suggested === suggested
  )
    return { ...previous };
  return {
    agreedBy: [],
    reason,
    requested: choice,
    setBy,
    suggested,
    type: suggested,
  };
};

/** core's RecordAgreement: the pending lowering applies, and who agreed is kept. */
export const recordAgreement = (
  state: ChangeState,
  agreedBy: string[],
): ChangeState | null =>
  state.requested && agreedBy.length > 0
    ? { ...state, agreedBy, requested: null, type: state.requested }
    : null;

/**
 * core's FinalizeChange: the type a version publishes as, given a fresh classification of its
 * content, which may have been edited since submit. Nobody picked: the fresh suggestion. A pick
 * stands but can only be raised by the fresh suggestion, never lowered by it. A recorded
 * agreement keeps its lowered type only while the content is no bigger a change than what the
 * approvers agreed to. A request still waiting for agreement does not count.
 */
export const finalizeChange = (
  state: ChangeState | null,
  fresh: ChangeType,
): ChangeType => {
  if (!state?.setBy) return fresh;
  if (state.agreedBy.length > 0 && rank(fresh) <= rank(state.suggested))
    return state.type;
  return maxType(state.type, fresh);
};
