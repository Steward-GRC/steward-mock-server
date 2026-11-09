// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// AI jobs on the mock: a submitted draft, review, revision or enrichment job runs and returns a
// made-up result in the shape steward-ai writes, so the review sheet and the generate and revise
// pages can be walked. Real AI is tested on the appliance only. The simulation control turns the
// jobs off with Ask, and they then fail as when the ai service is down.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { setJobDuration } from "#product/resolvers/ai-jobs.ts";
import {
  control,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let bob: Signed;
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
  erin = await signInAs(base, "user-erin");
});

const SECTIONS = [
  { content: "Work use only.", key: "purpose", title: "Purpose" },
  { content: "", key: "scope", title: "Scope" },
];

const review = (signed: Signed) =>
  call(base, signed, "SubmitPolicyReview", {
    input: { policyId: "policy-2", sections: SECTIONS, versionId: "version-3" },
  });

describe("a review job on the mock", () => {
  it("returns a job id, then succeeds with findings for the thin and empty sections", async () => {
    const submitted = await review(bob);
    const { jobId } = submitted.data.submitPolicyReview as { jobId: string };
    assert.match(jobId, /^ai-job-\d+$/);
    const status = (await call(base, bob, "AiJob", { jobId })).data.aiJob as {
      phase: string;
      resultRef: string;
    };
    assert.equal(status.phase, "AI_JOB_PHASE_SUCCEEDED");
    const content = (
      await call(base, bob, "AiJobResultContent", {
        resultRef: status.resultRef,
      })
    ).data.aiJobResultContent as { operation: string; resultJson: string };
    assert.equal(content.operation, "REVIEW");
    const findings = JSON.parse(content.resultJson).findings as {
      sectionKey?: string;
      severity: string;
    }[];
    assert.deepEqual(
      findings.map((f) => [f.sectionKey, f.severity]),
      [
        ["purpose", "warn"],
        ["scope", "blocker"],
        [undefined, "info"],
      ],
    );
  });

  it("reads as running before it has run", async () => {
    setJobDuration(60_000);
    const { jobId } = (await review(bob)).data.submitPolicyReview as {
      jobId: string;
    };
    const status = (await call(base, bob, "AiJob", { jobId })).data.aiJob as {
      phase: string;
      resultRef: null | string;
    };
    assert.notEqual(status.phase, "AI_JOB_PHASE_SUCCEEDED");
    assert.equal(status.resultRef, null);
  });

  it("is the submitter's own: someone else does not find it", async () => {
    const { jobId } = (await review(bob)).data.submitPolicyReview as {
      jobId: string;
    };
    assert.equal(
      (await call(base, erin, "AiJob", { jobId })).refused,
      "NotFound",
    );
  });
});

describe("the other jobs on the mock", () => {
  it("drafts a section for each in the template", async () => {
    const { jobId } = (
      await call(base, bob, "SubmitDraftGeneration", {
        input: {
          brief: "How staff book travel.",
          sections: [{ key: "purpose", order: 0, title: "Purpose" }],
        },
      })
    ).data.submitDraftGeneration as { jobId: string };
    const status = (await call(base, bob, "AiJob", { jobId })).data.aiJob as {
      resultRef: string;
    };
    const content = (
      await call(base, bob, "AiJobResultContent", {
        resultRef: status.resultRef,
      })
    ).data.aiJobResultContent as { operation: string; resultJson: string };
    assert.equal(content.operation, "DRAFT");
    const sections = JSON.parse(content.resultJson).sections as {
      sectionKey: string;
    }[];
    assert.deepEqual(
      sections.map((s) => s.sectionKey),
      ["purpose"],
    );
  });

  it("revises the first section and leaves the rest", async () => {
    const { jobId } = (
      await call(base, bob, "SubmitPolicyRevision", {
        input: {
          instruction: "Shorten the booking window.",
          policyId: "policy-9",
          sections: [
            { content: "One.", key: "a", order: 0, title: "A" },
            { content: "Two.", key: "b", order: 1, title: "B" },
          ],
          versionId: "version-9",
        },
      })
    ).data.submitPolicyRevision as { jobId: string };
    const status = (await call(base, bob, "AiJob", { jobId })).data.aiJob as {
      resultRef: string;
    };
    const content = (
      await call(base, bob, "AiJobResultContent", {
        resultRef: status.resultRef,
      })
    ).data.aiJobResultContent as { resultJson: string };
    const sections = JSON.parse(content.resultJson).sections as {
      changed: boolean;
      sectionKey: string;
    }[];
    assert.deepEqual(
      sections.map((s) => [s.sectionKey, s.changed]),
      [
        ["a", true],
        ["b", false],
      ],
    );
  });
});

describe("the jobs with the simulation off", () => {
  it("fail as when the ai service is down, and aiHealth says so", async () => {
    await control(base, { kind: "ai-simulation", on: false });
    assert.equal((await review(bob)).refused, "INTERNAL");
    const health = (await call(base, bob, "AiHealth")).data.aiHealth as {
      available: boolean;
    };
    assert.equal(health.available, false);
  });
});
