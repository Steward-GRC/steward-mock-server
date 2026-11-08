// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What a policy version links to from the libraries (bug log 227). The library items (definitions,
// references, contacts) are not versioned; the links are stored WITH the policy version, so they go
// through approval with it, stay as approved once it is published, and are copied into a new draft.
// A link can only change while the version is editable (a draft counts). Related items are other
// policies, each with a relationship type that has an inverse, so a link reads correctly from both
// sides ("is related to" here, "is related by" there).

import type {
  Policy,
  PolicyLinks,
  PolicyVersion,
} from "#product/data/policies.ts";

/** A relationship type and the type the other side of the link reads as. */
export interface RelationshipType {
  id: string;
  inverseId: string;
  inverseLabel: string;
  label: string;
}

/** The fixed list. Every type has an inverse and the inverse of the inverse is the type itself. */
const PAIRS: [string, string, string, string][] = [
  ["RELATED_TO", "is related to", "RELATED_BY", "is related by"],
  ["SUPERSEDES", "supersedes", "SUPERSEDED_BY", "is superseded by"],
  ["DEPENDS_ON", "depends on", "REQUIRED_BY", "is required by"],
  ["IMPLEMENTS", "implements", "IMPLEMENTED_BY", "is implemented by"],
  ["REFERENCES", "references", "REFERENCED_BY", "is referenced by"],
];

export const relationshipTypes: RelationshipType[] = PAIRS.flatMap(
  ([id, label, inverseId, inverseLabel]) => [
    { id, inverseId, inverseLabel, label },
    { id: inverseId, inverseId: id, inverseLabel: label, label: inverseLabel },
  ],
);

export const relationshipType = (id: string): RelationshipType | undefined =>
  relationshipTypes.find((t) => t.id === id);

/** The type a plain "related policy" link takes. */
export const DEFAULT_RELATIONSHIP = "RELATED_TO";

/** One related item: another policy and how this version relates to it. */
export interface RelatedItem {
  policyId: string;
  type: string;
}

/** The links of one policy version. References and contacts keep the author's order. */
export interface VersionLinks {
  contactBlockIds: string[];
  definitionIds: string[];
  referenceIds: string[];
  related: RelatedItem[];
}

/**
 * The version statuses whose links (and text) the author can still change: a draft, one in review
 * (the author keeps editing while approvers review it) and a withdrawn one. A rejected version is
 * final, a published or superseded one is as approved.
 */
export const EDITABLE = new Set(["DRAFT", "IN_REVIEW", "WITHDRAWN"]);

export const emptyLinks = (): VersionLinks => ({
  contactBlockIds: [],
  definitionIds: [],
  referenceIds: [],
  related: [],
});

/** A copy that shares nothing with the original. */
export const copyOf = (links: undefined | VersionLinks): VersionLinks => ({
  contactBlockIds: [...(links?.contactBlockIds ?? [])],
  definitionIds: [...(links?.definitionIds ?? [])],
  referenceIds: [...(links?.referenceIds ?? [])],
  related: (links?.related ?? []).map((r) => ({ ...r })),
});

/**
 * The seed's policy-level links, moved onto the policy's published version and its open draft:
 * they were once a policy's own, and now belong to the versions that carry them.
 */
export const migrateLinks = (
  seed: Record<string, PolicyLinks>,
  policies: readonly Policy[],
): Record<string, VersionLinks> => {
  const result: Record<string, VersionLinks> = {};
  for (const [policyId, links] of Object.entries(seed)) {
    const policy = policies.find((p) => p.id === policyId);
    if (!policy) continue;
    for (const versionId of [
      policy.currentPublishedVersionId,
      policy.currentDraftVersionId,
    ])
      if (versionId)
        result[versionId] = {
          contactBlockIds: [...links.contactBlockIds],
          definitionIds: [...links.definitionIds],
          referenceIds: [...links.referenceIds],
          related: links.relatedPolicyIds.map((policyId) => ({
            policyId,
            type: DEFAULT_RELATIONSHIP,
          })),
        };
  }
  return result;
};

/** The links a policy shows when no version is named: its published version, else its draft. */
export const currentVersionId = (policy: Policy): null | string =>
  policy.currentPublishedVersionId ?? policy.currentDraftVersionId;

/** The link sets that count as a policy's own use of the libraries: published and open draft. */
export const liveSets = (
  all: Record<string, VersionLinks>,
  policy: Policy,
): VersionLinks[] =>
  [policy.currentPublishedVersionId, policy.currentDraftVersionId].flatMap(
    (id) => (id && all[id] ? [all[id]] : []),
  );

/** How many policies link to a library item in a version that is published or still open. */
export const usedByPolicies = (
  all: Record<string, VersionLinks>,
  policies: readonly Policy[],
  pick: (links: VersionLinks) => string[],
  id: string,
): number =>
  policies.filter((p) => liveSets(all, p).some((l) => pick(l).includes(id)))
    .length;

/** Copies one version's links onto a new version (a new draft starts with them). */
export const carryOver = (
  all: Record<string, VersionLinks>,
  from: Pick<PolicyVersion, "id"> | undefined,
  to: Pick<PolicyVersion, "id">,
): void => {
  all[to.id] = copyOf(from ? all[from.id] : undefined);
};

/** Library titles sort the way a reader expects: case and accents aside. */
export const byTitle = (a: string, b: string): number =>
  a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b);
