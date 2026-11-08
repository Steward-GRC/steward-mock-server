// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What a policy version links to from the libraries (see links.ts and the pending schema):
// definitions (alphabetical), related items (with a relationship type and its inverse),
// references and contacts (in the author's order). The links belong to the version and can change
// only while it is editable.

import type { StewardPerson } from "#product/data/people.ts";
import type { Policy, PolicyVersion } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { canEdit, visible } from "#product/access.ts";
import {
  byTitle,
  copyOf,
  EDITABLE,
  emptyLinks,
  relationshipType,
  relationshipTypes,
  usedByPolicies,
  type VersionLinks,
} from "#product/links.ts";
import { readable } from "#product/resolvers/policies.ts";
import {
  caller,
  data,
  forbidden,
  found,
  notFound,
  refuse,
} from "#product/resolvers/shared.ts";

const policyOf = (id: string): Policy =>
  found(
    data().policies.find((p) => p.id === id),
    "policy",
  );

const used = (pick: (links: VersionLinks) => string[], id: string) =>
  usedByPolicies(data().links, data().policies, pick, id);

/** The stored links of a version (none yet reads as empty). */
const storedLinks = (versionId: string): VersionLinks =>
  data().links[versionId] ?? emptyLinks();

/** The links as the person reads them: entries resolved, ordered, and the other side's links in. */
const view = (person: StewardPerson, version: PolicyVersion) => {
  const policy = policyOf(version.policyId);
  const links = storedLinks(version.id);
  const outgoing = links.related.flatMap((item) => {
    const target = data().policies.find((p) => p.id === item.policyId);
    const type = relationshipType(item.type);
    return target && type && visible(person, target)
      ? [
          {
            direction: "OUTGOING",
            label: type.label,
            number: target.number,
            policyId: target.id,
            title: target.title,
            type: type.id,
          },
        ]
      : [];
  });
  // Another policy's published version that names this one reads from this side as the inverse.
  const incoming = data().policies.flatMap((other) => {
    if (other.id === policy.id || !visible(person, other)) return [];
    const published = other.currentPublishedVersionId;
    if (!published) return [];
    return storedLinks(published).related.flatMap((item) => {
      const type = relationshipType(item.type);
      const inverse = type && relationshipType(type.inverseId);
      return item.policyId === policy.id && inverse
        ? [
            {
              direction: "INCOMING",
              label: inverse.label,
              number: other.number,
              policyId: other.id,
              title: other.title,
              type: inverse.id,
            },
          ]
        : [];
    });
  });
  return {
    contacts: links.contactBlockIds.flatMap((id) => {
      const block = data().contactBlocks.find((b) => b.id === id);
      return block
        ? [{ ...block, usedByCount: used((l) => l.contactBlockIds, id) }]
        : [];
    }),
    definitions: links.definitionIds
      .flatMap((id) => {
        const entry = data().definitions.find((d) => d.id === id);
        return entry
          ? [{ ...entry, usedByCount: used((l) => l.definitionIds, id) }]
          : [];
      })
      .toSorted((a, b) => byTitle(a.term, b.term)),
    editable: EDITABLE.has(version.status) && canEdit(person, policy),
    policyVersionId: version.id,
    references: links.referenceIds.flatMap((id) => {
      const entry = data().references.find((r) => r.id === id);
      return entry
        ? [{ ...entry, usedByCount: used((l) => l.referenceIds, id) }]
        : [];
    }),
    related: [...outgoing, ...incoming],
  };
};

/** A version the person may change the links of: they author the policy and it is still editable. */
const editableVersion = (person: StewardPerson, id: string): PolicyVersion => {
  const version = readable(person, id);
  if (!canEdit(person, policyOf(version.policyId))) throw forbidden();
  if (!EDITABLE.has(version.status))
    throw refuse(
      "FAILED_PRECONDITION",
      "Links can only change while the version is a draft or in review.",
    );
  return version;
};

/** Each id once and each in the library, or the call is refused. */
const checkedIds = (
  ids: readonly string[],
  kind: string,
  exists: (id: string) => boolean,
): string[] => {
  if (new Set(ids).size !== ids.length)
    throw refuse("BAD_USER_INPUT", `Name each ${kind} only once.`);
  for (const id of ids) if (!exists(id)) throw notFound(kind);
  return [...ids];
};

const change = (
  context: Context,
  versionId: string,
  apply: (links: VersionLinks, person: StewardPerson) => void,
) => {
  const person = caller(context);
  const version = editableVersion(person, versionId);
  const links = copyOf(data().links[version.id]);
  apply(links, person);
  data().links[version.id] = links;
  policyOf(version.policyId).updatedAt = new Date().toISOString();
  return view(person, version);
};

export const linkResolvers: Resolvers = {
  Mutation: {
    setVersionContacts: (
      _root,
      given: { contactBlockIds: string[]; policyVersionId: string },
      context: Context,
    ) =>
      change(context, given.policyVersionId, (links) => {
        links.contactBlockIds = checkedIds(
          given.contactBlockIds,
          "contact block",
          (id) => data().contactBlocks.some((b) => b.id === id),
        );
      }),
    setVersionDefinitions: (
      _root,
      given: { definitionIds: string[]; policyVersionId: string },
      context: Context,
    ) =>
      change(context, given.policyVersionId, (links) => {
        links.definitionIds = checkedIds(
          given.definitionIds,
          "definition",
          (id) => data().definitions.some((d) => d.id === id),
        );
      }),
    setVersionReferences: (
      _root,
      given: { policyVersionId: string; referenceIds: string[] },
      context: Context,
    ) =>
      change(context, given.policyVersionId, (links) => {
        links.referenceIds = checkedIds(given.referenceIds, "reference", (id) =>
          data().references.some((r) => r.id === id),
        );
      }),
    setVersionRelated: (
      _root,
      given: {
        links: { policyId: string; type: string }[];
        policyVersionId: string;
      },
      context: Context,
    ) =>
      change(context, given.policyVersionId, (links, person) => {
        const own = editableVersion(person, given.policyVersionId).policyId;
        const seen = new Set<string>();
        for (const item of given.links) {
          if (!relationshipType(item.type))
            throw refuse("BAD_USER_INPUT", "That is not a relationship type.");
          if (item.policyId === own)
            throw refuse("BAD_USER_INPUT", "A policy can't relate to itself.");
          const target = data().policies.find((p) => p.id === item.policyId);
          if (!target || !visible(person, target)) throw notFound("policy");
          const key = `${item.policyId}|${item.type}`;
          if (seen.has(key))
            throw refuse("BAD_USER_INPUT", "Name each related item only once.");
          seen.add(key);
        }
        links.related = given.links.map((item) => ({
          policyId: item.policyId,
          type: item.type,
        }));
      }),
  },
  Query: {
    policyVersionLinks: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      return view(person, readable(person, given.policyVersionId));
    },
    relationshipTypes: (_root, _given: unknown, context: Context) => {
      caller(context);
      return relationshipTypes;
    },
  },
};
