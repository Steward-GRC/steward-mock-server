// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The signed-in user, as steward-web asks for it. The operation text is steward-web's own
// (packages/api-client/src/operations/me.graphql): a missing non-null field there sends the web
// app back to sign-in, so it runs here exactly as the web sends it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  control,
  query,
  signIn,
  startForTests,
  startFresh,
} from "#core/test-client.ts";

const ME = `query Me {
  me {
    userId
    username
    name
    firstName
    lastName
    email
    roles
    permissions
    managedGroupIds
    scopes {
      author
    }
  }
}`;

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

const meOf = async (username: string) => {
  const { body } = await query(base, ME, await signIn(base, username));
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as { me: Record<string, unknown> }).me;
};

describe("me", () => {
  it("answers steward-web's Me operation in full", async () => {
    assert.deepEqual(await meOf("alovelace"), {
      email: "ada.lovelace@example.org",
      firstName: "Ada",
      lastName: "Lovelace",
      managedGroupIds: [],
      name: "Ada Lovelace",
      permissions: ["policy.read", "policy.author"],
      roles: ["author"],
      // Earned through the category author rules that name her, as the gateway adds them.
      scopes: {
        author: ["Finance", "Human Resources", "IT Security", "Procurement"],
      },
      userId: "user-alovelace",
      username: "alovelace",
    });
  });

  it("grants permissions the way steward-authz does for each role", async () => {
    assert.deepEqual((await meOf("kjohnson")).permissions, ["policy.read"]);
    // The privacy officer has to enrol a factor first, so the controls sign them in.
    const officer = await control(base, {
      kind: "sign-in",
      personId: "user-mhamilton",
      token: true,
    });
    const { body } = await query(base, ME, {
      cookie: "",
      csrf: "",
      token: officer.accessToken as string,
    });
    assert.deepEqual(
      (body.data as { me: { permissions: string[] } }).me.permissions,
      ["policy.read", "reporting.manage"],
    );
    const admin = (await meOf("demo-admin")).permissions as string[];
    assert.ok(admin.includes("admin.manage") && admin.includes("audit.read"));
  });
});
