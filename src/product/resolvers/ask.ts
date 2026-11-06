// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Ask on the mock. Real AI is tested on the appliance only; this simulates its answer so the Ask
// page can be walked against the mock. The answer is built from the published sections of the
// policies the caller may read (the same read rules as searchPolicies: a policy hidden from them,
// or shown to them obfuscated, is never drawn on), quotes the opening of the best matching
// sections, and cites each one, with a segment over the quoted text as steward-ai marks them.

import type { StewardPerson } from "#product/data/people.ts";
import type { Policy } from "#product/data/policies.ts";

import { policyView, readEffect, visible } from "#product/access.ts";
import { termsOf } from "#product/resolvers/search.ts";
import { data } from "#product/resolvers/shared.ts";
import { extractSections } from "#product/sections.ts";

/** How many sections an answer draws on, at most. */
const MAX_SOURCES = 3;
/** How much of a section an answer quotes, cut at a word. */
const QUOTE_LENGTH = 220;
const NOTE = "Simulated answer, not from a real AI. ";
const NOTHING =
  "I couldn't find anything in the documents you can read that answers that.";

/** Words that say nothing about which section answers the question. */
const STOP = new Set(
  (
    "a am an and any are as at be been by can could did do does for from had has have how i if in " +
    "is it its me my of on or our should so than that the their then there these they this to " +
    "us was we were what when where which who whom why will with would you your may must"
  ).split(" "),
);

interface Source {
  policy: Policy;
  quote: string;
  score: number;
  sectionKey: string;
  versionId: string;
  versionNo: number;
}

/** A term's root, so "expenses" finds "expense" and the other way round. */
const rootOf = (term: string): string =>
  term.length > 4 ? term.replace(/(?:ies|es|s)$/, "") : term;

const mentions = (text: string, roots: string[]): number => {
  const lower = text.toLowerCase();
  return roots.filter((root) =>
    new RegExp(String.raw`(?<![\p{L}\p{N}])${root}`, "u").test(lower),
  ).length;
};

/** The section's opening as a quote: its body without the heading line, cut at a word. */
const quoteOf = (text: string): string => {
  const [, ...body] = text.split("\n");
  const flat = (body.length > 0 ? body : [text]).join(" ").trim();
  if (flat.length <= QUOTE_LENGTH) return flat;
  const cut = flat.lastIndexOf(" ", QUOTE_LENGTH);
  return `${flat.slice(0, cut > 0 ? cut : QUOTE_LENGTH)}…`;
};

const sourcesFor = (person: StewardPerson, question: string): Source[] => {
  const roots = termsOf(question)
    .filter((term) => term.length > 2 && !STOP.has(term))
    .map((term) => rootOf(term));
  if (roots.length === 0) return [];
  const needed = Math.min(2, roots.length);
  const found: Source[] = [];
  for (const policy of data().policies) {
    if (policy.retiredAt !== null || !visible(person, policy)) continue;
    if (readEffect(person, policy) !== "allow") continue;
    const version = data().versions.find(
      (v) => v.id === policy.currentPublishedVersionId,
    );
    if (!version) continue;
    for (const section of extractSections(version.contentJson)) {
      const score = mentions(
        `${policy.title} ${policy.number} ${section.text}`,
        roots,
      );
      if (score < needed || section.text.trim() === "") continue;
      found.push({
        policy,
        quote: quoteOf(section.text),
        score,
        sectionKey: section.key,
        versionId: version.id,
        versionNo: version.versionNo,
      });
    }
  }
  return found
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.policy.number.localeCompare(b.policy.number) ||
        a.sectionKey.localeCompare(b.sectionKey),
    )
    .slice(0, MAX_SOURCES);
};

/** The simulated searchAndAnswer result for what `person` may read. */
export const simulatedAnswer = (person: StewardPerson, question: string) => {
  data().askedQuestions.push(question.trim());
  const sources = sourcesFor(person, question);
  if (sources.length === 0)
    return {
      answer: NOTHING,
      citations: [],
      hasSensitiveSource: false,
      noAuthorizedSource: true,
      segments: [],
    };
  let answer = NOTE;
  const segments = sources.map((source, index) => {
    if (index > 0) answer += "\n\n";
    const start = answer.length;
    answer += `${source.policy.title} (${source.policy.number}): ${source.quote}`;
    return {
      end: answer.length,
      sources: [
        {
          chunkId: `${source.versionId}:${source.sectionKey}`,
          chunkIndex: index,
          policyId: source.policy.id,
          sectionKey: source.sectionKey,
          versionId: source.versionId,
        },
      ],
      start,
    };
  });
  return {
    answer,
    citations: sources.map((source, index) => ({
      chunkId: `${source.versionId}:${source.sectionKey}`,
      chunkIndex: index,
      documentType: policyView(person, source.policy).documentType,
      policyId: source.policy.id,
      policyTitle: source.policy.title,
      sectionKey: source.sectionKey,
      versionId: source.versionId,
      versionNo: source.versionNo,
    })),
    hasSensitiveSource: sources.some(
      (source) => source.policy.sensitivity === "SENSITIVE",
    ),
    noAuthorizedSource: false,
    segments,
  };
};

/** The questions asked, most asked first (the latest first among equals), at most `limit`. */
export const topQuestions = (limit: number): string[] => {
  const counts = new Map<string, { at: number; count: number; text: string }>();
  for (const [at, text] of data().askedQuestions.entries()) {
    const key = text.toLowerCase();
    const seen = counts.get(key);
    counts.set(key, { at, count: (seen?.count ?? 0) + 1, text });
  }
  return [...counts.values()]
    .toSorted((a, b) => b.count - a.count || b.at - a.at)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.text);
};
