// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// summarizeChanges and regenerateVersionSummary on the mock, as the gateway answers them
// (steward-gateway#191): each returns a jobId, and the result is read through aiJob and
// aiJobResultContent as {"scope","bullets"|"summaryText","generatedAt","cached"}. The reader's
// checks come first: an unreadable version or a draft the caller cannot read is NotFound, an
// obfuscated read is PermissionDenied, versions with no differences or a version with no text is
// FailedPrecondition. With AI off or at its limit the submit fails like the other submits. There
// is no author-only rule.

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

  it("is open to a reader who is not the author", async () => {
    const result = await resultOf(
      erin,
      await changes(erin, "version-1", "version-10"),
      "summarizeChanges",
    );
    assert.equal(result.scope, "changes");
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

  it("is open to a reader who is not the author", async () => {
    const result = await resultOf(
      erin,
      await regenerate(erin, "version-2"),
      "regenerateVersionSummary",
    );
    assert.equal(result.scope, "version");
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
