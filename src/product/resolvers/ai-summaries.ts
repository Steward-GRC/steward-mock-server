// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The summary jobs on the mock (steward-gateway#191): summarizeChanges and
// regenerateVersionSummary. This is the gateway's read side: the caller must read the version(s)
// with their real content (an unreadable version, or a draft the caller cannot read, is
// NotFound; an obfuscated read is PermissionDenied, so nothing obfuscated is ever "sent" to the
// AI), versions with no differences or a version with no text are FailedPrecondition. Whether AI
// is on is the caller's concern (resolvers/ai.ts). There is no author-only rule. The job result
// is the JSON the gateway documents:
//   {"scope":"changes","bullets":[...],"generatedAt":"RFC3339","cached":bool}
//   {"scope":"version","summaryText":"- ...","generatedAt":"RFC3339","cached":bool}
// The text is made up from the real diff or text and says it is simulated. cached is true when a
// summarizeChanges repeat finds the same pair and diff already summarised (and regenerate is not
// set); regenerateVersionSummary always makes a new one, so it is always false.

import type { StewardPerson } from "#product/data/people.ts";
import type { PolicyVersion } from "#product/data/policies.ts";

import { readEffect } from "#product/access.ts";
import { diff, readable } from "#product/resolvers/policies.ts";
import {
  data,
  forbidden,
  found,
  now,
  refuse,
} from "#product/resolvers/shared.ts";
import { parseContent } from "#product/sections.ts";

const NOTE = "Simulated, not from a real AI. ";
const SNIPPET = 90;

/** What a summary submit decided: the job's result, and the store to update once it is accepted. */
export interface Summary {
  remember: () => void;
  result: Record<string, unknown>;
}

/** The version, readable in full: NotFound when not readable at all, PermissionDenied when obfuscated. */
const readInFull = (person: StewardPerson, id: string): PolicyVersion => {
  const version = readable(person, id);
  const policy = found(
    data().policies.find((p) => p.id === version.policyId),
    "policy",
  );
  if (readEffect(person, policy) !== "allow") throw forbidden();
  return version;
};

const snippet = (text: string) =>
  text.length > SNIPPET ? `${text.slice(0, SNIPPET).trimEnd()}...` : text;

/** summarizeChanges: bullets for each changed section between two versions. */
export const summarizeChanges = (
  person: StewardPerson,
  given: {
    fromVersionId: string;
    regenerate?: boolean | null;
    toVersionId: string;
  },
): Summary => {
  const from = readInFull(person, given.fromVersionId);
  const to = readInFull(person, given.toVersionId);
  const changed = diff(from, to, false).filter(
    (d) => d.changeType !== "unchanged" && d.wordDiffHtml !== null,
  );
  if (changed.length === 0)
    throw refuse(
      "FAILED_PRECONDITION",
      "the versions have no differences to summarise",
    );
  const bullets = changed.map(
    (d) => `${NOTE}${d.sectionTitle} was ${d.changeType}.`,
  );
  // The pair and what differs between them: the same request finds the stored summary.
  const key = `changes:${from.id}:${to.id}:${changed
    .map((d) => `${d.sectionKey}=${d.wordDiffHtml}`)
    .join("|")}`;
  const cached = !given.regenerate && data().aiSummaries.includes(key);
  return {
    remember: () => {
      if (!data().aiSummaries.includes(key)) data().aiSummaries.push(key);
    },
    result: { bullets, cached, generatedAt: now(), scope: "changes" },
  };
};

/** regenerateVersionSummary: a bulleted summary of one version's text, never from the store. */
export const regenerateVersionSummary = (
  person: StewardPerson,
  given: { versionId: string },
): Summary => {
  const version = readInFull(person, given.versionId);
  const titles = new Map(
    (
      data().templateVersions.find((t) => t.id === version.templateVersionId)
        ?.sections ?? []
    ).map((s) => [s.key, s.title]),
  );
  const lines = [...(parseContent(version.contentJson) ?? new Map())]
    .filter(([, text]) => text.trim() !== "")
    .map(
      ([key, text]) => `- ${titles.get(key) ?? key}: ${snippet(text.trim())}`,
    );
  if (lines.length === 0)
    throw refuse("FAILED_PRECONDITION", "the version has no text to summarise");
  return {
    remember: () => {
      const key = `version:${version.id}`;
      if (!data().aiSummaries.includes(key)) data().aiSummaries.push(key);
    },
    result: {
      cached: false,
      generatedAt: now(),
      scope: "version",
      summaryText: `- ${NOTE.trim()}\n${lines.join("\n")}`,
    },
  };
};
