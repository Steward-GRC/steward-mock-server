// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Who may read, edit and approve a policy, the way steward-gateway decides it (resolvePolicyReadModel,
// viewerCanFor, authorizeEffectiveAuthor). Rights come from each category's RACI rules and owners,
// inherited down the category chain, not from the global author or approver role:
// - everyone may read, except a SENSITIVE policy, which needs the read-sensitive claim or
//   ownership; a site admin without either reads it obfuscated and may break glass instead;
// - the policy's owner, a site admin, a category owner or a category author rule may edit
//   and submit;
// - a category approve rule or a category owner may approve;
// - a draft is only theirs: the draft pointer is cleared for anyone who can't edit, and a policy
//   that was never published is hidden from them.

import type { Category } from "#product/data/library.ts";
import type { StewardPerson } from "#product/data/people.ts";
import type { Policy, PolicyVersion } from "#product/data/policies.ts";

import { mockState } from "#core/state.ts";

const data = () => mockState.data;

const isSiteAdmin = (person: StewardPerson) =>
  person.roles.includes("site-admin");

/** A category and its ancestors, leaf first. */
export const chainOf = (categoryId: string): Category[] => {
  const chain: Category[] = [];
  let at = data().categories.find((c) => c.id === categoryId);
  while (at && chain.length <= data().categories.length) {
    chain.push(at);
    const parentId = at.parentId;
    at = parentId
      ? data().categories.find((c) => c.id === parentId)
      : undefined;
  }
  return chain;
};

/** May `person` author in this category (authorizeCategoryAuthor)? */
export const canAuthorIn = (
  person: StewardPerson,
  categoryId: string,
): boolean =>
  isSiteAdmin(person) ||
  chainOf(categoryId).some(
    (c) => c.owners.includes(person.id) || c.authorRule.includes(person.id),
  );

const canApproveIn = (person: StewardPerson, categoryId: string): boolean =>
  chainOf(categoryId).some(
    (c) => c.owners.includes(person.id) || c.approverRule.includes(person.id),
  );

/** The effective author of a policy (authorizeEffectiveAuthor). */
export const canEdit = (person: StewardPerson, policy: Policy): boolean =>
  policy.ownerUserId === person.id ||
  canAuthorIn(person, policy.homeCategoryId);

/** Category names the person may author in, for `me.scopes.author`. */
export const authorScopes = (person: StewardPerson): string[] =>
  data()
    .categories.filter(
      (c) => c.owners.includes(person.id) || c.authorRule.includes(person.id),
    )
    .map((c) => c.name);

const breakGlassActive = (person: StewardPerson, policy: Policy): boolean =>
  data().breakGlass.some(
    (g) =>
      g.userId === person.id &&
      g.policyNumber === policy.number &&
      g.until > Date.now(),
  );

export type ReadEffect = "allow" | "deny" | "obfuscate";

/** The read decision on a policy's content. */
export const readEffect = (
  person: StewardPerson,
  policy: Policy,
): ReadEffect => {
  if (policy.sensitivity !== "SENSITIVE") return "allow";
  if (person.readSensitive || policy.ownerUserId === person.id) return "allow";
  if (isSiteAdmin(person))
    return breakGlassActive(person, policy) ? "allow" : "obfuscate";
  return "deny";
};

const ackTriggersOf = (policy: Policy): string =>
  policy.ackTriggers ??
  chainOf(policy.homeCategoryId).find((c) => c.ackTriggers !== "NONE")
    ?.ackTriggers ??
  "NONE";

export interface ViewerCan {
  ack: boolean;
  approve: boolean;
  canBreakGlass: boolean;
  contentObfuscated: boolean;
  edit: boolean;
  read: boolean;
  submit: boolean;
}

export const viewerCan = (person: StewardPerson, policy: Policy): ViewerCan => {
  const effect = readEffect(person, policy);
  const edit = effect !== "deny" && canEdit(person, policy);
  const audience = policy.ackAudienceOverride;
  return {
    ack:
      effect !== "deny" &&
      policy.documentType === "POLICY" &&
      ackTriggersOf(policy) !== "NONE" &&
      (audience === null || audience.includes(person.id)),
    approve: effect !== "deny" && canApproveIn(person, policy.homeCategoryId),
    canBreakGlass: effect === "obfuscate",
    contentObfuscated: effect === "obfuscate",
    edit,
    read: effect !== "deny",
    submit: edit,
  };
};

const versionById = (id: null | string) =>
  id ? data().versions.find((v) => v.id === id) : undefined;

/** Is the policy in the person's read model at all? */
export const visible = (person: StewardPerson, policy: Policy): boolean => {
  if (readEffect(person, policy) === "deny") return false;
  return policy.currentPublishedVersionId !== null || canEdit(person, policy);
};

/** A policy as the gateway's Policy type, for one viewer. */
export const policyView = (person: StewardPerson, policy: Policy) => {
  const can = viewerCan(person, policy);
  const draftId = can.edit ? policy.currentDraftVersionId : null;
  const current =
    versionById(policy.currentPublishedVersionId) ?? versionById(draftId);
  const owner = data().people.find((p) => p.id === policy.ownerUserId);

  return {
    ...policy,
    currentDraftVersionId: draftId,
    currentVersionNo: current ? current.versionNo : null,
    currentVersionStatus: current ? current.status : null,
    ownerName: owner?.name ?? null,
    templateUpdateAvailable: false,
    viewerCan: can,
  };
};

/** Content with every word's letters scrambled, as an obfuscated read serves it. */
export const obfuscated = (contentJson: string): string => {
  const walk = (value: unknown, hide: boolean): unknown => {
    if (typeof value === "string")
      return hide ? value.replaceAll(/[\p{L}\p{N}]/gu, "x") : value;
    if (Array.isArray(value)) return value.map((inner) => walk(inner, hide));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [
          key,
          walk(inner, hide || key === "text" || key === "title"),
        ]),
      );
    return value;
  };
  try {
    return JSON.stringify(walk(JSON.parse(contentJson), false));
  } catch {
    return "";
  }
};

/** A version as `person` may read it, or undefined when it's hidden from them. */
export const readableVersion = (
  person: StewardPerson,
  version: PolicyVersion,
): PolicyVersion | undefined => {
  const policy = data().policies.find((p) => p.id === version.policyId);
  if (!policy) return undefined;
  const effect = readEffect(person, policy);
  if (effect === "deny") return undefined;
  if (version.publishedAt === null && !canEdit(person, policy))
    return undefined;
  if (effect === "allow") return version;
  return {
    ...version,
    appendices: version.appendices.map((a) => ({
      ...a,
      contentJson: obfuscated(a.contentJson),
    })),
    contentJson: obfuscated(version.contentJson),
  };
};
