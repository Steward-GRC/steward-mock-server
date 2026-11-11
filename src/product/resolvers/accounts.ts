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
import { setRoot } from "#product/groups.ts";
import {
  impersonationOf,
  startImpersonating,
  stopImpersonating,
} from "#product/impersonation.ts";
import { passkeysOf, setPasskeys } from "#product/passkeys.ts";
import {
  caller,
  data,
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

/** Kratos's password policy has a minimum length of 8 (identity leaves the rest to Kratos). */
const PASSWORD_MIN = 8;

/**
 * A few of the passwords a breach list always holds. Kratos asks Have I Been Pwned; the mock has no
 * network, so a short fixed list stands for "breached".
 */
const BREACHED = new Set([
  "11111111",
  "12345678",
  "123456789",
  "1234567890",
  "abc12345",
  "football",
  "iloveyou",
  "letmein1",
  "password",
  "password1",
  "password123",
  "qwerty123",
  "qwertyuiop",
  "welcome1",
]);

/**
 * identity's ChangePassword outcome for the password policy: too short, breached, or too similar
 * to the identifier (the email), which the mock reads as the email, its mailbox part or the
 * username, with any case, and a password that holds the whole email. Kratos scores similarity;
 * the mock keeps the rule exact so a test can tell why.
 */
const weakPassword = (person: StewardPerson, next: string): boolean => {
  const lower = next.toLowerCase();
  const email = person.email.toLowerCase();
  const identifiers = [
    email,
    email.split("@", 1)[0] ?? "",
    person.username.toLowerCase(),
  ];
  return (
    [...next].length < PASSWORD_MIN ||
    BREACHED.has(lower) ||
    identifiers.some((id) => id !== "" && lower === id) ||
    (email !== "" && lower.includes(email))
  );
};

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
  ...passkeysOf(person).map((passkey) => ({
    enrolledAt: passkey.createdAt,
    id: passkey.id,
    kind: "passkey",
    label: passkey.label,
  })),
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
  if (!passkeysOf(person).some((p) => p.id === methodId))
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
    /**
     * identity's ChangeMyPassword (steward-identity#66) behind the gateway field proposed in
     * steward-gateway#72: the signed-in person's own password, never one a request names. Refused
     * while acting as someone (identity's ACT_AS_FORBIDDEN). Identity proves the current password
     * before it applies the policy, so a wrong current answers first. An attempt is audited as
     * user.password.changed or user.password.change_failed; no password goes in the trail or a log.
     */
    changeMyPassword: (
      _root,
      given: { currentPassword: string; newPassword: string },
      context: Context,
    ) => {
      const person = realCaller(context);
      if (impersonationOf(context)) {
        log.debug("change my password refused while acting as another", {
          personId: person.id,
        });
        throw coded(
          "ACT_AS_FORBIDDEN",
          "This action isn't available while you're acting as another user. Stop acting as them first.",
        );
      }
      if (!given.currentPassword || !given.newPassword)
        throw refuse(
          "BAD_USER_INPUT",
          "current_password and new_password required",
        );
      if (!person.localAccount) {
        log.debug("change my password: no local password", {
          personId: person.id,
        });
        throw coded(
          "NO_LOCAL_PASSWORD",
          "This account signs in through your organisation and has no Steward password to change.",
        );
      }
      if (!person.password || given.currentPassword !== person.password) {
        log.debug("change my password: wrong current password", {
          personId: person.id,
        });
        record("user.password.change_failed", person, userSubject(person));
        throw coded("CURRENT_PASSWORD_WRONG", "The current password is wrong.");
      }
      if (weakPassword(person, given.newPassword)) {
        log.debug("change my password: refused by the password policy", {
          personId: person.id,
        });
        record("user.password.change_failed", person, userSubject(person));
        throw coded(
          "PASSWORD_TOO_WEAK",
          "That password doesn't meet the password rules. Choose a longer password that isn't common or easy to guess.",
        );
      }
      person.password = given.newPassword;
      record("user.password.changed", person, userSubject(person));
      log.info("password changed by its owner", { personId: person.id });
      return true;
    },
    grantRoot: (
      _root,
      given: { otp: string; userId: string },
      context: Context,
    ) => {
      const actor = rootChange(context, given.otp);
      const person = personFor(given.userId);
      if (person.deletedAt) throw refuse("NOT_FOUND", "user not found");
      if (!isRoot(person)) {
        setRoot(person, true);
        person.disabled = false;
        if (!person.roles.includes("site-admin"))
          person.roles.push("site-admin");
        record("root.granted", actor, userSubject(person));
      }
      return asUser(person);
    },
    /**
     * core's ReassignUserPolicies: every policy the first person owns, retired ones too, moves to
     * the second, and every category rule naming the first as a user names the second, each
     * audited. It never deletes anything, and checks neither person exists.
     */
    reassignUserPolicies: (
      _root,
      given: { fromUserId: string; toUserId: string },
      context: Context,
    ) => {
      const actor = siteAdmin(context);
      const { fromUserId, toUserId } = given;
      if (fromUserId === toUserId)
        throw refuse(
          "BAD_USER_INPUT",
          "from_user_id and to_user_id must differ",
        );
      const moved = data().policies.filter((p) => p.ownerUserId === fromUserId);
      for (const policy of moved) {
        policy.ownerUserId = toUserId;
        policy.updatedAt = new Date().toISOString();
        record("policy.owner_changed", actor, {
          groupId: policy.homeCategoryId,
          id: policy.id,
          kind: "policy",
          label: policy.title,
        });
      }
      let grants = 0;
      for (const category of data().categories) {
        for (const rule of category.rules)
          if (rule.subjectKind === "USER" && rule.subjectRef === fromUserId) {
            rule.subjectRef = toUserId;
            grants++;
          }
        // The mock's read model keeps the authors on the category too.
        category.authorRule = category.authorRule.map((id) =>
          id === fromUserId ? toUserId : id,
        );
      }
      const from = people().find((p) => p.id === fromUserId);
      if (grants > 0)
        record("category.ruleset_changed", actor, {
          id: fromUserId,
          kind: "user",
          label: from?.name ?? fromUserId,
        });
      return {
        reassignedAuthorGrants: grants,
        reassignedOwnerCount: moved.length,
        reassignedPolicyIds: moved.map((p) => p.id),
      };
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
        setPasskeys(
          person,
          passkeysOf(person).filter((p) => p.id !== given.methodId),
        );
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
      else
        for (const passkey of passkeysOf(person))
          if (passkey.id === given.methodId)
            passkey.label = given.label || null;
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
      person.password = given.newPassword;
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
      setRoot(person, false);
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
      factorsOf(caller(context))
        .filter(
          (factor, index, all) =>
            factor.kind !== "passkey" ||
            all.findIndex((f) => f.kind === "passkey") === index,
        )
        .map(({ enrolledAt, kind, label }) => ({
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
