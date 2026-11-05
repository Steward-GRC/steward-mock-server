// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Heidi, the brief's group manager: she signs in with a password and no second factor, and
// manages the Facilities team, so My groups (A22) can be walked.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  post,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call } from "#product/web-client.ts";

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

/** Sign in as steward-web does, by password, and take the cookie session it answers. */
const signInByPassword = async (username: string): Promise<Signed> => {
  const answer = await post(base, "/auth/login", {
    password: "any password",
    username,
  });
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as Record<string, unknown>;
  assert.equal(body.mfaRequired, undefined, "asked for a second factor");
  const cookie =
    (answer.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  return { cookie, csrf: String(body.csrfToken) };
};

describe("Heidi", () => {
  it("signs in with a password and no second factor", async () => {
    const heidi = await signInByPassword("heidi@example.org");
    const { data, refused } = await call(base, heidi, "Me");
    assert.equal(refused, undefined);
    const { me } = data as {
      me: {
        email: string;
        managedGroupIds: string[];
        name: string;
        roles: string[];
      };
    };
    assert.equal(me.email, "heidi@example.org");
    assert.equal(me.name, "Heidi Manager");
    assert.deepEqual(me.roles, []);
    assert.deepEqual(me.managedGroupIds, ["group-3"]);
  });

  it("manages the Facilities team and sees its members", async () => {
    const heidi = await signInByPassword("heidi");
    const groups = await call(base, heidi, "MyManagedGroups");
    assert.deepEqual(groups.data.myManagedGroups, [
      { id: "group-3", name: "Facilities team", parentId: "group-1" },
    ]);
    const members = await call(base, heidi, "ManagedGroupMembers", {
      groupId: "group-3",
    });
    assert.equal(members.refused, undefined);
    const ids = (members.data.managedGroupMembers as { userId: string }[]).map(
      (u) => u.userId,
    );
    assert.deepEqual(ids.toSorted(), ["user-erin", "user-heidi"]);
  });

  it("manages no other group", async () => {
    const heidi = await signInByPassword("heidi");
    const other = await call(base, heidi, "ManagedGroupMembers", {
      groupId: "group-2",
    });
    assert.equal(other.refused, "PermissionDenied");
  });
});
