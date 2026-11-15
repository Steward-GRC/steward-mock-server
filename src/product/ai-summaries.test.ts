// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// summarizeChanges and regenerateVersionSummary on the mock, as the gateway answers them
// (steward-gateway#191): each returns a jobId, and the result is read through aiJob and
// aiJobResultContent as {"scope","bullets"|"summaryText","generatedAt","cached"}. The reader's
// checks come first: an unreadable version or a draft the caller cannot read is NotFound, an
// obfuscated read is PermissionDenied, versions with no differences or a version with no text is
// FailedPrecondition. With AI off or at its limit the submit fails like the other submits.
// Replacing a stored summary (regenerateVersionSummary, summarizeChanges with regenerate) also
// needs Author on the version's policy (steward-gateway#206); policyVersionSummary then serves
// the stored version summary to anyone who reads the version in full.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { setJobDuration } from "#product/resolvers/ai-jobs.ts";
import {
  control,
  demoteAlice,
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let bob: Signed;
let alice: Signed;
let erin: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  setJobDuration(0);
  bob = await signInAs(base, "user-bob");
  alice = await signInAs(base, "user-alice");
  erin = await signInAs(base, "user-erin");
});

const CHANGES = `mutation($from: ID!, $to: ID!, $regenerate: Boolean) {
  summarizeChanges(fromVersionId: $from, toVersionId: $to, regenerate: $regenerate) { jobId }
}`;
const REGENERATE = `mutation($id: ID!) { regenerateVersionSummary(versionId: $id) { jobId } }`;
const STATUS = `query($jobId: ID!) { aiJob(jobId: $jobId) { phase resultRef } }`;
const CONTENT = `query($resultRef: String!) { aiJobResultContent(resultRef: $resultRef) { operation resultJson } }`;

// Expense Claims: version-1 and version-10 differ, version-2 is the published one.
const changes = (
  signed: Signed,
  from: string,
  to: string,
  regenerate?: boolean,
) => query(base, CHANGES, signed, { from, regenerate, to });
const regenerate = (signed: Signed, id: string) =>
  query(base, REGENERATE, signed, { id });

const codeOf = (answer: Awaited<ReturnType<typeof query>>) =>
  answer.body.errors?.[0]?.extensions.code;

/** Runs a submit to its end and returns the parsed result the reader would fetch. */
const resultOf = async (
  signed: Signed,
  answer: Awaited<ReturnType<typeof query>>,
  field: "regenerateVersionSummary" | "summarizeChanges",
) => {
  assert.equal(codeOf(answer), undefined, JSON.stringify(answer.body));
  const { jobId } = (answer.body.data as Record<string, { jobId: string }>)[
    field
  ] as { jobId: string };
  assert.match(jobId, /^ai-job-\d+$/);
  const status = (await query(base, STATUS, signed, { jobId })).body.data
    ?.aiJob as { phase: string; resultRef: string };
  assert.equal(status.phase, "AI_JOB_PHASE_SUCCEEDED");
  const content = (
    await query(base, CONTENT, signed, { resultRef: status.resultRef })
  ).body.data?.aiJobResultContent as { operation: string; resultJson: string };
  assert.equal(content.operation, "SUMMARIZE");
  return JSON.parse(content.resultJson) as {
    bullets?: string[];
    cached: boolean;
    generatedAt: string;
    scope: string;
    summaryText?: string;
  };
};

/** Erin, given the Author rule on the category that holds Expense Claims (not its owner). */
const authorOnly = async (): Promise<Signed> => {
  const policy = stewardData().policies.find((p) => p.id === "policy-1");
  assert.ok(policy);
  assert.notEqual(policy.ownerUserId, "user-erin");
  const category = stewardData().categories.find(
    (c) => c.id === policy.homeCategoryId,
  );
  assert.ok(category);
  category.authorRule.push("user-erin");
  return erin;
};

