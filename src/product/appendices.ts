// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The appendix store (the approved appendix model). An appendix belongs to a policy or procedure,
// never to one of its versions, and is never moved to another document. Each has a version table
// of its own: at most one DRAFT (what the author is writing) beside the PUBLISHED history, and
// readers see the latest published one. Retiring keeps an appendix (and its history) and hides it;
// only a site admin deletes one for good. Letters follow the order of the live appendices.

import type { Appendix, PolicyVersion } from "#product/data/policies.ts";

export type AppendixState = "DRAFT" | "PUBLISHED";

/** One row of an appendix's version table. */
export interface AppendixVersionRow {
  contentJson: string;
  createdAt: string;
  createdBy: string;
  id: string;
  publishedAt: null | string;
  publishedBy: null | string;
  state: AppendixState;
  title: string;
  updatedAt: string;
  updatedBy: string;
  versionNo: number;
}

/** An appendix of a policy or procedure, with its version table. */
export interface PolicyAppendix {
  createdAt: string;
  createdBy: string;
  id: string;
  orderIndex: number;
  policyId: string;
  retiredAt: null | string;
  retiredBy: null | string;
  versions: AppendixVersionRow[];
}

/** The letter of an appendix is its place among the live ones: A, B, C. */
export const letterOf = (index: number): string =>
  String.fromCodePoint(65 + index);

/** An appendix's published rows, oldest first. */
export const publishedRows = (appendix: PolicyAppendix): AppendixVersionRow[] =>
  appendix.versions.filter((v) => v.state === "PUBLISHED");

export const latestPublished = (
  appendix: PolicyAppendix,
): AppendixVersionRow | undefined => publishedRows(appendix).at(-1);

export const draftOf = (
  appendix: PolicyAppendix,
): AppendixVersionRow | undefined =>
  appendix.versions.find((v) => v.state === "DRAFT");

/** A policy's live (not retired) appendices in order. */
export const liveAppendices = (
  all: readonly PolicyAppendix[],
  policyId: string,
): PolicyAppendix[] =>
  all
    .filter((a) => a.policyId === policyId && a.retiredAt === null)
    .toSorted((a, b) => a.orderIndex - b.orderIndex);

/** Every appendix of a policy, retired ones last. */
export const appendicesOf = (
  all: readonly PolicyAppendix[],
  policyId: string,
): PolicyAppendix[] =>
  all
    .filter((a) => a.policyId === policyId)
    .toSorted(
      (a, b) =>
        Number(a.retiredAt !== null) - Number(b.retiredAt !== null) ||
        a.orderIndex - b.orderIndex,
    );

/** Renumbers the live appendices of a policy 0, 1, 2 in their current order. */
export const renumber = (
  all: readonly PolicyAppendix[],
  policyId: string,
): void => {
  for (const [index, appendix] of liveAppendices(all, policyId).entries())
    appendix.orderIndex = index;
};

/** The letter an appendix shows, or null while it is retired. */
export const letterFor = (
  all: readonly PolicyAppendix[],
  appendix: PolicyAppendix,
): null | string =>
  appendix.retiredAt === null
    ? letterOf(liveAppendices(all, appendix.policyId).indexOf(appendix))
    : null;

/**
 * What a policy version carries as `appendices`: the latest published row of each live appendix of
 * its policy, whichever version is asked (every version shows the latest published appendices).
 */
export const publishedFor = (
  all: readonly PolicyAppendix[],
  version: Pick<PolicyVersion, "id" | "policyId">,
): Appendix[] =>
  liveAppendices(all, version.policyId).flatMap((appendix, index) => {
    const row = latestPublished(appendix);
    return row
      ? [
          {
            contentJson: row.contentJson,
            id: appendix.id,
            letter: letterOf(index),
            orderIndex: index,
            policyVersionId: version.id,
            title: row.title,
          },
        ]
      : [];
  });

/**
 * The seed's migration: appendices were once rows on a version. Each distinct appendix of a policy
 * becomes one of the policy's (taken from its newest version that has them), published when that
 * version was, a draft when it never was. The versions then carry none.
 */
export const migrateAppendices = (
  versions: PolicyVersion[],
  actor = "user-bob",
): PolicyAppendix[] => {
  const result: PolicyAppendix[] = [];
  const byPolicy = Map.groupBy(versions, (v) => v.policyId);
  for (const [policyId, own] of byPolicy) {
    const source = own
      .filter((v) => v.appendices.length > 0)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (!source) continue;
    const published = source.publishedAt !== null;
    for (const [index, appendix] of source.appendices.entries()) {
      const at = source.publishedAt ?? source.createdAt;
      result.push({
        createdAt: source.createdAt,
        createdBy: actor,
        id: appendix.id,
        orderIndex: index,
        policyId,
        retiredAt: null,
        retiredBy: null,
        versions: [
          {
            contentJson: appendix.contentJson,
            createdAt: source.createdAt,
            createdBy: actor,
            id: `${appendix.id}-v1`,
            publishedAt: published ? at : null,
            publishedBy: published ? actor : null,
            state: published ? "PUBLISHED" : "DRAFT",
            title: appendix.title,
            updatedAt: at,
            updatedBy: actor,
            versionNo: 1,
          },
        ],
      });
    }
  }
  for (const policyId of byPolicy.keys())
    syncAppendices(result, versions, policyId);
  return result;
};

/**
 * Gives every version of a policy the policy's latest published appendices as its `appendices`,
 * which is what the clients read. The appendices are the policy's, so this is a view, kept up to
 * date after every change and for each new version.
 */
export const syncAppendices = (
  all: readonly PolicyAppendix[],
  versions: readonly PolicyVersion[],
  policyId: string,
): void => {
  for (const version of versions)
    if (version.policyId === policyId)
      version.appendices = publishedFor(all, version);
};
