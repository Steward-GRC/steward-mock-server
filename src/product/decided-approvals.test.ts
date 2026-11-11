// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// decidedApprovals (steward-gateway#68, steward-workflow#45): the approvals inbox's "In progress"
// list, the caller's own approved or rejected seats on runs still in review, one entry per run,
// newest decision first. A resolved run drops out, a request for changes is not a decision, and a
// policy the caller can no longer read is left out.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Run, Seat } from "#product/data/policies.ts";

import { stewardData } from "#product/data.ts";
import {
  control,
  query,
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

const DECIDED = `{ decidedApprovals {
  policyVersionId policyTitle runId currentStageIdx stageCount decision decidedAt
} }`;

interface Entry {
  currentStageIdx: number;
  decidedAt: string;
  decision: string;
  policyTitle: string;
  policyVersionId: string;
  runId: string;
  stageCount: number;
}

const decidedFor = async (user: string): Promise<Entry[]> => {
  const signed = await signInAs(base, `user-${user}`);
  const { body } = await query(base, DECIDED, signed);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as { decidedApprovals: Entry[] }).decidedApprovals;
};

const seat = (
  taskId: string,
  userId: string,
  state = "pending",
  decidedAt: null | string = null,
  extra: Partial<Seat> = {},
): Seat => ({
  comment: state === "pending" ? null : "Noted.",
  decidedAt,
  state,
  taskId,
  userId,
  ...extra,
});

/** One run of Travel Booking (policy-3, version-4) with the given seats on its first of two stages. */
const putRun = (
  seats: Seat[],
  status = "APPROVAL_STATUS_IN_REVIEW",
  stageIndex = 0,
): Run => {
  const run: Run = {
    currentStageIdx: stageIndex,
    id: "run-decided",
    policyId: "policy-3",
    policyVersionId: "version-4",
    stages: [
      { name: "Review", quorum: "all", seats },
      { name: "Final", quorum: "one", seats: [seat("task-d9", "user-erin")] },
    ],
    status,
    submittedAt: "2026-11-01T00:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-2",
  };
  const data = stewardData();
  data.runs = data.runs.filter((r) => r.policyVersionId !== "version-4");
  data.runs.push(run);
  // Dave may not read the sensitive Travel Booking; make it readable so the cases stay on topic.
  const policy = data.policies.find((p) => p.id === "policy-3");
  if (policy) policy.sensitivity = "STANDARD";
  return run;
};

