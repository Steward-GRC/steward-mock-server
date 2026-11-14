// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// swapAssignee and stageEligibleAssignees (steward-gateway#69, as the gateway and steward-workflow
// answer them): both are for a site admin or template admin; the pool is the workflow
// definition's approvers for the stage, in definition order; a swap needs a reason, two different
// people, a pending seat and, for someone outside the pool, an admin's acknowledgement; every
// refusal carries workflow's symbol, number and metadata, and each swap is audited.

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

// The seeded in-review run: Travel Booking Procedure, version-4, on the two-stage workflow. Its
// first stage seats Charlie (a named approver) and Alice (the category owner); the definition
// also names Dave, who holds no seat, so Charlie's seat can go to him.
const VERSION = "version-4";

const POOL = `query ($policyVersionId: ID!, $stageIndex: Int!) {
  stageEligibleAssignees(policyVersionId: $policyVersionId, stageIndex: $stageIndex) {
    stageIndex
    stageName
    assignees { id name email }
  }
}`;
const SWAP = `mutation ($input: SwapAssigneeInput!) {
  swapAssignee(input: $input) { newAssignmentId newSlaDeadlineAt }
}`;
const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) {
    stageAssignees { userId state roleLabel }
  }
}`;
const DECIDE = `mutation ($policyVersionId: ID!, $comment: String!) {
  signalWorkflow(policyVersionId: $policyVersionId, runId: "run-1", taskId: "task-1", signal: SIGNAL_TYPE_APPROVE, comment: $comment)
}`;

interface Failure {
  extensions: Record<string, unknown>;
  message: string;
}

const pool = async (as: string, policyVersionId = VERSION, stageIndex = 0) =>
  query(base, POOL, await signInAs(base, as), { policyVersionId, stageIndex });

const swap = async (as: string, input: Record<string, unknown>) =>
  query(base, SWAP, await signInAs(base, as), {
    input: {
      currentUserId: "user-charlie",
      newUserId: "user-dave",
      policyVersionId: VERSION,
      reason: "Charlie is away this week.",
      stageIndex: 0,
      ...input,
    },
  });

const decide = async (as: string) =>
  query(base, DECIDE, await signInAs(base, as), {
    comment: "Looks right.",
    policyVersionId: VERSION,
  });

const failure = (body: { errors?: unknown }): Failure => {
  const errors = body.errors as Failure[] | undefined;
  assert.ok(errors?.[0], "an error was expected");
  return errors[0];
};

const seatsOf = async (stageIndex = 0) => {
  const { body } = await query(
    base,
    STATUS,
    await signInAs(base, "user-alice"),
    { policyVersionId: VERSION },
  );
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  const status = body.data?.workflowStatus as {
    stageAssignees: {
      roleLabel: null | string;
      state: string;
      userId: string;
    }[][];
  };
  return status.stageAssignees[stageIndex] ?? [];
};

const swapAudit = () =>
  stewardData().audit.filter((entry) =>
    entry.action.startsWith("workflow.assignment.swapped"),
  );

describe("stageEligibleAssignees", () => {
  it("lists the stage's approvers in the workflow's order, as labels", async () => {
    const { body } = await pool("user-alice");
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const answer = body.data?.stageEligibleAssignees as {
      assignees: { email: null | string; id: string; name: string }[];
      stageIndex: number;
      stageName: string;
    };
    assert.equal(answer.stageIndex, 0);
    assert.equal(answer.stageName, "Review");
    assert.deepEqual(
      answer.assignees.map((a) => a.id),
      ["user-charlie", "user-alice", "user-dave"],
    );
    assert.equal(answer.assignees[0]?.name, "Charlie Approver");
    assert.equal(answer.assignees[0]?.email, "charlie@example.org");
  });

  it("answers a template admin and refuses anyone else", async () => {
    const admin = await pool("user-grace");
    assert.equal(admin.body.errors, undefined);
    for (const as of ["user-bob", "user-charlie", "user-erin"]) {
      const { body } = await pool(as);
      assert.equal(failure(body).extensions.code, "PermissionDenied", as);
      assert.equal(body.data, null, as);
    }
  });

  it("refuses a stage past the run with STAGE_INDEX_OUT_OF_RANGE and its counts", async () => {
    for (const stageIndex of [2, -1]) {
      const { body } = await pool("user-alice", VERSION, stageIndex);
      const { extensions } = failure(body);
      assert.equal(extensions.code, "STAGE_INDEX_OUT_OF_RANGE");
      assert.equal(extensions.codeNum, 6011);
      assert.equal(extensions.domain, "workflow");
      assert.equal(extensions.stage, String(stageIndex));
      assert.equal(extensions.stage_count, "2");
    }
  });

  it("refuses a version with no run with APPROVAL_RUN_NOT_FOUND", async () => {
    const { body } = await pool("user-alice", "version-1");
    const { extensions } = failure(body);
    assert.equal(extensions.code, "APPROVAL_RUN_NOT_FOUND");
    assert.equal(extensions.codeNum, 6012);
    assert.equal(extensions.policy_version_id, "version-1");
  });
});

describe("swapAssignee", () => {
  it("moves a pending seat to someone in the pool, audits it, and answers the new seat", async () => {
    const before = swapAudit().length;
    const { body } = await swap("user-alice", {});
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const result = body.data?.swapAssignee as {
      newAssignmentId: string;
      newSlaDeadlineAt: string;
    };
    assert.ok(result.newAssignmentId);
    assert.ok(!Number.isNaN(Date.parse(result.newSlaDeadlineAt)));
    assert.deepEqual(await seatsOf(), [
      { roleLabel: "Approver", state: "pending", userId: "user-dave" },
      { roleLabel: "Category owner", state: "pending", userId: "user-alice" },
    ]);
    const added = swapAudit().slice(before);
    assert.deepEqual(
      added.map((entry) => [entry.action, entry.actorUserId, entry.subject]),
      [
        [
          "workflow.assignment.swapped",
          "user-alice",
          `policy_version:${VERSION}`,
        ],
      ],
    );
  });

  it("gives the new holder the task and takes it from the old one", async () => {
    await swap("user-grace", {});
    const old = await decide("user-charlie");
    assert.equal(failure(old.body).extensions.code, "FailedPrecondition");
    const taken = await decide("user-dave");
    assert.equal(
      taken.body.errors,
      undefined,
      JSON.stringify(taken.body.errors),
    );
    assert.deepEqual(
      (await seatsOf()).map((s) => [s.userId, s.state]),
      [
        ["user-dave", "approved"],
        ["user-alice", "pending"],
      ],
    );
  });

  it("is for a site admin or template admin only", async () => {
    for (const as of ["user-bob", "user-charlie", "user-erin"]) {
      const { body } = await swap(as, {});
      assert.equal(failure(body).extensions.code, "PermissionDenied", as);
    }
    assert.equal(swapAudit().length, 0);
    assert.equal((await swap("user-grace", {})).body.errors, undefined);
  });

  it("requires a reason, both people, and two different ones", async () => {
    const cases: [Record<string, unknown>, string, number][] = [
      [{ reason: "" }, "SWAP_REASON_REQUIRED", 6004],
      [{ newUserId: "" }, "SWAP_USERS_REQUIRED", 6005],
      [{ currentUserId: "" }, "SWAP_USERS_REQUIRED", 6005],
      [{ newUserId: "user-charlie" }, "SWAP_SAME_USER", 6006],
    ];
    for (const [input, code, codeNumber] of cases) {
      const { body } = await swap("user-alice", input);
      const { extensions } = failure(body);
      assert.equal(extensions.code, code, JSON.stringify(input));
      assert.equal(extensions.codeNum, codeNumber, JSON.stringify(input));
      assert.equal(extensions.domain, "workflow");
    }
    assert.equal(swapAudit().length, 0);
  });

  it("refuses someone outside the pool, naming the stage and the candidate", async () => {
    const { body } = await swap("user-alice", { newUserId: "user-erin" });
    const { extensions, message } = failure(body);
    assert.equal(extensions.code, "SWAP_ASSIGNEE_NOT_ELIGIBLE");
    assert.equal(extensions.codeNum, 6010);
    assert.equal(extensions.stage, "0");
    assert.equal(extensions.stage_name, "Review");
    assert.equal(extensions.new_user_id, "user-erin");
    assert.equal(
      message,
      "That person isn't an eligible approver for stage 0 (Review).",
    );
    assert.equal(
      (await seatsOf()).some((s) => s.userId === "user-erin"),
      false,
    );
  });

  it("lets an admin pick someone outside the pool with the acknowledgement, and audits it as such", async () => {
    for (const as of ["user-alice", "user-grace"]) {
      startFresh();
      const refused = await swap(as, {
        newUserId: "user-erin",
        outOfEligibilityAck: false,
      });
      assert.equal(failure(refused.body).extensions.codeNum, 6010, as);
      const { body } = await swap(as, {
        newUserId: "user-erin",
        outOfEligibilityAck: true,
      });
      assert.equal(body.errors, undefined, JSON.stringify(body.errors));
      assert.equal((await seatsOf())[0]?.userId, "user-erin", as);
      assert.deepEqual(
        swapAudit().map((entry) => entry.action),
        ["workflow.assignment.swapped.out_of_eligibility"],
        as,
      );
    }
  });

  it("does not let the seat's own holder go outside the pool, acknowledged or not", async () => {
    const { body } = await swap("user-alice", {
      currentUserId: "user-alice",
      newUserId: "user-erin",
      outOfEligibilityAck: true,
    });
    assert.equal(failure(body).extensions.codeNum, 6010);
    const inside = await swap("user-alice", {
      currentUserId: "user-alice",
      newUserId: "user-dave",
    });
    assert.equal(
      inside.body.errors,
      undefined,
      JSON.stringify(inside.body.errors),
    );
    assert.deepEqual(
      swapAudit().map((entry) => entry.action),
      ["workflow.assignment.swapped"],
    );
  });

  it("refuses a person who holds no seat on the stage, and a seat already acted on", async () => {
    const none = await swap("user-alice", {
      currentUserId: "user-dave",
      newUserId: "user-charlie",
    });
    const missing = failure(none.body).extensions;
    assert.equal(missing.code, "SWAP_ASSIGNMENT_NOT_FOUND");
    assert.equal(missing.codeNum, 6008);
    assert.equal(missing.stage, "0");
    assert.equal(missing.current_user_id, "user-dave");

    await query(base, DECIDE, await signInAs(base, "user-charlie"), {
      comment: "Fine.",
      policyVersionId: VERSION,
    });
    const done = await swap("user-alice", {});
    const acted = failure(done.body).extensions;
    assert.equal(acted.code, "SWAP_ASSIGNMENT_NOT_PENDING");
    assert.equal(acted.codeNum, 6009);
    assert.equal(acted.state, "approved");
    assert.equal(acted.current_user_id, "user-charlie");
  });

  it("refuses a stage out of range and a version with no run", async () => {
    const range = await swap("user-alice", { stageIndex: 5 });
    assert.equal(failure(range.body).extensions.codeNum, 6011);
    const none = await swap("user-alice", { policyVersionId: "version-1" });
    assert.equal(failure(none.body).extensions.codeNum, 6012);
  });

  it("will not seat a person twice on one stage", async () => {
    const { body } = await swap("user-alice", { newUserId: "user-alice" });
    assert.equal(failure(body).extensions.code, "FailedPrecondition");
    assert.equal((await seatsOf()).length, 2);
    assert.equal(swapAudit().length, 0);
  });
});
