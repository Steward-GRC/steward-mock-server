// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// reassignUserPolicies, as steward-gateway and steward-core answer it: every policy one person
// owns moves to another, and every category rule naming the first person as a user names the
// second, in one audited admin step. Site admins only.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

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

const reassign = async (
  personId: string,
  fromUserId: string,
  toUserId: string,
) =>
  call(base, await signInAs(base, personId), "ReassignUserPolicies", {
    fromUserId,
    toUserId,
  });

describe("reassignUserPolicies", () => {
  it("moves every policy a person owns, and audits each", async () => {
    const owned = stewardData()
      .policies.filter((p) => p.ownerUserId === "user-bob")
      .map((p) => p.id);
    assert.ok(owned.length > 0);
    const answer = await reassign("user-alice", "user-bob", "user-charlie");
    assert.equal(answer.refused, undefined);
    assert.deepEqual(answer.data.reassignUserPolicies, {
      reassignedAuthorGrants: 0,
      reassignedOwnerCount: owned.length,
    });
    assert.equal(
      stewardData().policies.filter((p) => p.ownerUserId === "user-bob").length,
      0,
    );
    const moved = stewardData().audit.filter(
      (r) => r.action === "policy.owner_changed",
    );
    assert.equal(moved.length, owned.length);
  });

  it("rewrites the category rules that name the person", async () => {
    const answer = await reassign("user-alice", "user-erin", "user-dave");
    assert.deepEqual(answer.data.reassignUserPolicies, {
      reassignedAuthorGrants: 1,
      reassignedOwnerCount: 0,
    });
    const expenses = stewardData().categories.find(
      (c) => c.id === "category-expenses",
    );
    assert.deepEqual(
      expenses?.rules
        .filter((r) => r.subjectKind === "USER")
        .map((r) => r.subjectRef),
      ["user-dave"],
    );
    assert.equal(
      stewardData().audit.at(-1)?.action,
      "category.ruleset_changed",
    );
  });

  it("refuses the same person twice and a non-admin", async () => {
    assert.equal(
      (await reassign("user-alice", "user-bob", "user-bob")).refused,
      "InvalidArgument",
    );
    assert.equal(
      (await reassign("user-bob", "user-bob", "user-charlie")).refused,
      "PermissionDenied",
    );
  });
});

describe("the Facilities team", () => {
  it("has the three members A22's frame shows", () => {
    const members = stewardData()
      .people.filter((p) =>
        (p as { memberships?: { groupId: string }[] }).memberships?.some(
          (m) => m.groupId === "group-3",
        ),
      )
      .map((p) => p.id)
      .toSorted();
    assert.deepEqual(members, ["user-dave", "user-erin", "user-heidi"]);
  });
});