describe("decidedApprovals", () => {
  it("lists an open run the caller approved, with its title, stage position and decision", async () => {
    putRun([
      seat("task-d1", "user-dave", "approved", "2026-11-05T10:00:00Z"),
      seat("task-d2", "user-alice"),
    ]);
    assert.deepEqual(await decidedFor("dave"), [
      {
        currentStageIdx: 0,
        decidedAt: "2026-11-05T10:00:00Z",
        decision: "approved",
        policyTitle: "Travel Booking Procedure",
        policyVersionId: "version-4",
        runId: "run-decided",
        stageCount: 2,
      },
    ]);
  });

  it("lists a rejection that left the run open, and follows the run's stage", async () => {
    putRun(
      [seat("task-d1", "user-dave", "rejected", "2026-11-05T10:00:00Z")],
      "APPROVAL_STATUS_IN_REVIEW",
      1,
    );
    const [entry] = await decidedFor("dave");
    assert.equal(entry?.decision, "rejected");
    assert.equal(entry?.currentStageIdx, 1);
  });

  it("drops a run once it is published, rejected or withdrawn", async () => {
    for (const status of [
      "APPROVAL_STATUS_PUBLISHED",
      "APPROVAL_STATUS_REJECTED",
      "APPROVAL_STATUS_WITHDRAWN",
    ]) {
      putRun(
        [seat("task-d1", "user-dave", "approved", "2026-11-05T10:00:00Z")],
        status,
      );
      assert.deepEqual(await decidedFor("dave"), [], status);
    }
  });

  it("does not list another approver's decision", async () => {
    putRun([
      seat("task-d1", "user-dave", "approved", "2026-11-05T10:00:00Z"),
      seat("task-d2", "user-alice"),
    ]);
    assert.deepEqual(await decidedFor("alice"), []);
    assert.deepEqual(await decidedFor("erin"), []);
  });

  it("does not list a seat that only asked for changes", async () => {
    putRun([
      seat("task-d1", "user-dave", "pending", null, {
        changesRequested: { at: "2026-11-05T10:00:00Z", comment: "Rework." },
      }),
    ]);
    assert.deepEqual(await decidedFor("dave"), []);
  });

  it("gives one entry for a run where the caller holds two decided seats, the newest decision", async () => {
    putRun([
      seat("task-d1", "user-dave", "approved", "2026-11-05T10:00:00Z"),
      seat("task-d2", "user-dave", "rejected", "2026-11-06T10:00:00Z"),
    ]);
    const entries = await decidedFor("dave");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.decision, "rejected");
    assert.equal(entries[0]?.decidedAt, "2026-11-06T10:00:00Z");
  });

  it("does not count a decision from before the run started", async () => {
    putRun([seat("task-d1", "user-dave", "approved", "2026-10-01T10:00:00Z")]);
    assert.deepEqual(await decidedFor("dave"), []);
  });

  it("orders the entries by decidedAt, newest first", async () => {
    putRun([seat("task-d1", "user-dave", "approved", "2026-11-05T10:00:00Z")]);
    stewardData().runs.push({
      currentStageIdx: 0,
      id: "run-later",
      policyId: "policy-4",
      policyVersionId: "version-5",
      stages: [
        {
          name: "Review",
          quorum: "one",
          seats: [
            seat("task-d5", "user-dave", "approved", "2026-11-07T10:00:00Z"),
          ],
        },
      ],
      status: "APPROVAL_STATUS_IN_REVIEW",
      submittedAt: "2026-11-01T00:00:00Z",
      submittedBy: "user-bob",
      workflowDefId: "workflow-2",
    });
    const policy = stewardData().policies.find((p) => p.id === "policy-4");
    if (policy) policy.sensitivity = "STANDARD";
    assert.deepEqual(
      (await decidedFor("dave")).map((entry) => entry.runId),
      ["run-later", "run-decided"],
    );
  });

  it("drops an entry for a policy the caller cannot read", async () => {
    putRun([seat("task-d1", "user-dave", "approved", "2026-11-05T10:00:00Z")]);
    const policy = stewardData().policies.find((p) => p.id === "policy-3");
    assert.ok(policy);
    policy.sensitivity = "SENSITIVE";
    assert.deepEqual(await decidedFor("dave"), []);
    // Charlie may read sensitive policies, so the same decision shows for him
    stewardData()
      .runs.at(-1)
      ?.stages[0]?.seats.push(
        seat("task-d3", "user-charlie", "approved", "2026-11-05T11:00:00Z"),
      );
    assert.deepEqual(
      (await decidedFor("charlie")).filter(
        (entry) => entry.runId === "run-decided",
      ).length,
      1,
    );
  });

  it("refuses someone signed out", async () => {
    const { body } = await query(base, DECIDED);
    assert.ok(body.errors?.length);
  });

  it("gives the docs persona Charlie his 'In progress' list", async () => {
    await control(base, { kind: "start-state", state: "docs" });
    try {
      const entries = await decidedFor("charlie");
      assert.deepEqual(
        entries.map((entry) => [
          entry.policyTitle,
          entry.decision,
          entry.currentStageIdx,
          entry.stageCount,
        ]),
        [["Information Security Policy", "approved", 0, 2]],
      );
    } finally {
      await control(base, { kind: "start-state", state: "sample" });
    }
  });
});
