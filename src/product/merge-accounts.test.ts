// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Merging accounts on the mock (steward-web bug log #110): duplicate pairs to try it on, a preview
// that names what moves, and a merge that moves it, as steward-identity does: the source's
// policies, category rules, acknowledgements (without doubling one the target already gave),
// pending approval seats and per-policy overrides go to the target, the source is closed, and
// an audit entry says so.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { people } from "#product/resolvers/shared.ts";
import { control, startForTests, startFresh } from "#product/test-client.ts";
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

const alice = () => signInAs(base, "user-alice");
const preview = async (source: string, target: string) =>
  call(base, await alice(), "PreviewAccountMerge", {
    sourceUserId: source,
    targetUserId: target,
  });
const merge = async (source: string, target: string, confirm = false) =>
  call(base, await alice(), "MergeAccounts", {
    confirmPrivileged: confirm,
    sourceUserId: source,
    targetUserId: target,
  });

const byEmail = () => {
  const groups = new Map<string, string[]>();
  for (const person of people())
    groups.set(person.email, [...(groups.get(person.email) ?? []), person.id]);
  return [...groups.values()].filter((ids) => ids.length > 1);
};

describe("the seeded duplicates", () => {
  it("has a local and an SSO account for one person, and two people sharing a mailbox", () => {
    const pairs = byEmail();
    assert.equal(pairs.length, 2);
    const jon = people().find((p) => p.id === "user-jon")!;
    const jonathan = people().find((p) => p.id === "user-jonathan")!;
    assert.equal(jon.email, jonathan.email);
    assert.equal(jon.localAccount, true);
    assert.equal(jonathan.localAccount, false);
    assert.notEqual(jon.name, jonathan.name);
    const jane = people().find((p) => p.id === "user-jane")!;
    const john = people().find((p) => p.id === "user-johnsmith")!;
    assert.equal(jane.email, john.email);
    assert.notEqual(jane.name, john.name);
  });

  it("has a pair with one name and two different emails, which no email match would offer", () => {
    const pats = people().filter((p) => p.name === "Pat Quinn");
    assert.equal(pats.length, 2);
    assert.notEqual(pats[0]!.email, pats[1]!.email);
    assert.equal(byEmail().flat().includes("user-pat"), false);
  });
});

describe("previewAccountMerge", () => {
  it("names what would move and changes nothing", async () => {
    const answer = await preview("user-jon", "user-jonathan");
    assert.equal(answer.refused, undefined);
    const result = answer.data.previewAccountMerge as {
      counts: Record<string, number>;
      items: { kind: string }[];
      warnings: { code: string }[];
    };
    assert.ok(
      result.counts.acknowledgmentsMoved +
        result.counts.acknowledgmentsDeduped >
        0,
    );
    assert.ok(result.counts.raciGrants > 0);
    assert.ok(result.items.some((item) => item.kind === "ACKNOWLEDGMENT"));
    assert.equal(people().find((p) => p.id === "user-jon")!.deletedAt, null);
  });

  it("says an acknowledgement both gave is counted once", async () => {
    const answer = await preview("user-jon", "user-jonathan");
    const counts = (
      answer.data.previewAccountMerge as { counts: Record<string, number> }
    ).counts;
    assert.equal(counts.acknowledgmentsDeduped, 1);
  });

  it("warns when the emails differ", async () => {
    const answer = await preview("user-pat", "user-pat2");
    const warnings = (
      answer.data.previewAccountMerge as { warnings: { code: string }[] }
    ).warnings;
    assert.ok(warnings.some((w) => w.code === "EMAIL_DIFFERS"));
  });

  it("warns that a source holding roles keeps none of them on the target", async () => {
    const answer = await preview("user-jon", "user-jonathan");
    const warnings = (
      answer.data.previewAccountMerge as { warnings: { code: string }[] }
    ).warnings;
    assert.ok(warnings.some((w) => w.code === "ROLES_NOT_MOVED"));
  });
});

