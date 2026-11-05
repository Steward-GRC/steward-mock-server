// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The directory: the signed-in user, the admin console's people, roles, platform groups,
// sessions, deletion and merging, and diagnostics. The people are the core's sign-in records, so
// disabling, deleting or changing roles here changes who can sign in and what they may do.

import { createHash } from "node:crypto";

import type { Membership, StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { endSessions, mockState } from "#core/state.ts";
import { authorScopes } from "#product/access.ts";
import { product } from "#product/product.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  people,
  record,
  refuse,
  siteAdmin,
} from "#product/resolvers/shared.ts";

const firstAndLast = (name: string) => {
  const [first = "", ...rest] = name.split(" ");
  return { firstName: first, lastName: rest.join(" ") };
};

/**
 * steward-authz's role grants, as steward-web mirrors them (packages/auth/src/catalog.ts).
 * Reader is implicit: everyone who can sign in may read.
 */
const ALL_PERMISSIONS = [
  "admin.manage",
  "audit.read",
  "compliance.manage",
  "group.manage",
  "policy.approve",
  "policy.author",
  "policy.read",
  "policy.read_sensitive",
  "reporting.manage",
  "session.manage",
  "settings.manage",
  "template.manage",
  "user.manage",
];
const ROLE_GRANTS: Record<string, readonly string[]> = {
  approver: ["policy.read", "policy.approve"],
  author: ["policy.read", "policy.author"],
  "compliance-admin": ["policy.read", "compliance.manage", "audit.read"],
  "privacy-officer": ["policy.read", "reporting.manage"],
  "site-admin": ALL_PERMISSIONS,
  "template-admin": ["policy.read", "template.manage"],
};

/** The roles grantRole accepts. */
const ROLES = new Set(Object.keys(ROLE_GRANTS));

/** The permissions a set of roles grants, reader's included, in grant order. */
export const permissionsOf = (roles: readonly string[]): string[] => [
  ...new Set([
    "policy.read",
    ...roles.flatMap((role) => ROLE_GRANTS[role] ?? []),
  ]),
];

const approverScopes = (person: StewardPerson): string[] =>
  data()
    .categories.filter(
      (c) => c.owners.includes(person.id) || c.approverRule.includes(person.id),
    )
    .map((c) => c.name);

const isRoot = (person: StewardPerson) =>
  person.id === mockState.data.people[0]?.id;

/** A person as the gateway's User type. */
export const asUser = (person: StewardPerson) => ({
  ...firstAndLast(person.name),
  deletedAt: person.deletedAt,
  email: person.email,
  enabled: !person.disabled,
  groupIds: person.memberships.map((m) => m.groupId),
  idpGroups: person.idpGroups,
  isRoot: isRoot(person),
  localAccount: person.localAccount,
  locale: person.locale,
  managedGroupIds: person.managedGroupIds,
  memberships: person.memberships,
  mergedIntoUserId: person.mergedIntoUserId,
  name: person.name,
  needsOnboarding: false,
  permissions: permissionsOf(person.roles),
  policyOverrides: [],
  roles: person.roles,
  scopes: { approver: approverScopes(person), author: authorScopes(person) },
  userId: person.id,
  username: person.username,
});

/** Audit a change to a person's account. */
const audit = (action: string, actor: StewardPerson, person: StewardPerson) =>
  record(action, actor, { id: person.id, kind: "user", label: person.name });

const personFor = (userId: string): StewardPerson =>
  found(
    people().find((p) => p.id === userId),
    "user",
  );

const groupFor = (groupId: string) =>
  found(
    data().platformGroups.find((g) => g.id === groupId),
    "group",
  );

/** A site admin, or a local manager of the group (identity's group-manager check). */
const managerOf = (context: Context, groupId: string): StewardPerson => {
  const person = caller(context);
  if (isSiteAdmin(person) || person.managedGroupIds.includes(groupId))
    return person;
  throw forbidden();
};

const matches = (person: StewardPerson, needle: string) =>
  [person.email, person.name, person.username].some((field) =>
    field.toLowerCase().includes(needle),
  );

