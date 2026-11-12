// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Who someone is and what they may do comes from the mock's own store of people, edited on
// /_mock: the template's roles field and Steward's groups field, read on every request. Roles
// decide permissions, as in identity; groups are the person's IdP groups (what category rules
// match) and their membership of the platform group of the same name, and "Manages <group>" makes
// them its group manager (mock only). An edit on /_mock writes the store as it is and announces
// user.permissions_changed on liveEvents; Steward's own admin mutations keep the gateway's rules
// and write the same store.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { subscribe } from "#core/events.ts";
import { stewardData } from "#product/data.ts";
import { LIVE_EVENTS, type LiveEvent } from "#product/resolvers/shared.ts";
import {
  control,
  query,
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
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

interface Me {
  groupIds: string[];
  idpGroups: string[];
  isRoot: boolean;
  managedGroupIds: string[];
  permissions: string[];
  roles: string[];
}

const ME = `query { me { roles permissions isRoot groupIds idpGroups managedGroupIds } }`;

const me = async (signed: Signed): Promise<Me> => {
  const { body } = await query(base, ME, signed);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data?.me as Me;
};

const update = (personId: string, change: Record<string, unknown>) =>
  control(base, { kind: "person-update", personId, ...change });

/** The next live event, within a second. */
const nextEvent = async (events: AsyncIterableIterator<LiveEvent>) => {
  const timeout = new Promise<never>((_, fail) =>
    setTimeout(() => {
      fail(new Error("no live event"));
    }, 1000),
  );
  const { value } = await Promise.race([events.next(), timeout]);
  return value as LiveEvent;
};

describe("the seeded people", () => {
  it("let every role be walked", async () => {
    const alice = await me(await signInAs(base, "user-alice"));
    assert.deepEqual(alice.roles, ["site-admin"]);
    assert.equal(alice.isRoot, true);
    assert.ok(
      (await me(await signInAs(base, "user-bob"))).permissions.includes(
        "policy.author",
      ),
    );
    assert.ok(
      (await me(await signInAs(base, "user-charlie"))).permissions.includes(
        "policy.approve",
      ),
    );
    const dave = await me(await signInAs(base, "user-dave"));
    assert.deepEqual(dave.roles, ["privacy-officer", "compliance-admin"]);
    assert.ok(dave.permissions.includes("compliance.manage"));
    const erin = await me(await signInAs(base, "user-erin"));
    assert.deepEqual(erin.roles, []);
    assert.deepEqual(erin.groupIds.toSorted(), ["group-1", "group-3"]);
    assert.deepEqual(erin.idpGroups, ["All staff", "Facilities team"]);
    const heidi = await me(await signInAs(base, "user-heidi"));
    assert.deepEqual(heidi.managedGroupIds, ["group-3"]);
    assert.deepEqual(heidi.idpGroups, ["All staff", "Facilities team"]);
    const grace = await me(await signInAs(base, "user-grace"));
    assert.deepEqual(grace.roles, ["template-admin"]);
    assert.ok(grace.permissions.includes("template.manage"));
  });

  it("include Grace, who signs in with her password", async () => {
    const grace = await signIn(base, "grace");
    assert.ok(grace.cookie.startsWith("steward_sid="));
    const frank = stewardData().people.find((p) => p.id === "user-frank");
    assert.equal(frank?.disabled, true);
    assert.deepEqual(frank?.roles, []);
  });

  it("show their groups and roles on /_mock", async () => {
    const people = (await (await fetch(`${base}/_mock/people`)).json()) as {
      groups: string[];
      id: string;
      roles: string[];
    }[];
    const heidi = people.find((p) => p.id === "user-heidi");
    assert.deepEqual(heidi?.groups, [
      "All staff",
      "Facilities team",
      "Manages Facilities team",
    ]);
    assert.deepEqual(people.find((p) => p.id === "user-alice")?.roles, [
      "site-admin",
      "root",
    ]);
  });
});

describe("an edit on /_mock", () => {
  it("applies to the next request, with no new sign-in, and is announced", async () => {
    const erin = await signInAs(base, "user-erin");
    const events = subscribe<LiveEvent>(LIVE_EVENTS);
    await update("user-erin", {
      groups: "All staff, Facilities team, Finance team, Manages Finance team",
      roles: "author",
    });
    const event = await nextEvent(events);
    await events.return?.();
    assert.equal(typeof event.at, "string");
    assert.deepEqual(
      { ...event, at: "" },
      {
        actorUserId: null,
        at: "",
        entityId: "user:user-erin",
        groupId: null,
        type: "user.permissions_changed",
      },
    );
    const now = await me(erin);
    assert.deepEqual(now.roles, ["author"]);
    assert.ok(now.permissions.includes("policy.author"));
    assert.deepEqual(now.groupIds.toSorted(), [
      "group-1",
      "group-2",
      "group-3",
    ]);
    assert.deepEqual(now.managedGroupIds, ["group-2"]);
    const managed = await call(base, erin, "MyManagedGroups");
    assert.deepEqual(
      (managed.data.myManagedGroups as { id: string }[]).map((g) => g.id),
      ["group-2"],
    );
  });

  it("is announced for a password change, and not for a name change", async () => {
    const events = subscribe<LiveEvent>(LIVE_EVENTS);
    await update("user-bob", { name: "Bob Renamed" });
    await update("user-bob", { password: "new-password" });
    const event = await nextEvent(events);
    await events.return?.();
    assert.equal(event.entityId, "user:user-bob");
  });

  it("writes the store as it is, without Steward's rules or audit", async () => {
    const audited = stewardData().audit.length;
    await update("user-alice", { roles: "site-admin" });
    assert.equal((await me(await signInAs(base, "user-alice"))).isRoot, false);
    assert.equal(stewardData().audit.length, audited);
  });
});

describe("Steward's own admin mutations", () => {
  it("write the same store, keeping the gateway's rules", async () => {
    const admin = await signInAs(base, "user-alice");
    const added = await call(base, admin, "AddUserToGroup", {
      groupId: "group-4",
      userId: "user-bob",
    });
    assert.equal(added.refused, undefined);
    const bob = stewardData().people.find(
      (p) => p.id === "user-bob",
    ) as unknown as {
      groups: string[];
    };
    assert.ok(bob.groups.includes("Approvers"));
    const removed = await call(base, admin, "RemoveUserFromGroup", {
      groupId: "group-4",
      userId: "user-bob",
    });
    assert.equal(removed.refused, undefined);
    assert.ok(!bob.groups.includes("Approvers"));

    const { body: stepUp } = await query(
      base,
      "mutation { requestStepUpOtp }",
      admin,
    );
    assert.equal(stepUp.errors, undefined);
    const { body: granted } = await query(
      base,
      'mutation { transferRoot(userId: "user-grace", otp: "123456") { isRoot roles } }',
      admin,
    );
    assert.deepEqual(granted.data?.transferRoot, {
      isRoot: true,
      roles: ["template-admin", "site-admin"],
    });
    const grace = stewardData().people.find((p) => p.id === "user-grace");
    assert.deepEqual(grace?.roles, ["template-admin", "root", "site-admin"]);
    const alice = stewardData().people.find((p) => p.id === "user-alice");
    assert.ok(alice?.roles.includes("site-admin"));
    assert.ok(!alice?.roles.includes("root"));
  });
});
