// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// changeMyPassword, as steward-identity's ChangeMyPassword (steward-identity#66) and the gateway
// field proposed in steward-gateway#72 answer it: the signed-in person changes their own
// password, proving the current one first. A wrong current password, a weak new one, an account
// with no local password and an act-as each answer a coded refusal, and an attempt is audited
// without a password in it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  query,
  type Signed,
  startForTests,
  startFresh,
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

const CHANGE = `mutation ($currentPassword: String!, $newPassword: String!) {
  changeMyPassword(currentPassword: $currentPassword, newPassword: $newPassword)
}`;
const START = `mutation ($userId: ID!, $reason: String!) {
  startImpersonation(userId: $userId, reason: $reason) { targetUserId }
}`;

/** Jonathan Smith: a seeded account that signs in through SSO and has no local password. */
const SSO_ONLY = "user-jonathan";
const STRONG = "orchid-lantern-meadow-42";

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
    data: body.data as null | Record<string, unknown> | undefined,
    message: error?.message,
  };
};

const change = (signed: Signed, currentPassword: string, newPassword: string) =>
  ask(signed, CHANGE, { currentPassword, newPassword });

const login = async (username: string, password: string) =>
  (
    await fetch(`${base}/auth/login`, {
      body: JSON.stringify({ password, username }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  ).status;

const weak = async (next: string) => {
  const erin = await signInAs(base, "user-erin");
  const answer = await change(erin, "erin-password", next);
  assert.equal(answer.code, "PASSWORD_TOO_WEAK", next);
  assert.equal(await login("erin", "erin-password"), 200);
};

const passwordEvents = () =>
  stewardData().audit.filter((r) => r.action.startsWith("user.password."));

describe("changeMyPassword", () => {
  it("changes the caller's own password: the new one signs in and the old one does not", async () => {
    const erin = await signInAs(base, "user-erin");
    const answer = await change(erin, "erin-password", STRONG);
    assert.equal(answer.code, undefined);
    assert.equal(answer.data?.changeMyPassword, true);
    assert.equal(await login("erin", STRONG), 200);
    assert.notEqual(await login("erin", "erin-password"), 200);
  });

  it("refuses a wrong current password with CURRENT_PASSWORD_WRONG and changes nothing", async () => {
    const erin = await signInAs(base, "user-erin");
    const answer = await change(erin, "not-her-password", STRONG);
    assert.equal(answer.code, "CURRENT_PASSWORD_WRONG");
    assert.equal(answer.message, "The current password is wrong.");
    assert.equal(await login("erin", "erin-password"), 200);
  });

  it("checks the current password before the policy, as identity proves it first", async () => {
    const erin = await signInAs(base, "user-erin");
    const answer = await change(erin, "not-her-password", "short");
    assert.equal(answer.code, "CURRENT_PASSWORD_WRONG");
  });

  describe("the password policy", () => {
    it("refuses one that is too short", () => weak("Ab1-xyz"));
    it("refuses a breached one", () => weak("password123"));
    it("refuses one too similar to the person's identifier", async () => {
      await weak("Erin@Example.org");
      const jon = await signInAs(base, "user-jon");
      const answer = await change(jon, "jon.smyth-password", "JON.SMYTH");
      assert.equal(answer.code, "PASSWORD_TOO_WEAK");
    });

    it("accepts the shortest allowed length", async () => {
      const erin = await signInAs(base, "user-erin");
      const answer = await change(erin, "erin-password", "q7#Lm2!v");
      assert.equal(answer.data?.changeMyPassword, true);
    });
  });

  it("tells an account with no local password it has none: NO_LOCAL_PASSWORD", async () => {
    const signed = await signInAs(base, SSO_ONLY);
    const answer = await change(signed, "anything", STRONG);
    assert.equal(answer.code, "NO_LOCAL_PASSWORD");
    assert.equal(
      answer.message,
      "This account signs in through your organisation and has no Steward password to change.",
    );
  });

  it("is refused while acting as another person: ACT_AS_FORBIDDEN, and nothing changes", async () => {
    const alice = await signInAs(base, "user-alice");
    await ask(alice, START, {
      reason: "Checking her view",
      userId: "user-erin",
    });
    const answer = await change(alice, "erin-password", STRONG);
    assert.equal(answer.code, "ACT_AS_FORBIDDEN");
    assert.equal(await login("erin", "erin-password"), 200);
    assert.equal(await login("alice", "alice-password"), 200);
  });

  it("changes only the signed-in person's password, never one named by the request", async () => {
    const erin = await signInAs(base, "user-erin");
    await change(erin, "erin-password", STRONG);
    assert.equal(await login("bob", "bob-password"), 200);
    assert.equal(await login("alice", "alice-password"), 200);
  });

  it("refuses an empty password with BAD_USER_INPUT", async () => {
    const erin = await signInAs(base, "user-erin");
    assert.equal((await change(erin, "", STRONG)).code, "InvalidArgument");
    assert.equal(
      (await change(erin, "erin-password", "")).code,
      "InvalidArgument",
    );
  });

  it("needs a signed-in person", async () => {
    const answer = await change(
      { cookie: "", csrf: "", token: "" },
      "erin-password",
      STRONG,
    );
    assert.ok(answer.data === null || answer.data === undefined);
  });

  describe("the audit trail", () => {
    it("records user.password.changed for the caller on success", async () => {
      const erin = await signInAs(base, "user-erin");
      await change(erin, "erin-password", STRONG);
      const events = passwordEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.action, "user.password.changed");
      assert.equal(events[0]?.actorUserId, "user-erin");
      assert.equal(events[0]?.subject, "user:user-erin");
    });

    it("records user.password.change_failed for a wrong current and a weak new password", async () => {
      const erin = await signInAs(base, "user-erin");
      await change(erin, "not-her-password", STRONG);
      await change(erin, "erin-password", "short");
      assert.deepEqual(
        passwordEvents().map((r) => r.action),
        ["user.password.change_failed", "user.password.change_failed"],
      );
    });

    it("writes nothing for an account with no local password or an act-as", async () => {
      await change(await signInAs(base, SSO_ONLY), "x", STRONG);
      assert.equal(passwordEvents().length, 0);
      const alice = await signInAs(base, "user-alice");
      await ask(alice, START, { reason: "Checking", userId: "user-erin" });
      await change(alice, "erin-password", STRONG);
      assert.equal(passwordEvents().length, 0);
    });

    it("never carries a password in the audit trail", async () => {
      const erin = await signInAs(base, "user-erin");
      await change(erin, "wrong-current-secret", "zqx-1");
      await change(erin, "erin-password", STRONG);
      const trail = JSON.stringify(stewardData().audit);
      for (const secret of ["wrong-current-secret", "zqx-1", STRONG])
        assert.ok(!trail.includes(secret), `the trail holds ${secret}`);
    });
  });
});