/** A session the core holds, as the admin console lists it. Its id is never the cookie value. */
const liveSessions = (userId: string) =>
  [...mockState.sessions.values()]
    .filter((s) => s.personId === userId)
    .map((s) => ({
      active: true,
      authenticatedAt: new Date(s.startedAt).toISOString(),
      clientIp: null,
      expiresAt: new Date(s.startedAt + 8 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date(s.startedAt).toISOString(),
      lastSeenAt: null,
      sessionId: `live-${createHash("sha256").update(s.id).digest("hex").slice(0, 12)}`,
      userAgent: "Unknown",
      userId,
    }));

/** End every session a person has, live and past, and say how many were active. */
const revokeAll = (userId: string): number => {
  const past = data().pastSessions.filter(
    (s) => s.userId === userId && s.active,
  );
  for (const session of past) session.active = false;
  const live = liveSessions(userId).length;
  endSessions(userId);
  return past.length + live;
};

const pendingSeats = (userId: string) =>
  data().runs.flatMap((run) =>
    run.status === "APPROVAL_STATUS_IN_REVIEW"
      ? run.stages.flatMap((stage) =>
          stage.seats
            .filter((s) => s.userId === userId && s.state === "pending")
            .map((s) => ({ run, seat: s })),
        )
      : [],
  );

const titleOf = (policyId: string) =>
  data().policies.find((p) => p.id === policyId)?.title ?? policyId;

const deletionPreview = (person: StewardPerson) => {
  const owned = data().policies.filter((p) => p.ownerUserId === person.id);
  const pending = pendingSeats(person.id);
  const items = [
    ...owned.map((p) => ({
      blocksDelete: true,
      detail: "Reassign this policy to another owner first.",
      kind: "OWNED_POLICY",
      label: p.title,
      refId: p.id,
    })),
    ...pending.map(({ run, seat }) => ({
      blocksDelete: true,
      detail: `Awaiting ${person.name}'s approval.`,
      kind: "PENDING_APPROVAL",
      label: titleOf(run.policyId),
      refId: seat.taskId,
    })),
  ];
  return {
    blocksDelete: isRoot(person) || items.length > 0,
    counts: {
      breakGlassGrants: data().breakGlass.filter((g) => g.userId === person.id)
        .length,
      groupMemberships: person.memberships.length,
      idpGroups: person.idpGroups.length,
      managedGroups: person.managedGroupIds.length,
      ownedPolicies: owned.length,
      pendingApprovals: pending.length,
      permissions: permissionsOf(person.roles).length,
      policyOverrides: 0,
      raciGrants: data().categories.filter(
        (c) =>
          c.authorRule.includes(person.id) ||
          c.approverRule.includes(person.id),
      ).length,
      roles: person.roles.length,
    },
    items,
    locallyAuthenticable: person.localAccount,
    userId: person.id,
    warnings: isRoot(person)
      ? [
          {
            code: "ROOT_PROTECTED",
            message: "The root site admin can't be deleted.",
          },
        ]
      : [],
  };
};

const mergeCounts = (source: StewardPerson) => ({
  acknowledgmentsDeduped: 0,
  acknowledgmentsMoved: data().acknowledgements.filter(
    (a) => a.userId === source.id,
  ).length,
  policiesOwned: data().policies.filter((p) => p.ownerUserId === source.id)
    .length,
  preferences: 0,
  raciGrants: 0,
  workflowItems: pendingSeats(source.id).length,
});

const mergePreview = (source: StewardPerson, target: StewardPerson) => ({
  counts: mergeCounts(source),
  items: data()
    .policies.filter((p) => p.ownerUserId === source.id)
    .map((p) => ({
      detail: `Ownership moves to ${target.name}.`,
      kind: "POLICY_OWNER",
      label: p.title,
      refId: p.id,
    })),
  requiresPrivilegedConfirm: source.roles.length > 0,
  sourceUserId: source.id,
  targetUserId: target.id,
  warnings: [],
});

export const userResolvers: Resolvers = {
  Mutation: {
    addUserToGroup: (
      _root,
      given: { groupId: string; userId: string },
      context: Context,
    ) => {
      const actor = managerOf(context, given.groupId);
      groupFor(given.groupId);
      const person = personFor(given.userId);
      if (!person.memberships.some((m) => m.groupId === given.groupId))
        person.memberships.push({ groupId: given.groupId, source: "manual" });
      audit("group.member_added", actor, person);
      return asUser(person);
    },
    createPlatformGroup: (
      _root,
      given: { name: string; parentId?: null | string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const name = given.name.trim();
      if (!name)
        throw refuse("BAD_USER_INPUT", "A platform group needs a name.");
      if (given.parentId) groupFor(given.parentId);
      const group = {
        id: newId("group"),
        name,
        parentId: given.parentId ?? null,
      };
      data().platformGroups.push(group);
      record("group.created", actor, {
        id: group.id,
        kind: "group",
        label: name,
      });
      return group;
    },
    deleteUser: (_root, given: { userId: string }, context: Context) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      if (deletionPreview(person).blocksDelete)
        throw refuse(
          "FAILED_PRECONDITION",
          "This user still owns policies or approvals; reassign them first.",
        );
      person.deletedAt = new Date().toISOString();
      person.disabled = true;
      audit("user.deleted", actor, person);
      return { revokedSessions: revokeAll(person.id), userId: person.id };
    },
    disableUser: (_root, given: { userId: string }, context: Context) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      if (isRoot(person))
        throw refuse(
          "FAILED_PRECONDITION",
          "The root site admin can't be disabled.",
        );
      person.disabled = true;
      endSessions(person.id);
      audit("user.disabled", actor, person);
      return asUser(person);
    },
    enableUser: (_root, given: { userId: string }, context: Context) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      person.disabled = false;
      audit("user.enabled", actor, person);
      return asUser(person);
    },
    grantRole: (
      _root,
      given: { role: string; userId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      if (!ROLES.has(given.role))
        throw refuse("BAD_USER_INPUT", `There is no role ${given.role}.`);
      const person = personFor(given.userId);
      if (!person.roles.includes(given.role)) person.roles.push(given.role);
      audit("role.granted", actor, person);
      return asUser(person);
    },
    mergeAccounts: (
      _root,
      given: {
        confirmPrivileged?: boolean | null;
        sourceUserId: string;
        targetUserId: string;
      },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const source = personFor(given.sourceUserId);
      const target = personFor(given.targetUserId);
      if (source.id === target.id)
        throw refuse("BAD_USER_INPUT", "Pick two different accounts.");
      const preview = mergePreview(source, target);
      if (preview.requiresPrivilegedConfirm && !given.confirmPrivileged)
        throw refuse(
          "FAILED_PRECONDITION",
          "The source account holds roles; confirm the privileged merge.",
        );
      for (const policy of data().policies)
        if (policy.ownerUserId === source.id) policy.ownerUserId = target.id;
      for (const ack of data().acknowledgements)
        if (ack.userId === source.id) ack.userId = target.id;
      source.deletedAt = new Date().toISOString();
      source.disabled = true;
      source.mergedIntoUserId = target.id;
      revokeAll(source.id);
      audit("user.merged", actor, source);
      return {
        counts: preview.counts,
        mergeOperationId: newId("merge"),
        status: "COMPLETED",
        steps: ["policies", "acknowledgments", "tombstone"].map((step) => ({
          detail: "",
          error: "",
          status: "COMPLETED",
          step,
        })),
      };
    },
    removeUserFromGroup: (
      _root,
      given: { groupId: string; userId: string },
      context: Context,
    ) => {
      const actor = managerOf(context, given.groupId);
      const person = personFor(given.userId);
      const membership = person.memberships.find(
        (m: Membership) => m.groupId === given.groupId,
      );
      if (membership?.source === "idp-sync" && !isSiteAdmin(actor))
        throw refuse(
          "FAILED_PRECONDITION",
          "A membership synced from the identity provider can't be removed here.",
        );
      person.memberships = person.memberships.filter(
        (m) => m.groupId !== given.groupId,
      );
      audit("group.member_removed", actor, person);
      return asUser(person);
    },
    revokeRole: (
      _root,
      given: { role: string; userId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      if (isRoot(person) && given.role === "site-admin")
        throw refuse(
          "FAILED_PRECONDITION",
          "The root site admin can't be demoted.",
        );
      person.roles = person.roles.filter((r) => r !== given.role);
      audit("role.revoked", actor, person);
      return asUser(person);
    },
    revokeUserSessions: (
      _root,
      given: { userId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      audit("session.revoked", actor, person);
      return revokeAll(person.id);
    },
    updateMyProfile: (
      _root,
      given: {
        firstName?: null | string;
        lastName?: null | string;
        locale?: null | string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const current = firstAndLast(person.name);
      const first = (given.firstName ?? current.firstName).trim();
      const last = (given.lastName ?? current.lastName).trim();
      person.name = [first, last].filter(Boolean).join(" ") || person.name;
      if (given.locale) person.locale = given.locale;
      audit("user.profile_updated", person, person);
      return asUser(person);
    },
    updateUserProfile: (
      _root,
      given: { email: string; name: string; userId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      if (!given.name.trim() || !given.email.includes("@"))
        throw refuse(
          "BAD_USER_INPUT",
          "A name and an email address are needed.",
        );
      person.name = given.name.trim();
      person.email = given.email.trim().toLowerCase();
      audit("user.profile_updated", actor, person);
      return asUser(person);
    },
  },
  Query: {
    diagnostics: (_root, _given, context: Context) => {
      const person = caller(context);
      return {
        actor: {
          actingAs: null,
          id: person.id,
          roles: person.roles,
          username: person.username,
        },
        appliance: null,
        gateway: {
          commit: null,
          name: "gateway",
          status: "OK",
          version: product.version,
        },
        generatedAt: new Date().toISOString(),
        release: null,
        services: [
          {
            commit: null,
            name: "core",
            status: "OK",
            version: product.version,
          },
          { commit: null, name: "ai", status: "UNAVAILABLE", version: "" },
        ],
        thirdParty: [],
        traceId: newId("trace"),
      };
    },
    listUserSessions: (_root, given: { userId: string }, context: Context) => {
      siteAdmin(context);
      const person = personFor(given.userId);
      return [
        ...liveSessions(person.id),
        ...data().pastSessions.filter((s) => s.userId === person.id),
      ];
    },
    managedGroupMembers: (
      _root,
      given: { groupId: string },
      context: Context,
    ) => {
      managerOf(context, given.groupId);
      groupFor(given.groupId);
      return people()
        .filter((p) => p.memberships.some((m) => m.groupId === given.groupId))
        .map((p) => asUser(p));
    },
    me: (_root, _given, context: Context) => asUser(caller(context)),
    myManagedGroups: (_root, _given, context: Context) => {
      const person = caller(context);
      return data()
        .platformGroups.filter((g) => person.managedGroupIds.includes(g.id))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    },
    platformGroups: (
      _root,
      given: { parentId?: null | string },
      context: Context,
    ) => {
      siteAdmin(context);
      return data().platformGroups.filter(
        (g) => g.parentId === (given.parentId ?? null),
      );
    },
    previewAccountMerge: (
      _root,
      given: { sourceUserId: string; targetUserId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      return mergePreview(
        personFor(given.sourceUserId),
        personFor(given.targetUserId),
      );
    },
    previewUserDeletion: (
      _root,
      given: { userId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      return deletionPreview(personFor(given.userId));
    },
    searchUsers: (
      _root,
      given: { limit?: null | number; query: string },
      context: Context,
    ) => {
      caller(context);
      const needle = given.query.trim().toLowerCase();
      return people()
        .filter((p) => !p.deletedAt && p.email.toLowerCase().includes(needle))
        .slice(0, given.limit ?? 20)
        .map((p) => ({ email: p.email, id: p.id, name: p.name }));
    },
    users: (
      _root,
      given: { includeDeleted?: boolean | null; search?: null | string },
      context: Context,
    ) => {
      siteAdmin(context);
      const needle = given.search?.trim().toLowerCase();
      return {
        nextPageToken: "",
        users: people()
          .filter((p) => given.includeDeleted || !p.deletedAt)
          .filter((p) => !needle || matches(p, needle))
          .map((p) => asUser(p)),
      };
    },
  },
};
