// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// myFactors, the signed-in person's own second factors, as steward-gateway answers it from
// identity's ListUserFactors: the authenticator app with its label, one passkey entry dated from
// the first passkey, and the implicit email factor. steward-web nudges someone who has only the
// email factor towards a stronger one (H8).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  post,
  query,
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

const MY_FACTORS = "query { myFactors { kind enrolledAt label } }";

const factorsOf = async (personId: string) => {
  const { body } = await query(
    base,
    MY_FACTORS,
    await signInAs(base, personId),
  );
  assert.equal(body.errors, undefined);
  return body.data?.myFactors;
};

const EMAIL = { enrolledAt: null, kind: "email", label: null };

describe("myFactors", () => {
  it("gives Erin only the email factor, so she gets the nudge", async () => {
    assert.deepEqual(await factorsOf("user-erin"), [EMAIL]);
  });

  it("lists Alice's authenticator app and Charlie's app and passkey", async () => {
    assert.deepEqual(await factorsOf("user-alice"), [
      { enrolledAt: "2026-02-10T09:00:00Z", kind: "totp", label: "Work phone" },
      EMAIL,
    ]);
    assert.deepEqual(await factorsOf("user-charlie"), [
      { enrolledAt: "2026-04-02T14:30:00Z", kind: "totp", label: null },
      { enrolledAt: "2026-06-18T08:15:00Z", kind: "passkey", label: null },
      EMAIL,
    ]);
  });

  it("follows an admin removing a factor", async () => {
    const admin = await signInAs(base, "user-alice");
    await query(
      base,
      'mutation { removeUserMfaFactor(userId: "user-alice", methodId: "totp") }',
      admin,
    );
    assert.deepEqual(await factorsOf("user-alice"), [EMAIL]);
  });

  it("needs someone signed in", async () => {
    const answer = await post(base, "/query", { query: MY_FACTORS });
    assert.equal(answer.status, 401);
  });
});
