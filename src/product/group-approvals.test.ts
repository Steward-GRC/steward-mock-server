// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The seeded run with group seats: what workflowStatus reports for a mixed step, a half-voted
// group, a group nobody has voted in and a parallel step of users, and how a group moves it on.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

interface Status {
  currentStageIdx: number;
  stageAssignees: { groupId: null | string; state: string; userId: string }[][];
  stageNames: string[];
  stageUnitProgress: {
    approvals: number;
    groupId: string;
    groupName: string;
    pending: number;
    quorum: string;
    required: number;
    roster: number;
    status: string;
  }[][];
  status: string;
}

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

const statusOf = async (): Promise<Status> => {
  const answer = await call(
    base,
    await signInAs(base, "user-bob"),
    "WorkflowStatus",
    { policyVersionId: "version-3" },
  );
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data.workflowStatus as Status;
};

describe("the seeded run with group seats", () => {
  it("is in review on Records Retention, with a mixed first step and a fan after it", async () => {
    const status = await statusOf();
    assert.equal(status.status, "APPROVAL_STATUS_IN_REVIEW");
    assert.equal(status.currentStageIdx, 0);
    const first = status.stageAssignees[0]!;
    assert.ok(
      first.some((s) => s.groupId === null),
      "an individual seat",
    );
    assert.ok(
      first.some((s) => s.groupId !== null),
      "a group seat",
    );
    const second = status.stageAssignees[1]!;
    assert.ok(second.length >= 2 && second.every((s) => s.groupId === null));
    assert.deepEqual(status.stageUnitProgress[1], []);
  });

  it("reports a half-voted group and a group nobody has voted in", async () => {
    const units = (await statusOf()).stageUnitProgress[0]!;
    assert.equal(units.length, 2);
    const half = units.find((u) => u.approvals > 0)!;
    assert.deepEqual(
      [half.approvals, half.status, half.required < half.roster],
      [1, "PENDING", true],
    );
    assert.ok(half.approvals < half.required);
    const none = units.find((u) => u.approvals === 0)!;
    assert.deepEqual([none.status, none.pending], ["PENDING", none.roster]);
    for (const unit of units) {
      assert.ok(["all", "majority", "one"].includes(unit.quorum));
      assert.ok(unit.groupName.length > 0);
    }
  });

  it("counts a group's seats under its own groupId", async () => {
    const status = await statusOf();
    for (const unit of status.stageUnitProgress[0]!) {
      const seats = status.stageAssignees[0]!.filter(
        (s) => s.groupId === unit.groupId,
      );
      assert.equal(seats.length, unit.roster);
      assert.equal(
        seats.filter((s) => s.state === "approved").length,
        unit.approvals,
      );
    }
  });

  it("satisfies a group once enough members approve, and the run waits for the other group and the user", async () => {
    const status = await statusOf();
    const half = status.stageUnitProgress[0]!.find((u) => u.approvals > 0)!;
    const member = status.stageAssignees[0]!.find(
      (s) => s.groupId === half.groupId && s.state === "pending",
    )!;
    const signed = await signInAs(base, member.userId);
    const tasks = (await call(base, signed, "PendingTasks")).data
      .pendingTasks as {
      policyVersionId: string;
      runId: string;
      taskId: string;
    }[];
    const task = tasks.find((t) => t.policyVersionId === "version-3")!;
    const done = await call(base, signed, "SignalWorkflow", {
      ...task,
      comment: "Fine.",
      signal: "SIGNAL_TYPE_APPROVE",
    });
    assert.equal(done.refused, undefined);
    const after = await statusOf();
    const unit = after.stageUnitProgress[0]!.find(
      (u) => u.groupId === half.groupId,
    )!;
    assert.equal(unit.status, "SATISFIED");
    assert.equal(after.currentStageIdx, 0);
  });
});
