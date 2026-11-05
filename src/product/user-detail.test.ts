// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The admin user detail screens (steward-web's A16–A20), as steward-gateway and steward-identity
// answer them: per-person policy exceptions, a person's second factors, the password reset and
// welcome email, root admins behind an emailed step-up code, and acting as another person.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { passkeyCredentialId } from "#product/passkeys.ts";
import {
  GOOD_CODE,
  query,
  type Signed,
  startForTests,
  startFresh,
  WRONG_CODE,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const admin = () => signInAs(base, "user-alice");
const reader = () => signInAs(base, "user-erin");

const OVERRIDES = `query { users { users { userId policyOverrides { policyNumber effect } } } }`;
const SET_OVERRIDE = `mutation ($userId: ID!, $policyNumber: String!, $effect: OverrideEffect) {
  setUserPolicyOverride(userId: $userId, policyNumber: $policyNumber, effect: $effect) {
    policyOverrides { policyNumber effect }
  }
}`;
const FACTORS = `query ($userId: ID!) { userFactors(userId: $userId) { id kind enrolledAt label } }`;
const REMOVE_FACTOR = `mutation ($userId: ID!, $methodId: ID!) { removeUserMfaFactor(userId: $userId, methodId: $methodId) }`;
const RENAME_FACTOR = `mutation ($userId: ID!, $methodId: ID!, $label: String!) {
  renameUserMfaFactor(userId: $userId, methodId: $methodId, label: $label)
}`;
const RESET = `mutation ($userId: ID!, $newPassword: String!) { resetUserPassword(userId: $userId, newPassword: $newPassword) }`;
const WELCOME = `mutation ($userId: ID!) { resendWelcomeEmail(userId: $userId) }`;
const STEP_UP = `mutation { requestStepUpOtp }`;
const GRANT_ROOT = `mutation ($userId: ID!, $otp: String!) { grantRoot(userId: $userId, otp: $otp) { userId isRoot roles } }`;
const REVOKE_ROOT = `mutation ($userId: ID!, $otp: String!) { revokeRoot(userId: $userId, otp: $otp) { userId isRoot roles } }`;
const START = `mutation ($userId: ID!, $reason: String!) {
  startImpersonation(userId: $userId, reason: $reason) { targetUserId targetName reason startedAt expiresAt }
}`;
const STOP = `mutation { stopImpersonation }`;
const STATUS = `query { impersonationStatus { targetUserId targetName reason startedAt expiresAt } }`;
const ME = `query { me { userId } }`;

describe("policy exceptions", () => {
  it("answers the seeded exceptions on each user", async () => {
    const { data } = await ask(await admin(), OVERRIDES);
    const { users: page } = data as {
      users: { users: { policyOverrides: unknown[]; userId: string }[] };
    };
    const overridesOf = (userId: string) =>
      page.users.find((u) => u.userId === userId)?.policyOverrides;
    assert.deepEqual(overridesOf("user-erin"), [
      { effect: "ALLOW", policyNumber: "POL-RECORDS-000002" },
    ]);
    assert.deepEqual(overridesOf("user-dave"), [
      { effect: "DENY", policyNumber: "PRC-DEVICES-000001" },
    ]);
    assert.deepEqual(overridesOf("user-bob"), []);
  });

  it("sets, changes and clears one, and audits each", async () => {
    const signed = await admin();
    const set = async (effect: null | string) =>
      (
        await ask(signed, SET_OVERRIDE, {
          effect,
          policyNumber: "POL-LEAVE-000001",
          userId: "user-bob",
        })
      ).data.setUserPolicyOverride;
    assert.deepEqual(await set("DENY"), {
      policyOverrides: [{ effect: "DENY", policyNumber: "POL-LEAVE-000001" }],
    });
    assert.deepEqual(await set("ALLOW"), {
      policyOverrides: [{ effect: "ALLOW", policyNumber: "POL-LEAVE-000001" }],
    });
    assert.deepEqual(await set(null), { policyOverrides: [] });
    const actions = stewardData()
      .audit.map((r) => r.action)
      .filter((a) => a.startsWith("user.policy_override"));
    assert.deepEqual(actions, [
      "user.policy_override_set",
      "user.policy_override_set",
      "user.policy_override_cleared",
    ]);
  });

  it("refuses a blank policy number, an unknown person and a non-admin", async () => {
    const signed = await admin();
    const given = { effect: "DENY", policyNumber: "", userId: "user-bob" };
    assert.equal(
      (await ask(signed, SET_OVERRIDE, given)).code,
      "InvalidArgument",
    );
    assert.equal(
      (
        await ask(signed, SET_OVERRIDE, {
          ...given,
          policyNumber: "X",
          userId: "user-nobody",
        })
      ).code,
      "NotFound",
    );
    assert.equal(
      (await ask(await reader(), SET_OVERRIDE, { ...given, policyNumber: "X" }))
        .code,
      "PermissionDenied",
    );
  });
});

describe("second factors", () => {
  it("lists each person's factors as identity does", async () => {
    const signed = await admin();
    const factorsOf = async (userId: string) =>
      (await ask(signed, FACTORS, { userId })).data.userFactors;
    assert.deepEqual(await factorsOf("user-alice"), [
      {
        enrolledAt: "2026-02-10T09:00:00Z",
        id: "totp",
        kind: "totp",
        label: "Work phone",
      },
      { enrolledAt: null, id: "email", kind: "email", label: null },
    ]);
    assert.deepEqual(await factorsOf("user-charlie"), [
      {
        enrolledAt: "2026-04-02T14:30:00Z",
        id: "totp",
        kind: "totp",
        label: null,
      },
      {
        enrolledAt: "2026-06-18T08:15:00Z",
        id: passkeyCredentialId("charlie"),
        kind: "passkey",
        label: "MacBook Touch ID",
      },
      { enrolledAt: null, id: "email", kind: "email", label: null },
    ]);
    assert.deepEqual(await factorsOf("user-bob"), [
      { enrolledAt: null, id: "email", kind: "email", label: null },
    ]);
  });

  it("removes a factor, so it's gone from the list and from sign-in", async () => {
    const signed = await admin();
    const removed = await ask(signed, REMOVE_FACTOR, {
      methodId: passkeyCredentialId("charlie"),
      userId: "user-charlie",
    });
    assert.deepEqual(removed.data, { removeUserMfaFactor: true });
    const kinds = (
      (await ask(signed, FACTORS, { userId: "user-charlie" })).data
        .userFactors as {
        kind: string;
      }[]
    ).map((f) => f.kind);
    assert.deepEqual(kinds, ["totp", "email"]);
    assert.equal(
      stewardData().audit.at(-1)?.action,
      "admin.mfa_factor_removed",
    );
  });

  it("relabels a factor, and an empty label clears it", async () => {
    const signed = await admin();
    const rename = (label: string) =>
      ask(signed, RENAME_FACTOR, {
        label,
        methodId: "totp",
        userId: "user-alice",
      });
    assert.deepEqual((await rename("Spare phone")).data, {
      renameUserMfaFactor: true,
    });
    let factors = (await ask(signed, FACTORS, { userId: "user-alice" })).data
      .userFactors as { label: null | string }[];
    assert.equal(factors[0]?.label, "Spare phone");
    await rename("");
    factors = (await ask(signed, FACTORS, { userId: "user-alice" })).data
      .userFactors as { label: null | string }[];
    assert.equal(factors[0]?.label, null);
    assert.equal(
      stewardData().audit.at(-1)?.action,
      "admin.mfa_factor_relabeled",
    );
  });

  it("refuses the email factor, a factor that isn't there, and a bad request", async () => {
    const signed = await admin();
    const remove = (userId: string, methodId: string) =>
      ask(signed, REMOVE_FACTOR, { methodId, userId });
    assert.equal(
      (await remove("user-alice", "email")).code,
      "FailedPrecondition",
    );
    assert.equal((await remove("user-bob", "totp")).code, "NotFound");
    assert.equal(
      (await remove("user-alice", "no-such-passkey")).code,
      "NotFound",
    );
    assert.equal((await remove("user-alice", "")).code, "InvalidArgument");
    assert.equal((await remove("user-nobody", "totp")).code, "NotFound");
    const long = await ask(signed, RENAME_FACTOR, {
      label: "x".repeat(129),
      methodId: "totp",
      userId: "user-alice",
    });
    assert.equal(long.code, "InvalidArgument");
    const email = await ask(signed, RENAME_FACTOR, {
      label: "Mail",
      methodId: "email",
      userId: "user-alice",
    });
    assert.equal(email.code, "FailedPrecondition");
    assert.equal(
      (await ask(await reader(), FACTORS, { userId: "user-alice" })).code,
      "PermissionDenied",
    );
  });
});

describe("password and welcome email", () => {
  it("resets a local account's password", async () => {
    const signed = await admin();
    assert.deepEqual(
      (
        await ask(signed, RESET, {
          newPassword: "a new one",
          userId: "user-bob",
        })
      ).data,
      { resetUserPassword: true },
    );
    assert.equal(
      (await ask(signed, RESET, { newPassword: "", userId: "user-bob" })).code,
      "InvalidArgument",
    );
    assert.equal(
      (await ask(signed, RESET, { newPassword: "x", userId: "user-charlie" }))
        .code,
      "FailedPrecondition",
    );
    assert.equal(
      (
        await ask(await reader(), RESET, {
          newPassword: "x",
          userId: "user-bob",
        })
      ).code,
      "PermissionDenied",
    );
  });

  it("re-sends the welcome email", async () => {
    const signed = await admin();
    assert.deepEqual(
      (await ask(signed, WELCOME, { userId: "user-erin" })).data,
      {
        resendWelcomeEmail: true,
      },
    );
    assert.equal(
      (await ask(signed, WELCOME, { userId: "user-nobody" })).code,
      "NotFound",
    );
    assert.equal(
      (await ask(await reader(), WELCOME, { userId: "user-erin" })).code,
      "PermissionDenied",
    );
  });
});

describe("root admins", () => {
  it("grants root with the emailed code, which works once", async () => {
    const signed = await admin();
    assert.deepEqual((await ask(signed, STEP_UP)).data, {
      requestStepUpOtp: true,
    });
    const granted = await ask(signed, GRANT_ROOT, {
      otp: GOOD_CODE,
      userId: "user-bob",
    });
    assert.deepEqual(granted.data, {
      grantRoot: {
        isRoot: true,
        roles: ["author", "site-admin"],
        userId: "user-bob",
      },
    });
    assert.equal(stewardData().audit.at(-1)?.action, "root.granted");
    const again = await ask(signed, GRANT_ROOT, {
      otp: GOOD_CODE,
      userId: "user-erin",
    });
    assert.equal(again.code, "InvalidArgument");
    assert.equal(again.message, "invalid or expired confirmation code");
  });

  it("refuses a wrong code, a missing request and a non-root caller", async () => {
    const signed = await admin();
    assert.equal(
      (await ask(signed, GRANT_ROOT, { otp: GOOD_CODE, userId: "user-bob" }))
        .code,
      "InvalidArgument",
    );
    await ask(signed, STEP_UP);
    assert.equal(
      (await ask(signed, GRANT_ROOT, { otp: WRONG_CODE, userId: "user-bob" }))
        .code,
      "InvalidArgument",
    );
    const erin = await reader();
    await ask(erin, STEP_UP);
    assert.equal(
      (await ask(erin, GRANT_ROOT, { otp: GOOD_CODE, userId: "user-erin" }))
        .code,
      "ROOT_REQUIRED",
    );
  });

  it("revokes root, keeping site admin, but never from the last root admin", async () => {
    const signed = await admin();
    await ask(signed, STEP_UP);
    let answer = await ask(signed, REVOKE_ROOT, {
      otp: GOOD_CODE,
      userId: "user-alice",
    });
    assert.equal(answer.code, "FailedPrecondition");
    await ask(signed, STEP_UP);
    await ask(signed, GRANT_ROOT, { otp: GOOD_CODE, userId: "user-bob" });
    await ask(signed, STEP_UP);
    answer = await ask(signed, REVOKE_ROOT, {
      otp: GOOD_CODE,
      userId: "user-bob",
    });
    assert.deepEqual(answer.data, {
      revokeRoot: {
        isRoot: false,
        roles: ["author", "site-admin"],
        userId: "user-bob",
      },
    });
    await ask(signed, STEP_UP);
    answer = await ask(signed, REVOKE_ROOT, {
      otp: GOOD_CODE,
      userId: "user-erin",
    });
    assert.equal(answer.code, "InvalidArgument");
  });
});

describe("acting as another person", () => {
  it("acts as the person until stopped, recording the real admin", async () => {
    const signed = await admin();
    const started = (
      await ask(signed, START, {
        reason: "Checking her view",
        userId: "user-erin",
      })
    ).data.startImpersonation as Record<string, string>;
    assert.equal(started.targetUserId, "user-erin");
    assert.equal(started.targetName, "Erin Reader");
    assert.equal(started.reason, "Checking her view");
    assert.equal(
      Date.parse(started.expiresAt ?? "") - Date.parse(started.startedAt ?? ""),
      30 * 60_000,
    );
    assert.deepEqual((await ask(signed, STATUS)).data, {
      impersonationStatus: started,
    });
    assert.deepEqual((await ask(signed, ME)).data, {
      me: { userId: "user-erin" },
    });
    const startedEntry = stewardData().audit.at(-1);
    assert.equal(startedEntry?.action, "impersonation.started");
    assert.equal(startedEntry?.actorUserId, "user-alice");

    assert.deepEqual((await ask(signed, STOP)).data, {
      stopImpersonation: true,
    });
    assert.deepEqual((await ask(signed, STATUS)).data, {
      impersonationStatus: null,
    });
    assert.deepEqual((await ask(signed, ME)).data, {
      me: { userId: "user-alice" },
    });
    const stoppedEntry = stewardData().audit.at(-1);
    assert.equal(stoppedEntry?.action, "impersonation.stopped");
    assert.equal(stoppedEntry?.actorUserId, "user-alice");
  });

  it("refuses high-risk changes while acting as someone, and nesting", async () => {
    const signed = await admin();
    await ask(signed, START, { reason: "Support ticket", userId: "user-bob" });
    const reset = await ask(signed, RESET, {
      newPassword: "x",
      userId: "user-erin",
    });
    assert.equal(reset.code, "IMPERSONATION_DENIED");
    assert.equal(
      reset.message,
      'not allowed while acting as another user: "resetUserPassword" is a high-risk operation',
    );
    const nested = await ask(signed, START, {
      reason: "Again",
      userId: "user-erin",
    });
    assert.equal(nested.code, "IMPERSONATION_DENIED");
  });

  it("keeps it to the admin's own session", async () => {
    const one = await admin();
    const two = await admin();
    await ask(one, START, { reason: "Support ticket", userId: "user-erin" });
    assert.deepEqual((await ask(two, ME)).data, {
      me: { userId: "user-alice" },
    });
    assert.deepEqual((await ask(two, STATUS)).data, {
      impersonationStatus: null,
    });
  });

  it("refuses a non-admin, a blank reason, yourself, a protected or disabled or unknown target", async () => {
    const signed = await admin();
    const start = async (who: Signed, userId: string, reason = "Support") =>
      (await ask(who, START, { reason, userId })).code;
    assert.equal(
      await start(await reader(), "user-bob"),
      "IMPERSONATION_NOT_SITE_ADMIN",
    );
    assert.equal(
      await start(signed, "user-bob", ""),
      "IMPERSONATION_REASON_REQUIRED",
    );
    assert.equal(await start(signed, "user-alice"), "InvalidArgument");
    assert.equal(await start(signed, "user-frank"), "FailedPrecondition");
    assert.equal(await start(signed, "user-nobody"), "NotFound");
    await ask(
      signed,
      `mutation { grantRole(userId: "user-bob", role: "site-admin") { userId } }`,
    );
    assert.equal(
      await start(signed, "user-bob"),
      "IMPERSONATION_TARGET_PROTECTED",
    );
  });

  it("answers stop with nothing to stop", async () => {
    assert.deepEqual((await ask(await admin(), STOP)).data, {
      stopImpersonation: true,
    });
  });
});
