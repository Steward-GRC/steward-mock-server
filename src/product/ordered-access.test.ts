// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Category access beyond the simulator, as steward-gateway now decides it with the ordered engine
// (steward-gateway#198, #200, #206): the policy read model (viewerCan.manage, the category read
// gate, root), the move gate (Manage on the source, Author on the target), the approver pool and
// the viewer's approver check, owners that must be people, and the group typeahead of the access
// picker.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  demoteAlice,
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

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const first = body.errors?.[0] as
    | { extensions: { code: string }; message?: string }
    | undefined;
  return {
    code: first?.extensions.code,
    // oxlint-disable-next-line typescript/no-explicit-any
    data: (body.data ?? {}) as Record<string, any>,
    message: first?.message,
  };
};

const as = (id: string) => signInAs(base, id);

const RULES = `mutation ($categoryId: ID!, $rules: [RaciRuleInput!]!) {
  setCategoryRuleset(categoryId: $categoryId, rules: $rules) { categoryId }
}`;

const row = (
  subjectKind: string,
  subjectReference: string,
  cells: Partial<
    Record<"ack" | "approve" | "author" | "manage" | "read", string>
  >,
) => ({
  ack: "BLANK",
  approve: "BLANK",
  author: "BLANK",
  manage: "BLANK",
  read: "BLANK",
  ...cells,
  subjectKind,
  subjectRef: subjectReference,
});

const setRules = async (categoryId: string, rules: unknown[]) => {
  const answer = await ask(await as("user-alice"), RULES, {
    categoryId,
    rules,
  });
  assert.equal(answer.code, undefined, answer.message);
};

const CAN = `query ($id: ID!) { policy(id: $id) { viewerCan { read edit submit approve manage contentObfuscated canBreakGlass } } }`;

const canOf = async (signed: Signed, id: string) =>
  (await ask(signed, CAN, { id })).data.policy?.viewerCan as
    | Record<string, boolean>
    | undefined;

describe("PolicyViewerCan.manage", () => {
  it("is the rows' Manage, an owner, or root", async () => {
    // policy-1 is in Expenses: the Finance team row allows Manage, Finance is owned by Alice.
    assert.equal(
      (await canOf(await as("user-dave"), "policy-1"))?.manage,
      true,
    );
    assert.equal(
      (await canOf(await as("user-erin"), "policy-1"))?.manage,
      false,
    );
    assert.equal(
      (await canOf(await as("user-alice"), "policy-1"))?.manage,
      true,
    );
    // policy-2 is in Records, below Information, which Charlie owns.
    assert.equal(
      (await canOf(await as("user-charlie"), "policy-2"))?.manage,
      true,
    );
  });

  it("is Manage alone: it does not make a person an approver", async () => {
    await setRules("category-expenses", [
      row("USER", "user-erin", { manage: "ALLOW" }),
      row("EVERYONE", "", { read: "ALLOW" }),
    ]);
    const can = await canOf(await as("user-erin"), "policy-1");
    assert.equal(can?.manage, true);
    assert.equal(can?.read, true);
    assert.equal(can?.edit, true, "Manage implies Author");
    assert.equal(can?.approve, false);
  });

  it("blocks a site admin who is not root, and never root", async () => {
    stewardData()
      .people.find((p) => p.id === "user-charlie")!
      .roles.push("site-admin");
    await setRules("category-expenses", [
      row("USER", "user-alice", { read: "DENY" }),
      row("USER", "user-charlie", { read: "DENY" }),
    ]);
    // Charlie is a site admin but not root: the deny applies and the policy reaches him
    // obfuscated, with break glass on offer.
    const charlie = await canOf(await as("user-charlie"), "policy-1");
    assert.equal(charlie?.read, true);
    assert.equal(charlie?.contentObfuscated, true);
    assert.equal(charlie?.canBreakGlass, true);
    // Alice is root: the deny is kept but never applied.
    const alice = await canOf(await as("user-alice"), "policy-1");
    assert.equal(alice?.contentObfuscated, false);
    assert.equal(alice?.canBreakGlass, false);
    assert.equal(alice?.read, true);
    assert.equal(alice?.manage, true);
    assert.equal(alice?.edit, true);
  });

  it("keeps root on a sensitive policy in full, with no break glass to open", async () => {
    // policy-2 is sensitive; Alice has no read-sensitive right, but she is root.
    const alice = await canOf(await as("user-alice"), "policy-2");
    assert.equal(alice?.contentObfuscated, false);
    assert.equal(alice?.canBreakGlass, false);
    demoteAlice();
    const demoted = await canOf(await as("user-alice"), "policy-2");
    assert.equal(demoted?.contentObfuscated, true);
    assert.equal(demoted?.canBreakGlass, true);
  });
});

