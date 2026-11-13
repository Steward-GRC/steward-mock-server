// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The directory: the signed-in user, the admin console's people, roles, platform groups,
// sessions, deletion and merging, and diagnostics. The people are the core's sign-in records, so
// disabling, deleting or changing roles here changes who can sign in and what they may do.

import { GraphQLError } from "graphql";
import { createHash } from "node:crypto";

import type { AuditAction } from "#product/audit-actions.ts";
import type { Membership, StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { settings } from "#core/product.ts";
import { endSessions, mockState } from "#core/state.ts";
import { authorScopes } from "#product/access.ts";
import {
  idpGroupsOf,
  isRoot,
  joinGroup,
  leaveGroup,
  managedGroupIdsOf,
  membershipsOf,
  rolesOf,
} from "#product/groups.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  notFound,
  people,
  realCaller,
  record,
  refuse,
  siteAdmin,
  withAnyRole,
} from "#product/resolvers/shared.ts";

const firstAndLast = (name: string) => {
  const [first = "", ...rest] = name.split(" ");
  return { firstName: first, lastName: rest.join(" ") };
};

/**
 * The gateway's permission catalog, as steward-web mirrors it (packages/auth/src/catalog.ts).
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
export const ROLE_GRANTS: Record<string, readonly string[]> = {
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

/** A root admin; identity keeps exactly one, and transferRoot moves the seat. */
export { isRoot } from "#product/groups.ts";

/** A person as the gateway's User type. */
export const asUser = (person: StewardPerson) => ({
  ...firstAndLast(person.name),
  deletedAt: person.deletedAt,
  email: person.email,
  enabled: !person.disabled,
  groupIds: membershipsOf(person).map((m) => m.groupId),
  idpGroups: idpGroupsOf(person),
  isRoot: isRoot(person),
  localAccount: person.localAccount,
  locale: person.locale,
  managedGroupIds: managedGroupIdsOf(person),
  memberships: membershipsOf(person),
  mergedIntoUserId: person.mergedIntoUserId,
  name: person.name,
  needsOnboarding: person.needsOnboarding === true,
  permissions: permissionsOf(person.roles),
  policyOverrides: person.policyOverrides.toSorted((a, b) =>
    a.policyNumber.localeCompare(b.policyNumber),
  ),
  roles: rolesOf(person),
  scopes: { approver: approverScopes(person), author: authorScopes(person) },
  userId: person.id,
  username: person.username,
});

/** Audit a change to a person's account. */
const audit = (
  action: AuditAction,
  actor: StewardPerson,
  person: StewardPerson,
) => record(action, actor, { id: person.id, kind: "user", label: person.name });

const personFor = (userId: string): StewardPerson =>
  found(
    people().find((p) => p.id === userId),
    "user",
  );

/** gateway: language[-Script][-REGION], e.g. en, en-US, zh-Hant-TW, es-419. */
const LOCALE_TAG =
  /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?$/;

/** The locale as the gateway stores it: trimmed and cased, "" for blank, PROFILE_LOCALE_INVALID if malformed. */
const normalizedLocale = (input: string): string => {
  const tag = input.trim();
  if (!tag) return "";
  if (!LOCALE_TAG.test(tag))
    throw new GraphQLError("The language isn't a valid locale tag.", {
      extensions: {
        code: "PROFILE_LOCALE_INVALID",
        codeNum: 1241,
        domain: "gateway",
        kind: "business",
      },
    });
  return tag
    .split("-")
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 4)
        return part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase();
      return part.toUpperCase();
    })
    .join("-");
};

const groupFor = (groupId: string) =>
  found(
    data().platformGroups.find((g) => g.id === groupId),
    "group",
  );

/** A site admin, or a local manager of the group (identity's group-manager check). */
const managerOf = (context: Context, groupId: string): StewardPerson => {
  const person = caller(context);
  if (isSiteAdmin(person) || managedGroupIdsOf(person).includes(groupId))
    return person;
  throw forbidden();
};

/** The fewest characters the people typeahead searches on. */
const SEARCH_MIN = 2;

const matches = (person: StewardPerson, needle: string) =>
  [person.email, person.name, person.username].some((field) =>
    field.toLowerCase().includes(needle),
  );

