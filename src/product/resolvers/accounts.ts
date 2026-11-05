// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The admin user detail screens: per-person policy exceptions, a person's second factors, the
// password reset and welcome email (steward-identity's admin handlers and steward-obligations'
// ResendWelcome), root admins behind an emailed step-up code, and acting as another person
// (steward-gateway internal/resolvers/impersonation_resolver.go). The emailed step-up code is any
// six digits but WRONG_CODE, like every other code the mock "sends", once one was asked for.

import { GraphQLError } from "graphql";

import type { PolicyOverride, StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import {
  impersonationOf,
  startImpersonating,
  stopImpersonating,
} from "#product/impersonation.ts";
import { passkeyCredentialId } from "#product/passkeys.ts";
import {
  caller,
  found,
  isSiteAdmin,
  people,
  realCaller,
  record,
  refuse,
  siteAdmin,
} from "#product/resolvers/shared.ts";
import { asUser, isRoot } from "#product/resolvers/users.ts";
import { goodCode } from "#product/sign-in-state.ts";

/** identity's adminMFALabelMaxLen. */
const LABEL_MAX = 128;

const BAD_STEP_UP = "invalid or expired confirmation code";

const log = createLogger("steward-accounts");

/** A refusal the gateway presents with its registry symbol as the code (apperr). */
const coded = (code: string, message: string) =>
  new GraphQLError(message, { extensions: { code } });

const personFor = (userId: string) =>
  found(
    people().find((p) => p.id === userId),
    "user",
  );

const userSubject = (person: StewardPerson) => ({
  id: person.id,
  kind: "user",
  label: person.name,
});

const rfc3339 = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Who has asked for a step-up code and not used it yet, by person id. */
const stepUps = new Set<string>();

/** identity's verifyStepUp: a code was asked for, and this is it. It works once. */
const verifyStepUp = (person: StewardPerson, otp: string) => {
  if (!otp || !stepUps.has(person.id) || !goodCode(otp))
    throw refuse("BAD_USER_INPUT", BAD_STEP_UP);
  stepUps.delete(person.id);
};

/** identity's authorizeRootChange: a root admin, with the emailed code. */
const rootChange = (context: Context, otp: string) => {
  const actor = caller(context);
  if (!isRoot(actor))
    throw coded(
      "ROOT_REQUIRED",
      "Only a root administrator can grant the root permission.",
    );
  verifyStepUp(actor, otp);
  return actor;
};

/** identity's AdminListUserFactors: the authenticator app, each passkey, then the email. */
const factorsOf = (person: StewardPerson) => [
  ...(person.secondFactor
    ? [
        {
          enrolledAt: person.totpEnrolledAt ?? null,
          id: "totp",
          kind: "totp",
          label: person.totpLabel || null,
        },
      ]
    : []),
  ...(person.passkey
    ? [
        {
          enrolledAt: person.passkeyCreatedAt ?? null,
          id: passkeyCredentialId(person.username),
          kind: "passkey",
          label: person.passkeyLabel || null,
        },
      ]
    : []),
  ...(person.email
    ? [{ enrolledAt: null, id: "email", kind: "email", label: null }]
    : []),
];

/** The factor a method id names, or identity's refusal. */
const factorFor = (person: StewardPerson, methodId: string, verb: string) => {
  if (!methodId) throw refuse("BAD_USER_INPUT", "method_id required");
  if (methodId === "email")
    throw refuse(
      "FAILED_PRECONDITION",
      `the email factor is implicit and cannot be ${verb === "remove" ? "removed" : "labelled"}`,
    );
  if (methodId === "totp") {
    if (!person.secondFactor)
      throw refuse("NOT_FOUND", `no totp enrollment to ${verb}`);
    return "totp";
  }
  if (!person.passkey || methodId !== passkeyCredentialId(person.username))
    throw refuse("NOT_FOUND", `no such passkey to ${verb}`);
  return "passkey";
};

const impersonationView = (
  target: StewardPerson | undefined,
  record: {
    expiresAt: number;
    reason: string;
    startedAt: number;
    targetUserId: string;
  },
) => ({
  expiresAt: rfc3339(record.expiresAt),
  reason: record.reason,
  startedAt: rfc3339(record.startedAt),
  targetName: target?.name || target?.email || record.targetUserId,
  targetUserId: record.targetUserId,
});

export const accountResolvers: Resolvers = {
  Mutation: {
    grantRoot: (
      _root,
      given: { otp: string; userId: string },
      context: Context,
    ) => {
      const actor = rootChange(context, given.otp);
      const person = personFor(given.userId);
      if (person.deletedAt) throw refuse("NOT_FOUND", "user not found");
      if (!isRoot(person)) {
        person.root = true;
        person.disabled = false;
        if (!person.roles.includes("site-admin"))
          person.roles.push("site-admin");
        record("root.granted", actor, userSubject(person));
      }
      return asUser(person);
    },
    removeUserMfaFactor: (
      _root,
      given: { methodId: string; userId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      if (factorFor(person, given.methodId, "remove") === "totp") {
        person.secondFactor = false;
        person.totpEnrolledAt = undefined;
        person.totpLabel = null;
      } else {
        person.passkey = false;
      }
      record("admin.mfa_factor_removed", actor, userSubject(person));
      return true;
    },
    renameUserMfaFactor: (
      _root,
      given: { label: string; methodId: string; userId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const person = personFor(given.userId);
      if (given.label.length > LABEL_MAX)
        throw refuse(
          "BAD_USER_INPUT",
          `label too long (max ${String(LABEL_MAX)} characters)`,
        );
      if (factorFor(person, given.methodId, "rename") === "totp")
        person.totpLabel = given.label || null;
      else person.passkeyLabel = given.label || null;
      record("admin.mfa_factor_relabeled", actor, userSubject(person));
      return true;
    },
    requestStepUpOtp: (_root, _given, context: Context) => {
      const person = caller(context);
      stepUps.add(person.id);
      log.info("step-up code sent (any six digits but the wrong code work)", {
        personId: person.id,
      });
      return true;
    },
    resendWelcomeEmail: (
      _root,
      given: { userId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const person = personFor(given.userId);
      if (!person.email)
        throw refuse(
          "FAILED_PRECONDITION",
          "user has no email address to send to",
        );
      log.info("welcome email sent", { personId: person.id });
      return true;
    },
    resetUserPassword: (
      _root,
      given: { newPassword: string; userId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      if (!given.newPassword)
        throw refuse("BAD_USER_INPUT", "new_password required");
      const person = personFor(given.userId);
      if (!person.localAccount)
        throw refuse(
          "FAILED_PRECONDITION",
          "the account has no local password to reset",
        );
      log.debug("password reset by an admin", { personId: person.id });
      return true;
    },
    revokeRoot: (
      _root,
      given: { otp: string; userId: string },
      context: Context,
    ) => {
      const actor = rootChange(context, given.otp);
      const person = personFor(given.userId);
      if (!isRoot(person))
        throw refuse("BAD_USER_INPUT", "the user isn't a root admin");
      if (people().filter((p) => isRoot(p)).length <= 1)
        throw refuse(
          "FAILED_PRECONDITION",
          "cannot revoke root from the last root admin",
        );
      person.root = false;
      record("root.revoked", actor, userSubject(person));
      return asUser(person);
    },
    setUserPolicyOverride: (
      _root,
      given: {
        effect?: null | PolicyOverride["effect"];
        policyNumber: string;
        userId: string;
      },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      if (!given.policyNumber)
        throw refuse("BAD_USER_INPUT", "policy_number required");
      const person = personFor(given.userId);
      const others = person.policyOverrides.filter(
        (o) => o.policyNumber !== given.policyNumber,
      );
      person.policyOverrides = given.effect
        ? [
            ...others,
            { effect: given.effect, policyNumber: given.policyNumber },
          ]
        : others;
      record(
        given.effect
          ? "user.policy_override_set"
          : "user.policy_override_cleared",
        actor,
        userSubject(person),
      );
      return asUser(person);
    },
    startImpersonation: (
      _root,
      given: { reason: string; userId: string },
      context: Context,
    ) => {
      const admin = realCaller(context);
      if (!isSiteAdmin(admin))
        throw coded(
          "IMPERSONATION_NOT_SITE_ADMIN",
          "Only a site administrator may act as another user.",
        );
      if (!given.reason)
        throw coded(
          "IMPERSONATION_REASON_REQUIRED",
          "A reason is required to act as another user.",
        );
      if (!given.userId)
        throw refuse(
          "BAD_USER_INPUT",
          "impersonation requires a target user id",
        );
      if (given.userId === admin.id)
        throw refuse("BAD_USER_INPUT", "cannot impersonate yourself");
      const target = people().find((p) => p.id === given.userId);
      if (!target) throw refuse("NOT_FOUND", "target user not found");
      if (target.disabled)
        throw refuse("FAILED_PRECONDITION", "target user is disabled");
      if (isSiteAdmin(target) || isRoot(target))
        throw coded(
          "IMPERSONATION_TARGET_PROTECTED",
          "You cannot act as a site administrator or the root user.",
        );
      if (impersonationOf(context))
        throw coded(
          "IMPERSONATION_ALREADY_ACTIVE",
          "You are already acting as another user. Stop the current session before starting a new one.",
        );
      const started = startImpersonating(
        context.session?.id ?? "",
        admin.id,
        target.id,
        given.reason,
      );
      record("impersonation.started", admin, userSubject(target));
      return impersonationView(target, started);
    },
    stopImpersonation: (_root, _given, context: Context) => {
      realCaller(context);
      const stopped = stopImpersonating(context.session?.id ?? "");
      if (stopped) {
        const admin = people().find((p) => p.id === stopped.adminUserId);
        const target = people().find((p) => p.id === stopped.targetUserId);
        if (admin && target)
          record("impersonation.stopped", admin, userSubject(target));
      }
      return true;
    },
  },
  Query: {
    impersonationStatus: (_root, _given, context: Context) => {
      const current = impersonationOf(context);
      if (!current) return null;
      return impersonationView(
        people().find((p) => p.id === current.targetUserId),
        current,
      );
    },
    /**
     * The caller's own factors, as identity's ListUserFactors answers: the authenticator app with
     * its label, one passkey entry (unlabelled, dated from the first passkey), then the email.
     */
    myFactors: (_root, _given, context: Context) =>
      factorsOf(caller(context)).map(({ enrolledAt, kind, label }) => ({
        enrolledAt,
        kind,
        label: kind === "passkey" ? null : label,
      })),
    userFactors: (_root, given: { userId: string }, context: Context) => {
      siteAdmin(context);
      return factorsOf(personFor(given.userId));
    },
  },
};