describe("the category read gate", () => {
  it("lets everyone read where the category starts with Everyone: Read", async () => {
    // policy-6 is in Devices, below Information.
    assert.equal((await canOf(await as("user-grace"), "policy-6"))?.read, true);
  });

  it("hides a policy from someone no row lets read, root and an owner excepted", async () => {
    await setRules("category-information", []);
    const hidden = await ask(await as("user-grace"), CAN, { id: "policy-6" });
    assert.ok(hidden.code, "expected a refusal");
    assert.equal((await canOf(await as("user-alice"), "policy-6"))?.read, true);
    assert.equal(
      (await canOf(await as("user-charlie"), "policy-6"))?.read,
      true,
    );
  });
});

const MOVE = `mutation ($policyId: ID!, $to: ID!) {
  movePolicy(policyId: $policyId, homeCategoryId: $to) { id homeCategoryId }
}`;
const MOVE_MANY = `mutation ($ids: [ID!]!, $to: ID!) {
  movePolicies(policyIds: $ids, homeCategoryId: $to) { moved { policyId } }
}`;
const PREVIEW = `query ($ids: [ID!]!, $to: ID!) {
  previewMovePolicies(policyIds: $ids, homeCategoryId: $to) { items { policyId } }
}`;

describe("the move gate", () => {
  it("still lets a site admin move", async () => {
    const answer = await ask(await as("user-alice"), MOVE, {
      policyId: "policy-10",
      to: "category-travel",
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.equal(answer.data.movePolicy.homeCategoryId, "category-travel");
  });

  it("needs Manage on the document's category and Author on the target", async () => {
    const grace = await as("user-grace");
    const move = () =>
      ask(grace, MOVE, { policyId: "policy-10", to: "category-travel" });
    assert.equal((await move()).code, "PermissionDenied");

    await setRules("category-facilities", [
      row("USER", "user-grace", { manage: "ALLOW" }),
    ]);
    assert.equal(
      (await move()).code,
      "PermissionDenied",
      "no Author on Travel",
    );

    await setRules("category-travel", [
      row("USER", "user-grace", { author: "ALLOW" }),
    ]);
    const moved = await move();
    assert.equal(moved.code, undefined, moved.message);
    assert.equal(moved.data.movePolicy.homeCategoryId, "category-travel");
  });

  it("gates the preview and the bulk move the same way", async () => {
    const grace = await as("user-grace");
    const variables = { ids: ["policy-10"], to: "category-travel" };
    assert.equal(
      (await ask(grace, PREVIEW, variables)).code,
      "PermissionDenied",
    );
    assert.equal(
      (await ask(grace, MOVE_MANY, variables)).code,
      "PermissionDenied",
    );
    await setRules("category-facilities", [
      row("USER", "user-grace", { manage: "ALLOW" }),
    ]);
    await setRules("category-travel", [
      row("USER", "user-grace", { author: "ALLOW" }),
    ]);
    assert.equal((await ask(grace, PREVIEW, variables)).code, undefined);
    const moved = await ask(grace, MOVE_MANY, variables);
    assert.equal(moved.code, undefined, moved.message);
    assert.deepEqual(moved.data.movePolicies.moved, [
      { policyId: "policy-10" },
    ]);
  });
});

const APPROVERS = `query ($categoryId: ID!) { categoryApprovers(categoryId: $categoryId) { userId } }`;
const IS_APPROVER = `query { viewerIsApprover }`;

describe("categoryApprovers and viewerIsApprover", () => {
  it("lists the owners first, then everyone whose Approve allows", async () => {
    const answer = await ask(await as("user-alice"), APPROVERS, {
      categoryId: "category-expenses",
    });
    assert.deepEqual(
      answer.data.categoryApprovers.map((u: { userId: string }) => u.userId),
      ["user-alice", "user-charlie", "user-dave", "user-jonathan"],
    );
  });

  it("leaves root out unless a row allows Approve, and never lists a denied person", async () => {
    const alice = await as("user-alice");
    await setRules("category-leave", []);
    const none = await ask(alice, APPROVERS, { categoryId: "category-leave" });
    assert.deepEqual(none.data.categoryApprovers, []);
    await setRules("category-leave", [
      row("USER", "user-alice", { approve: "ALLOW" }),
      row("USER", "user-bob", { approve: "DENY" }),
      row("EVERYONE", "", { approve: "ALLOW" }),
    ]);
    const pool = await ask(alice, APPROVERS, { categoryId: "category-leave" });
    const ids = pool.data.categoryApprovers.map(
      (u: { userId: string }) => u.userId,
    );
    assert.equal(ids[0], "user-alice");
    assert.ok(!ids.includes("user-bob"));
    assert.ok(ids.includes("user-erin"));
  });

  it("is for site admins, and unknown categories are refused", async () => {
    assert.equal(
      (
        await ask(await as("user-erin"), APPROVERS, {
          categoryId: "category-expenses",
        })
      ).code,
      "PermissionDenied",
    );
    assert.equal(
      (
        await ask(await as("user-alice"), APPROVERS, {
          categoryId: "category-nowhere",
        })
      ).code,
      "NotFound",
    );
  });

  it("says whether the caller holds Approve in any category", async () => {
    // Erin is in the Facilities team, whose row allows Approve; Bob is in no approving row.
    assert.equal(
      (await ask(await as("user-erin"), IS_APPROVER)).data.viewerIsApprover,
      true,
    );
    assert.equal(
      (await ask(await as("user-bob"), IS_APPROVER)).data.viewerIsApprover,
      false,
    );
    // Charlie owns Information, and an owner approves.
    assert.equal(
      (await ask(await as("user-charlie"), IS_APPROVER)).data.viewerIsApprover,
      true,
    );
  });
});

const GOVERN = `mutation ($id: ID!, $owners: [ID!]!) {
  setCategoryGovernance(id: $id, owners: $owners, ackTriggers: NONE, reviewCadence: NONE) { id owners }
}`;

const owners = async (list: string[], id = "category-people") =>
  ask(await as("user-alice"), GOVERN, { id, owners: list });

describe("category owners are people", () => {
  it("refuses a group, Everyone, a blank and an unknown id", async () => {
    for (const bad of ["group:ops", "everyone:*", "", "user-nobody"]) {
      const answer = await owners(["user-bob", bad]);
      assert.equal(answer.code, "InvalidArgument", JSON.stringify(bad));
    }
    assert.match(
      (await owners(["group:ops"])).message ?? "",
      /category owners must be people/,
    );
    assert.match(
      (await owners(["user-nobody"])).message ?? "",
      /category owner user-nobody is not a user/,
    );
  });

  it("changes nothing when it refuses", async () => {
    await owners(["user-bob", "group:ops"]);
    const category = stewardData().categories.find(
      (c) => c.id === "category-people",
    );
    assert.deepEqual(category?.owners, []);
  });

  it("accepts people, and a repeated one once", async () => {
    const answer = await owners(["user-bob", "user-erin", "user-bob"]);
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(answer.data.setCategoryGovernance.owners, [
      "user-bob",
      "user-erin",
    ]);
  });
});

const SEARCH = `query ($query: String!, $limit: Int) {
  searchPlatformGroups(query: $query, limit: $limit) { id name parentId }
}`;

const names = (answer: { data: Record<string, unknown> }) =>
  (answer.data.searchPlatformGroups as { name: string }[]).map((g) => g.name);

describe("searchPlatformGroups", () => {
  it("finds groups at any depth by part of the name, case aside, sorted by name", async () => {
    const alice = await as("user-alice");
    assert.deepEqual(names(await ask(alice, SEARCH, { query: "TEAM" })), [
      "Facilities team",
      "Finance team",
    ]);
    assert.deepEqual(names(await ask(alice, SEARCH, { query: " ap " })), [
      "Approvers",
    ]);
  });

  it("is open to whoever edits category access, not only site admins", async () => {
    assert.equal(
      (await ask(await as("user-grace"), SEARCH, { query: "team" })).code,
      undefined,
    );
    assert.equal(
      (await ask(await as("user-erin"), SEARCH, { query: "team" })).code,
      "PermissionDenied",
    );
  });

  it("needs two characters once trimmed", async () => {
    const alice = await as("user-alice");
    for (const short of ["", "a", "  a  "])
      assert.equal(
        (await ask(alice, SEARCH, { query: short })).code,
        "InvalidArgument",
        JSON.stringify(short),
      );
  });

  it("takes a limit, 20 by default, 50 at most", async () => {
    const alice = await as("user-alice");
    assert.equal(
      names(await ask(alice, SEARCH, { limit: 1, query: "team" })).length,
      1,
    );
    assert.equal(
      names(await ask(alice, SEARCH, { limit: 0, query: "team" })).length,
      2,
    );
    const data = stewardData();
    for (let index = 0; index < 60; index++)
      data.platformGroups.push({
        id: `group-extra-${String(index)}`,
        name: `Extra group ${String(index).padStart(2, "0")}`,
        parentId: null,
      });
    assert.equal(
      names(await ask(alice, SEARCH, { query: "extra" })).length,
      20,
    );
    assert.equal(
      names(await ask(alice, SEARCH, { limit: 100, query: "extra" })).length,
      50,
    );
    assert.equal(
      names(await ask(alice, SEARCH, { limit: 5, query: "extra" })).length,
      5,
    );
  });
});
