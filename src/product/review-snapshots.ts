// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What each approver last reviewed. The version stays In review while the author edits it, so every
// approver is shown the diff since the text they last reviewed, not since the published version.
// The snapshot is taken the first time it is needed (at submission for a run the mock starts) and
// moves forward when the approver acts: a comment, a reply, a vote, sending comments, or marking
// the version reviewed.

import type { PolicyVersion } from "#product/data/policies.ts";

import { scrambled } from "#product/access.ts";
import { stewardData } from "#product/data.ts";
import {
  diffVersions,
  parseContent,
  type SectionDiff,
} from "#product/sections.ts";

export interface ReviewSnapshot {
  at: string;
  contentJson: string;
}

/** A section diff as the gateway serves it: an obfuscated reader gets no word diff. */
export type ServedSectionDiff = {
  wordDiffHtml: null | string;
} & Omit<SectionDiff, "wordDiffHtml">;

const snapshots = () => stewardData().reviewSnapshots;

/** The text the approver last reviewed; the current text when they have not been shown any yet. */
export const snapshotOf = (
  userId: string,
  version: PolicyVersion,
): ReviewSnapshot => {
  const byUser = (snapshots()[version.id] ??= {});
  return (byUser[userId] ??= {
    at: new Date().toISOString(),
    contentJson: version.contentJson,
  });
};

/** The approver has reviewed the version as it is now. */
export const markReviewed = (userId: string, version: PolicyVersion) => {
  const byUser = (snapshots()[version.id] ??= {});
  byUser[userId] = {
    at: new Date().toISOString(),
    contentJson: version.contentJson,
  };
};

const titleOf = (key: string) => {
  const spaced = key.replaceAll("-", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * What changed in each section since the approver last reviewed. As the gateway does, sections that
 * did not change are left out, so nothing changed is an empty list. Sections come from the version's
 * pinned template; a version with none is read by the sections its text has, so a draft saved
 * without a template version can still be compared. A reader who sees the policy obfuscated gets
 * the gateway's obfuscateSectionDiffs: no word diffs and a scrambled title. The snapshot and the
 * diff always use the real text.
 */
export const changesSinceReview = (
  userId: string,
  version: PolicyVersion,
  obscured = false,
): ServedSectionDiff[] => {
  const before = snapshotOf(userId, version).contentJson;
  const template = stewardData().templateVersions.find(
    (t) => t.id === version.templateVersionId,
  );
  const defs = template
    ? template.sections.toSorted((a, b) => a.order - b.order)
    : [
        ...new Set([
          ...(parseContent(before)?.keys() ?? []),
          ...(parseContent(version.contentJson)?.keys() ?? []),
        ]),
      ].map((key) => ({ key, title: titleOf(key) }));
  return (diffVersions(before, version.contentJson, defs, false) ?? [])
    .filter((diff) => diff.changeType !== "unchanged")
    .map((diff) =>
      obscured
        ? {
            ...diff,
            sectionTitle: scrambled(diff.sectionTitle),
            wordDiffHtml: null,
          }
        : diff,
    );
};