describe("summarizeChanges", () => {
  it("returns a job whose result lists the changes as bullets", async () => {
    const result = await resultOf(
      bob,
      await changes(bob, "version-1", "version-10"),
      "summarizeChanges",
    );
    assert.equal(result.scope, "changes");
    assert.equal(result.cached, false);
    assert.ok(!Number.isNaN(Date.parse(result.generatedAt)));
    assert.equal(result.summaryText, undefined);
    assert.ok(Array.isArray(result.bullets) && result.bullets.length > 0);
    assert.ok(result.bullets.every((b) => b.startsWith("Simulated")));
  });

  it("answers a repeat from the stored summary unless regenerate is true", async () => {
    const first = await resultOf(
      bob,
      await changes(bob, "version-1", "version-10"),
      "summarizeChanges",
    );
    assert.equal(first.cached, false);
    const again = await resultOf(
      bob,
      await changes(bob, "version-1", "version-10"),
      "summarizeChanges",
    );
    assert.equal(again.cached, true);
    assert.deepEqual(again.bullets, first.bullets);
    const forced = await resultOf(
      bob,
      await changes(bob, "version-1", "version-10", true),
      "summarizeChanges",
    );
    assert.equal(forced.cached, false);
    const other = await resultOf(
      bob,
      await changes(bob, "version-10", "version-2"),
      "summarizeChanges",
    );
    assert.equal(other.cached, false);
  });

  it("is open to a reader who is not the author unless regenerate is true", async () => {
    const result = await resultOf(
      erin,
      await changes(erin, "version-1", "version-10"),
      "summarizeChanges",
    );
    assert.equal(result.scope, "changes");
    assert.equal(
      codeOf(await changes(erin, "version-1", "version-10", true)),
      "PermissionDenied",
    );
    assert.equal(
      codeOf(await changes(erin, "version-1", "version-10", false)),
      undefined,
    );
  });

  it("lets the policy's owner, a category author and root regenerate", async () => {
    for (const signed of [bob, await authorOnly()]) {
      const result = await resultOf(
        signed,
        await changes(signed, "version-1", "version-10", true),
        "summarizeChanges",
      );
      assert.equal(result.cached, false);
    }
  });

  it("checks the read before the author right", async () => {
    assert.equal(
      codeOf(await changes(erin, "version-1", "version-4", true)),
      "NotFound",
    );
  });

  it("refuses a version that does not exist, or a draft the caller cannot read, as NotFound", async () => {
    assert.equal(
      codeOf(await changes(bob, "version-1", "nowhere")),
      "NotFound",
    );
    assert.equal(
      codeOf(await changes(erin, "version-1", "version-4")),
      "NotFound",
    );
  });

  it("refuses an obfuscated read as PermissionDenied", async () => {
    demoteAlice();
    // Alice is a site admin without the sensitive-read right: version-9 reads obfuscated.
    assert.equal(
      codeOf(await changes(alice, "version-9", "version-9")),
      "PermissionDenied",
    );
  });

  it("refuses versions with no differences as FailedPrecondition", async () => {
    assert.equal(
      codeOf(await changes(bob, "version-2", "version-2")),
      "FailedPrecondition",
    );
  });

  it("fails like the other submits when AI is off or at its limit, after the read checks", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    assert.equal(
      codeOf(await changes(bob, "version-1", "version-10")),
      "FailedPrecondition",
    );
    assert.equal(
      codeOf(await changes(bob, "version-1", "nowhere")),
      "NotFound",
    );
    await control(base, { kind: "ai-limit", reached: false });
    await control(base, { kind: "ai-simulation", on: false });
    assert.equal(
      codeOf(await changes(bob, "version-1", "version-10")),
      "INTERNAL",
    );
    assert.equal(
      codeOf(await changes(bob, "version-1", "nowhere")),
      "NotFound",
    );
  });
});

describe("regenerateVersionSummary", () => {
  it("returns a job whose result is the version's summary text, never cached", async () => {
    for (let round = 0; round < 2; round += 1) {
      const result = await resultOf(
        bob,
        await regenerate(bob, "version-2"),
        "regenerateVersionSummary",
      );
      assert.equal(result.scope, "version");
      assert.equal(result.cached, false);
      assert.ok(!Number.isNaN(Date.parse(result.generatedAt)));
      assert.equal(result.bullets, undefined);
      assert.match(result.summaryText ?? "", /^- /);
    }
  });

  it("needs Author: a reader who is not the author is refused, an owner or category author is not", async () => {
    assert.equal(
      codeOf(await regenerate(erin, "version-2")),
      "PermissionDenied",
    );
    const author = await authorOnly();
    const result = await resultOf(
      author,
      await regenerate(author, "version-2"),
      "regenerateVersionSummary",
    );
    assert.equal(result.scope, "version");
  });

  it("checks the author right before the version has text", async () => {
    const empty = stewardData().versions.find((v) => v.id === "version-2");
    assert.ok(empty);
    empty.contentJson = "";
    assert.equal(
      codeOf(await regenerate(erin, "version-2")),
      "PermissionDenied",
    );
  });

  it("refuses an unknown version, or a draft the caller cannot read, as NotFound", async () => {
    assert.equal(codeOf(await regenerate(bob, "nowhere")), "NotFound");
    assert.equal(codeOf(await regenerate(erin, "version-4")), "NotFound");
  });

  it("refuses an obfuscated read as PermissionDenied", async () => {
    demoteAlice();
    assert.equal(
      codeOf(await regenerate(alice, "version-9")),
      "PermissionDenied",
    );
  });

  it("refuses a version with no text as FailedPrecondition", async () => {
    const empty = stewardData().versions.find((v) => v.id === "version-2");
    assert.ok(empty);
    empty.contentJson = "";
    assert.equal(
      codeOf(await regenerate(bob, "version-2")),
      "FailedPrecondition",
    );
  });

  it("fails like the other submits when AI is off or at its limit, after the read checks", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    assert.equal(
      codeOf(await regenerate(bob, "version-2")),
      "FailedPrecondition",
    );
    assert.equal(codeOf(await regenerate(bob, "nowhere")), "NotFound");
    await control(base, { kind: "ai-limit", reached: false });
    await control(base, { kind: "ai-simulation", on: false });
    assert.equal(codeOf(await regenerate(bob, "version-2")), "INTERNAL");
    assert.equal(codeOf(await regenerate(bob, "nowhere")), "NotFound");
  });
});

