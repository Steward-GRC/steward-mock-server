// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// removeUserFromGroup is idempotent, as identity's Store.RemoveUserFromGroup is: a membership that
// does not exist (an unknown group, or a group the person is not in) is a no-op that returns the
// user and writes no audit entry. An unknown user is still NotFound, and a caller who neither
// administers nor manages the group is still refused.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let admin: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  admin = await signInAs(base, "user-alice");
});

const remove = (signed: Signed, groupId: string, userId: string) =>
  call(base, signed, "RemoveUserFromGroup", { groupId, userId });

const groupsOfBob = () => [
  ...((
    stewardData().people.find((p) => p.id === "user-bob") as unknown as {
      groups: string[];
    }
  ).groups ?? []),
];

const removals = () =>
  stewardData().audit.filter((entry) => entry.action === "group.member_removed")
    .length;

describe("removeUserFromGroup when there is no membership to remove", () => {
  it("returns the user for a group that does not exist, with no audit entry", async () => {
    const groups = groupsOfBob();
    const audited = stewardData().audit.length;
    const answer = await remove(admin, "group-does-not-exist", "user-bob");
    assert.equal(answer.refused, undefined);
    const user = answer.data.removeUserFromGroup as { userId: string };
    assert.equal(user.userId, "user-bob");
    assert.deepEqual(groupsOfBob(), groups);
    assert.equal(stewardData().audit.length, audited);
  });

  it("returns the user for a group the person is not in, with no audit entry", async () => {
    const audited = stewardData().audit.length;
    const answer = await remove(admin, "group-4", "user-bob");
    assert.equal(answer.refused, undefined);
    assert.equal(
      (answer.data.removeUserFromGroup as { userId: string }).userId,
      "user-bob",
    );
    assert.equal(stewardData().audit.length, audited);
  });

  it("is the same answer when it is repeated after a real removal", async () => {
    const added = await call(base, admin, "AddUserToGroup", {
      groupId: "group-4",
      userId: "user-bob",
    });
    assert.equal(added.refused, undefined);
    const first = await remove(admin, "group-4", "user-bob");
    assert.equal(first.refused, undefined);
    assert.equal(removals(), 1);
    const second = await remove(admin, "group-4", "user-bob");
    assert.equal(second.refused, undefined);
    assert.equal(removals(), 1);
    assert.ok(!groupsOfBob().includes("Approvers"));
  });

  it("still finds no user: an unknown user is NotFound", async () => {
    const answer = await remove(admin, "group-4", "user-nobody");
    assert.equal(answer.refused, "NotFound");
    const unknownBoth = await remove(admin, "group-nope", "user-nobody");
    assert.equal(unknownBoth.refused, "NotFound");
  });

  it("still refuses a caller who does not administer or manage the group", async () => {
    const bob = await signInAs(base, "user-bob");
    const answer = await remove(bob, "group-does-not-exist", "user-bob");
    assert.equal(answer.refused, "PermissionDenied");
  });

  it("writes an audit entry for a membership that was removed", async () => {
    await call(base, admin, "AddUserToGroup", {
      groupId: "group-4",
      userId: "user-bob",
    });
    await remove(admin, "group-4", "user-bob");
    assert.equal(removals(), 1);
  });
});

describe("addUserToGroup for a group that does not exist", () => {
  it("is still NotFound", async () => {
    const answer = await call(base, admin, "AddUserToGroup", {
      groupId: "group-does-not-exist",
      userId: "user-bob",
    });
    assert.equal(answer.refused, "NotFound");
  });
});
