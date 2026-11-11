// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// groups on AckRosterEntry (steward-gateway#77): each roster person's platform group names, sorted
// case-insensitively and then exactly. A person in no platform group gets [], and a group the
// person names that is not a platform group (an IdP-only one) or a "Manages ..." entry is not
// listed.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { query, startForTests, startFresh } from "#product/test-client.ts";
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

interface Entry {
  groups: string[];
  userId: string;
}

const ROSTER = `query($v: ID!, $g: ID) { ackRoster(policyVersionId: $v, groupId: $g) {
  acked { userId groups } pending { userId groups }
} }`;

const rosterOf = async (groupId?: string) => {
  const admin = await signInAs(base, "user-alice");
  const { body } = await query(base, ROSTER, admin, {
    g: groupId ?? null,
    v: "version-2",
  });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  const { acked, pending } = (
    body.data as { ackRoster: { acked: Entry[]; pending: Entry[] } }
  ).ackRoster;
  const all = [...acked, ...pending];
  return (id: string) => all.find((item) => item.userId === id)?.groups;
};

const setGroups = (id: string, groups: string[]) => {
  const person = stewardData().people.find((p) => p.id === id);
  assert.ok(person, id);
  Object.assign(person, { groups });
};

describe("AckRosterEntry.groups", () => {
  it("lists the platform groups of a person in two, sorted", async () => {
    // Grace is a seeded roster person; give her two.
    setGroups("user-grace", ["Facilities team", "All staff"]);
    assert.deepEqual((await rosterOf())("user-grace"), [
      "All staff",
      "Facilities team",
    ]);
  });

  it("answers [] for a person in no platform group", async () => {
    setGroups("user-grace", []);
    assert.deepEqual((await rosterOf())("user-grace"), []);
  });

  it("answers the same on the acked and the pending side", async () => {
    const roster = await rosterOf();
    for (const id of ["user-heidi", "user-erin", "user-bob"]) {
      assert.ok(Array.isArray(roster(id)), id);
    }
  });

  it("leaves out a group that is not a platform group and a Manages entry", async () => {
    setGroups("user-grace", [
      "contractors",
      "Finance team",
      "Manages Finance team",
    ]);
    assert.deepEqual((await rosterOf())("user-grace"), ["Finance team"]);
  });

  it("sorts case-insensitively, then exactly", async () => {
    stewardData().platformGroups.push(
      { id: "group-90", name: "zebra", parentId: null },
      { id: "group-91", name: "Beta", parentId: null },
      { id: "group-92", name: "ops", parentId: null },
      { id: "group-93", name: "Ops", parentId: null },
      { id: "group-94", name: "alpha", parentId: null },
    );
    setGroups("user-grace", ["zebra", "Beta", "ops", "Ops", "alpha"]);
    assert.deepEqual((await rosterOf())("user-grace"), [
      "alpha",
      "Beta",
      "Ops",
      "ops",
      "zebra",
    ]);
  });

  it("is filled when the roster is narrowed to a group", async () => {
    setGroups("user-grace", ["Finance team", "All staff"]);
    const roster = await rosterOf("group-2");
    assert.deepEqual(roster("user-grace"), ["All staff", "Finance team"]);
  });
});