const STORED = `query($id: ID!) { policyVersionSummary(versionId: $id) { summaryText generatedAt } }`;
const stored = (signed: Signed, id: string) =>
  query(base, STORED, signed, { id });

describe("policyVersionSummary", () => {
  it("is null until a summary has been stored", async () => {
    const answer = await stored(erin, "version-2");
    assert.equal(codeOf(answer), undefined);
    assert.equal(answer.body.data?.policyVersionSummary, null);
  });

  it("serves the summary regenerateVersionSummary stored, to any reader", async () => {
    const result = await resultOf(
      bob,
      await regenerate(bob, "version-2"),
      "regenerateVersionSummary",
    );
    const answer = await stored(erin, "version-2");
    assert.equal(codeOf(answer), undefined);
    assert.deepEqual(answer.body.data?.policyVersionSummary, {
      generatedAt: result.generatedAt,
      summaryText: result.summaryText,
    });
    // another version has none
    assert.equal(
      (await stored(erin, "version-1")).body.data?.policyVersionSummary,
      null,
    );
  });

  it("replaces the stored summary on the next regenerate", async () => {
    await resultOf(
      bob,
      await regenerate(bob, "version-2"),
      "regenerateVersionSummary",
    );
    const version = stewardData().versions.find((v) => v.id === "version-2");
    assert.ok(version);
    version.contentJson = JSON.stringify({
      sections: { purpose: "Brand new wording" },
    });
    const second = await resultOf(
      bob,
      await regenerate(bob, "version-2"),
      "regenerateVersionSummary",
    );
    const answer = await stored(erin, "version-2");
    assert.equal(
      (answer.body.data?.policyVersionSummary as { summaryText: string })
        .summaryText,
      second.summaryText,
    );
  });

  it("is not stored by summarizeChanges, nor by a refused regenerate", async () => {
    await resultOf(
      bob,
      await changes(bob, "version-1", "version-10", true),
      "summarizeChanges",
    );
    await regenerate(erin, "version-2");
    assert.equal(
      (await stored(bob, "version-2")).body.data?.policyVersionSummary,
      null,
    );
  });

  it("is null for a version the caller cannot read, or reads obfuscated", async () => {
    await resultOf(
      bob,
      await regenerate(bob, "version-2"),
      "regenerateVersionSummary",
    );
    assert.equal(
      (await stored(erin, "version-4")).body.data?.policyVersionSummary,
      null,
    );
    assert.equal(
      (await stored(erin, "nowhere")).body.data?.policyVersionSummary,
      null,
    );
    demoteAlice();
    assert.equal(
      (await stored(alice, "version-9")).body.data?.policyVersionSummary,
      null,
    );
  });

  it("answers null while the ai service is unreachable", async () => {
    await resultOf(
      bob,
      await regenerate(bob, "version-2"),
      "regenerateVersionSummary",
    );
    await control(base, { kind: "ai-simulation", on: false });
    assert.equal(
      (await stored(bob, "version-2")).body.data?.policyVersionSummary,
      null,
    );
  });

  it("needs a signed-in caller", async () => {
    const answer = await query(base, STORED, undefined, { id: "version-2" });
    assert.ok(answer.body.errors?.length);
  });
});
