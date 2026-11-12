// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Draft framing on the mock (steward-gateway#189, steward-ai#49): submitDraftGeneration and
// submitPolicyRevision take a framing (PLAIN, PROFESSIONAL, FORMAL or CUSTOM) and, for CUSTOM,
// the author's own wording. The gateway checks the wording before it submits a job, so a bad
// request fails the mutation and leaves no job; the mock does the same.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { setJobDuration } from "#product/resolvers/ai-jobs.ts";
import { checkFraming } from "#product/resolvers/ai.ts";
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

type Framing = { customFraming?: string; framing?: string };

const draft = (signed: Signed, framing: Framing, categoryId?: string) =>
  call(base, signed, "SubmitDraftGeneration", {
    input: {
      brief: "How staff book travel.",
      categoryId,
      sections: [{ key: "purpose", order: 0, title: "Purpose" }],
      ...framing,
    },
  });

const revision = (signed: Signed, framing: Framing) =>
  call(base, signed, "SubmitPolicyRevision", {
    input: {
      instruction: "Shorten the booking window.",
      policyId: "policy-9",
      sections: [{ content: "One.", key: "a", order: 0, title: "A" }],
      versionId: "version-9",
      ...framing,
    },
  });

const SUBMITS = [
  ["submitDraftGeneration", draft],
  ["submitPolicyRevision", revision],
] as const;

const jobNumber = (id: string) => Number(id.replace("ai-job-", ""));

describe("framing on the job submits", () => {
  for (const [field, submit] of SUBMITS) {
    describe(field, () => {
      it("takes no framing, which keeps the default tone", async () => {
        const result = await submit(bob, {});
        assert.match(
          (result.data[field] as { jobId: string }).jobId,
          /^ai-job-/,
        );
      });

      for (const framing of ["PLAIN", "PROFESSIONAL", "FORMAL"]) {
        it(`takes ${framing}`, async () => {
          const result = await submit(bob, { framing });
          assert.match(
            (result.data[field] as { jobId: string }).jobId,
            /^ai-job-/,
          );
        });
      }

      it("takes CUSTOM with wording, trimmed", async () => {
        const result = await submit(bob, {
          customFraming: "  Warm and direct, for new hires  ",
          framing: "CUSTOM",
        });
        assert.match(
          (result.data[field] as { jobId: string }).jobId,
          /^ai-job-/,
        );
      });

      it("takes CUSTOM wording of exactly 500 characters, counted as characters", async () => {
        const result = await submit(bob, {
          customFraming: "é".repeat(500),
          framing: "CUSTOM",
        });
        assert.match(
          (result.data[field] as { jobId: string }).jobId,
          /^ai-job-/,
        );
        const emoji = await submit(bob, {
          customFraming: "\u{1F600}".repeat(500),
          framing: "CUSTOM",
        });
        assert.match(
          (emoji.data[field] as { jobId: string }).jobId,
          /^ai-job-/,
        );
      });

      it("drops wording sent with another framing or none, without refusing", async () => {
        for (const framing of [{ framing: "PLAIN" }, {}]) {
          const result = await submit(bob, {
            customFraming: "ignore me",
            ...framing,
          });
          assert.match(
            (result.data[field] as { jobId: string }).jobId,
            /^ai-job-/,
          );
        }
      });

      for (const [name, wording, message] of [
        ["missing", undefined, "Custom framing needs wording."],
        ["blank", "  \n ", "Custom framing needs wording."],
        [
          "over 500 characters",
          "a".repeat(501),
          "Custom wording is 501 characters; the limit is 500.",
        ],
        [
          "over 500 characters in multi-byte letters",
          "é".repeat(501),
          "Custom wording is 501 characters; the limit is 500.",
        ],
        [
          "over 500 characters once trimmed",
          `  ${"a".repeat(600)}  `,
          "Custom wording is 600 characters; the limit is 500.",
        ],
      ] as const) {
        it(`refuses CUSTOM with ${name} wording as the gateway does, and starts no job`, async () => {
          const before = (await submit(bob, {})).data[field] as {
            jobId: string;
          };
          const refused = await submit(bob, {
            customFraming: wording,
            framing: "CUSTOM",
          });
          // steward-gateway#210: a coded business refusal the client shows, not the generic fault
          assert.equal(refused.refused, "InvalidArgument");
          assert.deepEqual(refused.error, { kind: "business", message });
          const after = (await submit(bob, {})).data[field] as {
            jobId: string;
          };
          assert.equal(jobNumber(after.jobId), jobNumber(before.jobId) + 1);
        });
      }

      it("refuses a framing the schema does not list", async () => {
        const refused = await submit(bob, { framing: "LOUD" });
        assert.ok(refused.refused, "expected a refusal");
        assert.equal(refused.data?.[field], undefined);
      });

      it("fails as when the ai service is down while the simulation is off, framing or not", async () => {
        await control(base, { kind: "ai-simulation", on: false });
        assert.equal(
          (await submit(bob, { framing: "PLAIN" })).refused,
          "INTERNAL",
        );
      });
    });
  }

  it("words an unknown framing as the gateway does, trimmed and upper-cased", () => {
    assert.throws(
      () => checkFraming({ framing: " loud " }),
      (error: unknown) => {
        const refused = error as {
          extensions: Record<string, unknown>;
          message: string;
        };
        assert.equal(refused.message, 'Unknown framing "LOUD".');
        assert.deepEqual(refused.extensions, {
          code: "InvalidArgument",
          kind: "business",
        });
        return true;
      },
    );
  });

  it("checks the category before the framing", async () => {
    const refused = await draft(
      erin,
      { framing: "CUSTOM" },
      "category-finance",
    );
    assert.equal(refused.refused, "PermissionDenied");
  });
});
