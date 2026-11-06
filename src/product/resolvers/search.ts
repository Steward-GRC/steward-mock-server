// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// searchPolicies, ahead of steward-gateway (schema-pending.graphql, steward-gateway#41): whole-word,
// case-insensitive matching over each policy's title, number and published text. Every word of
// the query must match somewhere. The reader's read rules hold: a policy the viewer can't read
// never appears, and a viewer whose content is obfuscated matches on title and number only and
// gets no snippet, so search can't reveal hidden text one guess at a time. Drafts, superseded
// versions and retired policies never match.

import type { StewardPerson } from "#product/data/people.ts";
import type { Policy, PolicyVersion } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { policyView, readEffect, visible } from "#product/access.ts";
import { caller, data, refuse } from "#product/resolvers/shared.ts";

const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
/** How long a snippet runs before it's cut to a window around its first match. */
const SNIPPET_LENGTH = 160;
/** How much of the passage a cut snippet keeps before its first match. */
const SNIPPET_LEAD = 40;
const TOKEN_PREFIX = "search:";

interface Span {
  length: number;
  start: number;
}

/** The query's words, lower-cased, with punctuation trimmed from their ends. */
export const termsOf = (text: string): string[] => [
  ...new Set(
    text
      .split(/\s+/)
      .map((word) =>
        word.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase(),
      )
      .filter(Boolean),
  ),
];

/** Where `term` appears in `text` as a whole word, ignoring case. */
const spansOf = (text: string, term: string): Span[] => {
  const escaped = term.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])${escaped}(?![\p{L}\p{N}])`,
    "giu",
  );
  return [...text.matchAll(pattern)].map((m) => ({
    length: m[0].length,
    start: m.index,
  }));
};

/** Every string under a "text" key: a section's text, or a Lexical text node. */
const textsOf = (contentJson: string): string[] => {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const inner of value) walk(inner);
    else if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value))
        if (key === "text" && typeof inner === "string") found.push(inner);
        else walk(inner);
  };
  try {
    walk(JSON.parse(contentJson));
  } catch {
    // Content that doesn't parse has no text to search.
  }
  return found.filter((text) => text.trim() !== "");
};

/** The published version's passages: its sections, then its appendices. */
const passagesOf = (version: PolicyVersion): string[] => [
  ...textsOf(version.contentJson),
  ...version.appendices.flatMap((a) => textsOf(a.contentJson)),
];

/** The passage with the most matches, cut to a window around its first one when it's long. */
const snippetOf = (passages: string[], terms: string[]) => {
  let best: { spans: Span[]; text: string } | undefined;
  for (const text of passages) {
    const spans = terms
      .flatMap((term) => spansOf(text, term))
      .toSorted((a, b) => a.start - b.start);
    if (spans.length > (best?.spans.length ?? 0)) best = { spans, text };
  }
  if (!best) return null;
  const { spans, text } = best;
  if (text.length <= SNIPPET_LENGTH) return { matches: spans, text };

  const firstStart = spans[0]?.start ?? 0;
  let from = Math.max(0, firstStart - SNIPPET_LEAD);
  if (from > 0) from = text.indexOf(" ", from) + 1 || from;
  if (from > firstStart) from = firstStart;
  let to = Math.min(text.length, from + SNIPPET_LENGTH);
  const lastSpace = text.lastIndexOf(" ", to);
  if (to < text.length && lastSpace > firstStart) to = lastSpace;
  const lead = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  return {
    matches: spans
      .filter((s) => s.start >= from && s.start + s.length <= to)
      .map((s) => ({ ...s, start: s.start - from + lead.length })),
    text: `${lead}${text.slice(from, to).trim()}${tail}`,
  };
};

interface Scored {
  hit: {
    policy: ReturnType<typeof policyView>;
    rank: number;
    snippet: ReturnType<typeof snippetOf>;
  };
  title: string;
}

/** How `policy` matches the query for `person`, or undefined when it doesn't. */
const score = (
  person: StewardPerson,
  policy: Policy,
  terms: string[],
): Scored | undefined => {
  if (policy.retiredAt !== null || !visible(person, policy)) return undefined;
  const effect = readEffect(person, policy);
  if (effect === "deny") return undefined;
  const version = data().versions.find(
    (v) => v.id === policy.currentPublishedVersionId,
  );
  if (!version) return undefined;
  const passages = effect === "allow" ? passagesOf(version) : [];

  let head = false;
  let total = 0;
  for (const term of terms) {
    const inHead =
      spansOf(policy.title, term).length + spansOf(policy.number, term).length;
    const inBody = passages.reduce(
      (sum, text) => sum + spansOf(text, term).length,
      0,
    );
    if (inHead + inBody === 0) return undefined;
    head ||= inHead > 0;
    total += inHead + inBody;
  }
  return {
    hit: {
      policy: policyView(person, policy),
      // A title or number hit outranks any text-only hit; then more matches rank higher.
      rank: (head ? 1 : 0) + total / (total + 1),
      snippet: snippetOf(passages, terms),
    },
    title: policy.title,
  };
};

const offsetOf = (after: null | string | undefined): number => {
  if (!after) return 0;
  const decoded = Buffer.from(after, "base64url").toString("utf8");
  const offset = Number(decoded.slice(TOKEN_PREFIX.length));
  if (
    !decoded.startsWith(TOKEN_PREFIX) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw refuse("BAD_USER_INPUT", "The page token isn't one search gave.");
  return offset;
};

const tokenOf = (offset: number) =>
  Buffer.from(`${TOKEN_PREFIX}${offset}`).toString("base64url");

export const searchResolvers: Resolvers = {
  Query: {
    searchPolicies: (
      _root,
      given: {
        after?: null | string;
        documentType?: null | Policy["documentType"];
        first?: null | number;
        query: string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const first = given.first ?? DEFAULT_PAGE;
      if (first < 1)
        throw refuse("BAD_USER_INPUT", "Ask for at least one result.");
      const size = Math.min(first, MAX_PAGE);
      const offset = offsetOf(given.after);
      const terms = termsOf(given.query);
      if (terms.length === 0) return { hits: [], nextPageToken: "" };

      const ranked = data()
        .policies.filter(
          (p) => !given.documentType || p.documentType === given.documentType,
        )
        .flatMap((p) => score(person, p, terms) ?? [])
        .toSorted(
          (a, b) => b.hit.rank - a.hit.rank || a.title.localeCompare(b.title),
        );
      const next = offset + size;
      return {
        hits: ranked.slice(offset, next).map((s) => s.hit),
        nextPageToken: next < ranked.length ? tokenOf(next) : "",
      };
    },
  },
};