describe("mergeAccounts", () => {
  it("refuses an account into itself", async () => {
    const answer = await merge("user-jon", "user-jon");
    assert.ok(answer.refused);
  });

  it("asks for the privileged confirmation when the source holds roles", async () => {
    const answer = await merge("user-jon", "user-jonathan");
    assert.equal(answer.refused, "FailedPrecondition");
    assert.equal(people().find((p) => p.id === "user-jon")!.deletedAt, null);
  });

  it("moves policies, rules, acknowledgements and approval seats to the target and closes the source", async () => {
    const data = stewardData();
    const owned = data.policies.find((p) => p.ownerUserId === "user-jon");
    assert.ok(owned, "the seed gives Jon a policy");
    const before = data.acknowledgements.filter(
      (a) => a.userId === "user-jon",
    ).length;
    assert.ok(before > 0);
    const answer = await merge("user-jon", "user-jonathan", true);
    assert.equal(answer.refused, undefined);
    assert.equal(owned.ownerUserId, "user-jonathan");
    assert.equal(
      data.acknowledgements.some((a) => a.userId === "user-jon"),
      false,
    );
    const targets = data.acknowledgements.filter(
      (a) => a.userId === "user-jonathan",
    );
    assert.equal(
      new Set(targets.map((a) => a.policyVersionId)).size,
      targets.length,
    );
    assert.equal(
      data.categories.some(
        (c) =>
          c.authorRule.includes("user-jon") ||
          c.approverRule.includes("user-jon"),
      ),
      false,
    );
    const jon = people().find((p) => p.id === "user-jon")!;
    assert.equal(jon.mergedIntoUserId, "user-jonathan");
    assert.ok(jon.deletedAt);
    assert.equal(data.audit.at(-1)?.action, "user.accounts_merged");
  });

  it("returns the counts and a step list", async () => {
    const answer = await merge("user-jon", "user-jonathan", true);
    const result = answer.data.mergeAccounts as {
      counts: Record<string, number>;
      status: string;
      steps: { step: string }[];
    };
    assert.equal(result.status, "COMPLETED");
    assert.ok(result.steps.map((s) => s.step).includes("tombstone"));
    assert.ok(result.counts.policiesOwned >= 1);
  });

  it("will not merge into an account that is already closed", async () => {
    await merge("user-jon", "user-jonathan", true);
    const answer = await merge("user-jane", "user-jon");
    assert.ok(answer.refused);
  });

  it("is for a site admin only", async () => {
    const bob = await signInAs(base, "user-bob");
    const answer = await call(base, bob, "MergeAccounts", {
      sourceUserId: "user-jane",
      targetUserId: "user-johnsmith",
    });
    assert.ok(answer.refused);
  });
});

describe("the Add a duplicate button on /_mock", () => {
  it("adds a second account for a person: the same email, another spelling, and the other kind of sign-in", async () => {
    const before = people().length;
    await control(base, {
      kind: "add-duplicate-person",
      personId: "user-erin",
    });
    assert.equal(people().length, before + 1);
    const erin = people().find((p) => p.id === "user-erin")!;
    const copy = people().find((p) => p.id === "user-erin-dup1")!;
    assert.equal(copy.email, erin.email);
    assert.notEqual(copy.name, erin.name);
    assert.notEqual(copy.localAccount, erin.localAccount);
    assert.deepEqual(copy.roles, []);
  });

  it("numbers further duplicates of the same person", async () => {
    await control(base, {
      kind: "add-duplicate-person",
      personId: "user-erin",
    });
    await control(base, {
      kind: "add-duplicate-person",
      personId: "user-erin",
    });
    assert.ok(people().some((p) => p.id === "user-erin-dup2"));
  });

  it("makes a pair the merge page can use end to end", async () => {
    await control(base, {
      kind: "add-duplicate-person",
      personId: "user-erin",
    });
    const answer = await merge("user-erin-dup1", "user-erin");
    assert.equal(answer.refused, undefined);
  });
});