/** A session the core holds, as the admin console lists it. Its id is never the cookie value. */
const liveSessions = (userId: string, currentSessionId?: string) =>
  [...mockState.sessions.values()]
    .filter((s) => s.personId === userId)
    .map((s) => ({
      active: true,
      authenticatedAt: new Date(s.startedAt).toISOString(),
      clientIp: null,
      current: s.id === currentSessionId,
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
      groupMemberships: membershipsOf(person).length,
      idpGroups: idpGroupsOf(person).length,
      managedGroups: managedGroupIdsOf(person).length,
      ownedPolicies: owned.length,
      pendingApprovals: pending.length,
      permissions: permissionsOf(person.roles).length,
      policyOverrides: person.policyOverrides.length,
      raciGrants: data().categories.filter(
        (c) =>
          c.authorRule.includes(person.id) ||
          c.approverRule.includes(person.id),
      ).length,
      roles: rolesOf(person).length,
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

/** Active sessions a person has now, live and past. */
const activeSessionCount = (userId: string) =>
  data().pastSessions.filter((s) => s.userId === userId && s.active).length +
  liveSessions(userId).length;

/** Categories that name the person: as an author or approver, an owner, or a user rule. */
const categoriesNaming = (userId: string) =>
  data().categories.filter(
    (c) =>
      c.authorRule.includes(userId) ||
      c.approverRule.includes(userId) ||
      c.owners.includes(userId) ||
      c.rules.some((r) => r.subjectKind === "USER" && r.subjectRef === userId),
  );

/**
 * What merging `source` INTO `target` would do, as steward-identity reports it: the source's
 * policies, category rules, acknowledgements (one the target already gave is counted once, as
 * deduped), pending approval seats and per-policy overrides go to the target; the source's roles
 * and groups do not.
 */
const mergePlan = (source: StewardPerson, target: StewardPerson) => {
  const targetVersions = new Set(
    data()
      .acknowledgements.filter((a) => a.userId === target.id)
      .map((a) => a.policyVersionId),
  );
  const acks = data().acknowledgements.filter((a) => a.userId === source.id);
  const deduped = acks.filter((a) => targetVersions.has(a.policyVersionId));
  const moved = acks.filter((a) => !targetVersions.has(a.policyVersionId));
  const policies = data().policies.filter((p) => p.ownerUserId === source.id);
  const categories = categoriesNaming(source.id);
  const seats = pendingSeats(source.id);
  const overrides = source.policyOverrides.filter(
    (o) =>
      !target.policyOverrides.some((t) => t.policyNumber === o.policyNumber),
  );
  const sessions = activeSessionCount(source.id);
  const warnings = [
    ...(source.roles.length > 0
      ? [
          {
            code: "ROLES_NOT_MOVED",
            message: `${source.name} holds ${source.roles.join(", ")}. Roles are not merged: grant what ${target.name} needs afterwards.`,
          },
        ]
      : []),
    ...(deduped.length > 0
      ? [
          {
            code: "ACKNOWLEDGMENTS_DEDUPED",
            message: `${String(deduped.length)} acknowledgement${deduped.length === 1 ? "" : "s"} both accounts gave count once.`,
          },
        ]
      : []),
    ...(sessions > 0
      ? [
          {
            code: "SESSIONS_ENDED",
            message: `${source.name} is signed in; their ${String(sessions)} session${sessions === 1 ? "" : "s"} end.`,
          },
        ]
      : []),
    ...(source.email.toLowerCase() === target.email.toLowerCase()
      ? []
      : [
          {
            code: "EMAIL_DIFFERS",
            message: `The emails differ (${source.email}, ${target.email}). Check they are one person.`,
          },
        ]),
  ];
  return {
    acks,
    categories,
    counts: {
      acknowledgmentsDeduped: deduped.length,
      acknowledgmentsMoved: moved.length,
      policiesOwned: policies.length,
      preferences: overrides.length,
      raciGrants: categories.length,
      workflowItems: seats.length,
    },
    deduped,
    items: [
      ...policies.map((p) => ({
        detail: `Ownership moves to ${target.name}.`,
        kind: "POLICY_OWNER",
        label: p.title,
        refId: p.id,
      })),
      ...categories.map((c) => ({
        detail: `${target.name} takes the place in ${c.name}'s rules.`,
        kind: "RACI_GRANT",
        label: c.name,
        refId: c.id,
      })),
      ...acks.map((a) => ({
        detail: targetVersions.has(a.policyVersionId)
          ? `${target.name} already gave it; it counts once.`
          : `Moves to ${target.name}.`,
        kind: "ACKNOWLEDGMENT",
        label: a.policyVersionId,
        refId: `${a.policyVersionId}:${a.userId}`,
      })),
      ...seats.map(({ run }) => ({
        detail: `The approval seat moves to ${target.name}.`,
        kind: "WORKFLOW_ITEM",
        label: run.id,
        refId: run.id,
      })),
      ...overrides.map((o) => ({
        detail: `${o.effect} on ${o.policyNumber} moves to ${target.name}.`,
        kind: "PREFERENCE",
        label: o.policyNumber,
        refId: o.policyNumber,
      })),
    ],
    moved,
    overrides,
    policies,
    // Closing a signed-in account, or one that holds roles, needs the admin's say-so.
    requiresPrivilegedConfirm: source.roles.length > 0 || sessions > 0,
    seats,
    sourceUserId: source.id,
    targetUserId: target.id,
    warnings,
  };
};

const mergePreview = (source: StewardPerson, target: StewardPerson) => {
  const plan = mergePlan(source, target);
  return {
    counts: plan.counts,
    items: plan.items,
    requiresPrivilegedConfirm: plan.requiresPrivilegedConfirm,
    sourceUserId: plan.sourceUserId,
    targetUserId: plan.targetUserId,
    warnings: plan.warnings,
  };
};

/** The group typeahead's limits: two characters, 20 groups unless asked, never more than 50. */
const SEARCH_GROUPS_MIN_QUERY = 2;
const SEARCH_GROUPS_DEFAULT_LIMIT = 20;
const SEARCH_GROUPS_MAX_LIMIT = 50;

export const userResolvers: Resolvers = {
  Mutation: {
    addUserToGroup: (
      _root,
      given: { groupId: string; userId: string },
      context: Context,
    ) => {
      const actor = managerOf(context, given.groupId);
      const group = groupFor(given.groupId);
      const person = personFor(given.userId);
      joinGroup(person, group.name);
      audit("group.member_added", actor, person);
      return asUser(person);
    },
    /**
     * identity's CompleteOnboarding for the caller: the terms must be accepted; a sent first name,
     * last name or non-empty email replaces the stored one, and the name is derived from the two
     * names; a sent username must be non-empty and free. Then needsOnboarding is cleared.
     */
    completeOnboarding: (
      _root,
      given: {
        acceptTerms: boolean;
        email?: null | string;
        firstName?: null | string;
        lastName?: null | string;
        username?: null | string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      if (!given.acceptTerms)
        throw refuse("BAD_USER_INPUT", "accept_terms must be true");
      let username: string | undefined;
      if (given.username !== undefined && given.username !== null) {
        username = given.username.trim();
        if (!username)
          throw refuse(
            "BAD_USER_INPUT",
            "username must not be empty when provided",
          );
        if (people().some((p) => p.username === username && p.id !== person.id))
          throw refuse("ALREADY_EXISTS", "username already taken");
      }
      const current = firstAndLast(person.name);
      const first =
        given.firstName === undefined || given.firstName === null
          ? current.firstName
          : given.firstName.trim();
      const last =
        given.lastName === undefined || given.lastName === null
          ? current.lastName
          : given.lastName.trim();
      if (first || last) person.name = `${first} ${last}`.trim();
      const email = given.email?.trim();
      if (email) person.email = email.toLowerCase();
      if (username) person.username = username;
      person.needsOnboarding = false;
      audit("user.onboarding.completed", person, person);
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
      if (source.deletedAt || target.deletedAt)
        throw refuse(
          "FAILED_PRECONDITION",
          "One of these accounts is already closed.",
        );
      const plan = mergePlan(source, target);
      if (plan.requiresPrivilegedConfirm && !given.confirmPrivileged)
        throw refuse(
          "FAILED_PRECONDITION",
          "The source account holds roles or is signed in; confirm the privileged merge.",
        );
      for (const policy of plan.policies) policy.ownerUserId = target.id;
      const dropped = new Set(plan.deduped);
      data().acknowledgements = data()
        .acknowledgements.filter((a) => !dropped.has(a))
        .map((a) => (a.userId === source.id ? { ...a, userId: target.id } : a));
      const swap = (ids: string[]) => [
        ...new Set(ids.map((id) => (id === source.id ? target.id : id))),
      ];
      for (const category of plan.categories) {
        category.authorRule = swap(category.authorRule);
        category.approverRule = swap(category.approverRule);
        category.owners = swap(category.owners);
        for (const rule of category.rules)
          if (rule.subjectKind === "USER" && rule.subjectRef === source.id)
            rule.subjectRef = target.id;
      }
      for (const { seat } of plan.seats) seat.userId = target.id;
      target.policyOverrides.push(...plan.overrides);
      source.deletedAt = new Date().toISOString();
      source.disabled = true;
      source.mergedIntoUserId = target.id;
      revokeAll(source.id);
      audit("user.accounts_merged", actor, source);
      return {
        counts: plan.counts,
        mergeOperationId: newId("merge"),
        status: "COMPLETED",
        steps: [
          "policies",
          "raci",
          "acknowledgments",
          "workflow",
          "preferences",
          "tombstone",
        ].map((step) => ({ detail: "", error: "", status: "COMPLETED", step })),
      };
    },
    removeUserFromGroup: (
      _root,
      given: { groupId: string; userId: string },
      context: Context,
    ) => {
      const actor = managerOf(context, given.groupId);
      const person = personFor(given.userId);
      const membership = membershipsOf(person).find(
        (m: Membership) => m.groupId === given.groupId,
      );
      if (membership?.source === "idp-sync" && !isSiteAdmin(actor))
        throw refuse(
          "FAILED_PRECONDITION",
          "A membership synced from the identity provider can't be removed here.",
        );
      leaveGroup(person, groupFor(given.groupId).name);
      audit("group.member_removed", actor, person);
      return asUser(person);
    },
    /** identity's RevokeMySessions: every session of the caller's, this one included; no audit. */
    revokeMySessions: (_root, _given, context: Context) =>
      revokeAll(caller(context).id),
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
      audit("user.profile.updated", person, person);
      return asUser(person);
    },
    updateUserPreferences: (
      _root,
      given: { locale?: null | string; userId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const person = personFor(given.userId);
      if (person.deletedAt) throw notFound("user");
      // The gateway validates before it forwards, so a malformed tag writes nothing.
      if (given.locale != null) person.locale = normalizedLocale(given.locale);
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
      audit("user.profile.updated", actor, person);
      return asUser(person);
    },
  },
  Query: {
    diagnostics: (_root, _given, context: Context) => {
      // The real admin is the actor; the person they act as, if any, is actingAs.
      const person = realCaller(context);
      const target = caller(context);
      return {
        actor: {
          actingAs:
            target.id === person.id
              ? null
              : {
                  id: target.id,
                  roles: rolesOf(target),
                  username: target.username,
                },
          id: person.id,
          roles: rolesOf(person),
          username: person.username,
        },
        appliance: null,
        gateway: {
          commit: null,
          name: "gateway",
          status: "OK",
          version: settings().version,
        },
        generatedAt: new Date().toISOString(),
        release: null,
        services: [
          {
            commit: null,
            name: "core",
            status: "OK",
            version: settings().version,
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
        ...liveSessions(person.id, context.session?.id),
        // A session that already ended is never the one asking.
        ...data()
          .pastSessions.filter((s) => s.userId === person.id)
          .map((s) => ({ ...s, current: false })),
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
        .filter((p) =>
          membershipsOf(p).some((m) => m.groupId === given.groupId),
        )
        .map((p) => asUser(p));
    },
    me: (_root, _given, context: Context) => asUser(caller(context)),
    myManagedGroups: (_root, _given, context: Context) => {
      const person = caller(context);
      return data()
        .platformGroups.filter((g) => managedGroupIdsOf(person).includes(g.id))
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
    /**
     * IdentityReadService.SearchGroups behind the access picker: the groups, at any depth, whose
     * name contains the query, by name. Open to whoever edits category access (group.manage or
     * template.manage). The query is trimmed and needs two characters; the limit is 20 unless
     * asked, never more than 50.
     */
    searchPlatformGroups: (
      _root,
      given: { limit?: null | number; query: string },
      context: Context,
    ) => {
      withAnyRole(context, "template-admin");
      const needle = given.query.trim().toLowerCase();
      if ([...needle].length < SEARCH_GROUPS_MIN_QUERY)
        throw refuse(
          "BAD_USER_INPUT",
          `type at least ${String(SEARCH_GROUPS_MIN_QUERY)} characters to search groups`,
        );
      const limit =
        given.limit && given.limit > 0
          ? Math.min(given.limit, SEARCH_GROUPS_MAX_LIMIT)
          : SEARCH_GROUPS_DEFAULT_LIMIT;
      return data()
        .platformGroups.filter((g) => g.name.toLowerCase().includes(needle))
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit);
    },
    searchUsers: (
      _root,
      given: { limit?: null | number; query: string },
      context: Context,
    ) => {
      caller(context);
      const needle = given.query.trim().toLowerCase();
      // Two characters at least, as the picker and the gateway hold the line: a shorter query
      // would list the whole directory.
      if (needle.length < SEARCH_MIN) return [];
      // Name, email and username, as identity matches them. A deleted account is never offered;
      // a disabled one still is, as in identity.
      const found = people().filter((p) => !p.deletedAt && matches(p, needle));
      // Someone whose name or email starts with the words typed comes before one that only
      // contains them; each group keeps the directory's order.
      const starts = (p: StewardPerson) =>
        [p.name, p.email].some((f) => f.toLowerCase().startsWith(needle));
      return [
        ...found.filter((p) => starts(p)),
        ...found.filter((p) => !starts(p)),
      ]
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
