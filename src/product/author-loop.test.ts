// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The author's loop, through /query as the web drives it: the reader follows a policy through
// create, save, publish and discard, a draft goes to review with submitWorkflow, and the run
// moves on with each decision until the last approval publishes it or a rejection ends it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { stewardData } from "#product/data.ts";
import {
  EXPENSE_CLAIMS_NUMBER,
  TRAVEL_BOOKING_NUMBER,
} from "#product/data/policies.ts";
import { query, startForTests, startFresh } from "#product/test-client.ts";
import { type Answer, call, signInAs } from "#product/web-client.ts";

/** steward-gateway's submit for review; steward-web has no operation for it yet. */
const SUBMIT = `mutation SubmitWorkflow(
  $policyVersionId: ID!
  $policyId: ID!
  $categoryId: ID!
  $ancestorCategoryIds: [ID!]!
) {
  submitWorkflow(
    policyVersionId: $policyVersionId
    policyId: $policyId
    categoryId: $categoryId
    ancestorCategoryIds: $ancestorCategoryIds
  ) {
    runId
  }
}`;

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

const as = (personId: string) => signInAs(base, personId);

interface PolicyRow {
  currentDraftVersionId: null | string;
  currentPublishedVersionId: null | string;
  currentVersionNo: null | number;
  currentVersionStatus: null | string;
  id: string;
  number: string;
}

const byNumber = async (signed: Signed, number: string) => {
  const answer = await call(base, signed, "PolicyByNumber", { number });
  return { ...answer, policy: answer.data.policyByNumber as PolicyRow };
};

const ok = (answer: Answer) => {
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data;
};

const submit = async (
  signed: Signed,
  policy: { homeCategoryId?: string; id: string },
  policyVersionId: string,
) => {
  const { body } = await query(base, SUBMIT, signed, {
    ancestorCategoryIds: [],
    categoryId: policy.homeCategoryId ?? "",
    policyId: policy.id,
    policyVersionId,
  });
  return {
    refused: body.errors?.[0]?.extensions.code,
    runId: (body.data?.submitWorkflow as { runId: string } | undefined)?.runId,
  };
};

const status = async (signed: Signed, policyVersionId: string) =>
  ok(await call(base, signed, "WorkflowStatus", { policyVersionId }))
    .workflowStatus as {
    currentStageIdx: number;
    stageAssignees: { state: string; userId: string }[][];
    status: string;
  };

const tasksOf = async (signed: Signed) =>
  ok(await call(base, signed, "PendingTasks")).pendingTasks as {
    policyVersionId: string;
    runId: string;
    taskId: string;
  }[];

const decide = (
  signed: Signed,
  task: { policyVersionId: string; runId: string; taskId: string },
  signal: "SIGNAL_TYPE_APPROVE" | "SIGNAL_TYPE_REJECT",
  comment = "Reviewed.",
) => call(base, signed, "SignalWorkflow", { ...task, comment, signal });

const LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [{ text: "Book travel through the portal.", type: "text" }],
        type: "paragraph",
      },
    ],
    type: "root",
  },
});

const createTravel = async (author: Signed, documentType = "POLICY") =>
  ok(
    await call(base, author, "CreatePolicy", {
      documentType,
      homeCategoryId:
        documentType === "POLICY" ? "category-expenses" : "category-conduct",
      sensitivity: "STANDARD",
      title: "Travel Booking",
    }),
  ).createPolicy as { homeCategoryId: string } & PolicyRow;

describe("the reader follows the author's writes", () => {
  it("numbers a new policy and procedure the way steward-core does", async () => {
    const author = await as("user-bob");
    assert.equal((await createTravel(author)).number, "POL-EXPENSES-000003");
    assert.equal(
      (await createTravel(author, "PROCEDURE")).number,
      "PRC-CONDUCT-000002",
    );
  });

  it("shows a new draft to its author only, then the published policy to everyone", async () => {
    const author = await as("user-bob");
    const reader = await as("user-erin");
    const created = await createTravel(author);
    const draft = await byNumber(author, created.number);
    assert.equal(draft.policy.currentVersionStatus, "DRAFT");
    assert.equal(draft.policy.currentVersionNo, 0);
    assert.equal((await byNumber(reader, created.number)).refused, "NotFound");

    ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: created.id,
      }),
    );
    ok(await call(base, author, "PublishDraft", { policyId: created.id }));

    const published = await byNumber(reader, created.number);
    assert.equal(published.policy.currentVersionStatus, "PUBLISHED");
    assert.equal(published.policy.currentVersionNo, 1);
    assert.equal(published.policy.currentDraftVersionId, null);
    const version = ok(
      await call(base, reader, "PolicyVersion", {
        id: published.policy.currentPublishedVersionId,
      }),
    ).policyVersion as { contentJson: string };
    assert.equal(version.contentJson, LEXICAL);
  });

  it("keeps the published version in the reader while a new draft is saved and discarded", async () => {
    const author = await as("user-bob");
    const reader = await as("user-erin");
    const saved = ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: "policy-1",
      }),
    ).saveDraft as { id: string };
    const mine = await byNumber(author, EXPENSE_CLAIMS_NUMBER);
    assert.equal(mine.policy.currentDraftVersionId, saved.id);
    const theirs = await byNumber(reader, EXPENSE_CLAIMS_NUMBER);
    assert.equal(theirs.policy.currentDraftVersionId, null);
    assert.equal(theirs.policy.currentVersionNo, 3);

    ok(await call(base, author, "DiscardDraft", { policyId: "policy-1" }));
    const discarded = await byNumber(author, EXPENSE_CLAIMS_NUMBER);
    assert.equal(discarded.policy.currentDraftVersionId, null);
    assert.equal(discarded.policy.currentVersionStatus, "PUBLISHED");
  });
});

describe("submitting a draft for review", () => {
  it("starts a run on the home category's workflow and gives the approver a task", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const created = await createTravel(author);
    const draftId = created.currentDraftVersionId ?? "";
    const { refused, runId } = await submit(author, created, draftId);
    assert.equal(refused, undefined);
    assert.ok(runId);

    const run = await status(author, draftId);
    assert.equal(run.status, "APPROVAL_STATUS_IN_REVIEW");
    assert.deepEqual(
      run.stageAssignees.map((seats) => seats.map((s) => s.userId)),
      [["user-charlie"]],
    );
    const row = await byNumber(author, created.number);
    assert.equal(row.policy.currentVersionStatus, "IN_REVIEW");
    assert.ok(
      (await tasksOf(approver)).some((t) => t.policyVersionId === draftId),
    );
  });

  it("refuses someone who can't edit the policy", async () => {
    const reader = await as("user-erin");
    const { refused } = await submit(
      reader,
      { homeCategoryId: "category-records", id: "policy-2" },
      "version-3",
    );
    assert.equal(refused, "PermissionDenied");
  });

  it("refuses a policy whose category has no workflow", async () => {
    const admin = await as("user-alice");
    const { refused } = await submit(
      admin,
      { homeCategoryId: "category-travel", id: "policy-5" },
      "version-6",
    );
    assert.equal(refused, "FailedPrecondition");
  });
});

describe("deciding an approval", () => {
  it("publishes the policy on the last approval", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const reader = await as("user-erin");
    ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: "policy-1",
      }),
    );
    const draftId =
      (await byNumber(author, EXPENSE_CLAIMS_NUMBER)).policy
        .currentDraftVersionId ?? "";
    await submit(
      author,
      { homeCategoryId: "category-expenses", id: "policy-1" },
      draftId,
    );
    const task = (await tasksOf(approver)).find(
      (t) => t.policyVersionId === draftId,
    );
    assert.ok(task);
    ok(await decide(approver, task, "SIGNAL_TYPE_APPROVE"));

    assert.equal(
      (await status(author, draftId)).status,
      "APPROVAL_STATUS_PUBLISHED",
    );
    const published = await byNumber(reader, EXPENSE_CLAIMS_NUMBER);
    assert.equal(published.policy.currentPublishedVersionId, draftId);
    assert.equal(published.policy.currentVersionNo, 4);
    assert.ok(
      !(await tasksOf(approver)).some((t) => t.policyVersionId === draftId),
    );
  });

  it("moves a multi-stage run on stage by stage", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const admin = await as("user-alice");
    const first = { policyVersionId: "version-4", runId: "run-1" };

    // Review wants a majority of its two approvers.
    ok(
      await decide(
        approver,
        { ...first, taskId: "task-1" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    assert.equal((await status(author, "version-4")).currentStageIdx, 0);
    ok(
      await decide(
        admin,
        { ...first, taskId: "task-2" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    const second = await status(author, "version-4");
    assert.equal(second.currentStageIdx, 1);
    assert.equal(second.status, "APPROVAL_STATUS_IN_REVIEW");
    assert.equal(
      (await byNumber(author, TRAVEL_BOOKING_NUMBER)).policy
        .currentVersionStatus,
      "IN_REVIEW",
    );

    ok(
      await decide(
        admin,
        { ...first, taskId: "task-3" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    assert.equal(
      (await status(author, "version-4")).status,
      "APPROVAL_STATUS_PUBLISHED",
    );
    const policy = (await byNumber(author, TRAVEL_BOOKING_NUMBER)).policy;
    assert.equal(policy.currentPublishedVersionId, "version-4");
    assert.equal(policy.currentVersionStatus, "PUBLISHED");
    assert.equal(policy.currentVersionNo, 1);
  });

  it("ends the run as soon as the approvals still possible cannot reach the quorum", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const admin = await as("user-alice");
    const task = {
      policyVersionId: "version-4",
      runId: "run-1",
      taskId: "task-1",
    };
    // the Review stage is a majority of two seats, so it needs both: one reject makes that
    // impossible, and the run ends with it (the other seat's task goes too)
    ok(
      await decide(
        approver,
        task,
        "SIGNAL_TYPE_REJECT",
        "The labels need examples.",
      ),
    );
    assert.equal(
      (await status(author, "version-4")).status,
      "APPROVAL_STATUS_REJECTED",
    );
    const policy = (await byNumber(author, TRAVEL_BOOKING_NUMBER)).policy;
    assert.equal(policy.currentVersionStatus, "REJECTED");
    assert.equal(policy.currentPublishedVersionId, null);
    assert.ok(
      !(await tasksOf(admin)).some((t) => t.policyVersionId === "version-4"),
    );
  });

  it("ends it on a reject after an approve when that leaves the quorum out of reach", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const admin = await as("user-alice");
    const first = { policyVersionId: "version-4", runId: "run-1" };
    ok(
      await decide(
        approver,
        { ...first, taskId: "task-1" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    ok(
      await decide(
        admin,
        { ...first, taskId: "task-2" },
        "SIGNAL_TYPE_REJECT",
        "No.",
      ),
    );
    assert.equal(
      (await status(author, "version-4")).status,
      "APPROVAL_STATUS_REJECTED",
    );
  });

  it("counts a rejection as a vote while the quorum can still be reached", async () => {
    // a third seat on the Review stage: a majority of three is two approvals
    const run = stewardData().runs.find((r) => r.id === "run-1")!;
    run.stages[0]!.seats.push({
      comment: null,
      decidedAt: null,
      groupId: null,
      state: "pending",
      taskId: "task-9",
      userId: "user-dave",
    });
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const admin = await as("user-alice");
    const dave = await as("user-dave");
    const first = { policyVersionId: "version-4", runId: "run-1" };
    ok(
      await decide(
        approver,
        { ...first, taskId: "task-1" },
        "SIGNAL_TYPE_REJECT",
        "Not sure.",
      ),
    );
    assert.equal(
      (await status(author, "version-4")).status,
      "APPROVAL_STATUS_IN_REVIEW",
    );
    // two approvals are still possible, and the other seats keep their tasks
    assert.ok(
      (await tasksOf(admin)).some((t) => t.policyVersionId === "version-4"),
    );
    ok(
      await decide(
        admin,
        { ...first, taskId: "task-2" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    ok(
      await decide(dave, { ...first, taskId: "task-9" }, "SIGNAL_TYPE_APPROVE"),
    );
    // the stage is met by the two approvals despite the reject, and the run moves on
    assert.equal((await status(author, "version-4")).currentStageIdx, 1);
  });

  it("ends the run at once on a rejection when the stage's quorum is one", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const admin = await as("user-alice");
    const first = { policyVersionId: "version-4", runId: "run-1" };
    ok(
      await decide(
        approver,
        { ...first, taskId: "task-1" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    ok(
      await decide(
        admin,
        { ...first, taskId: "task-2" },
        "SIGNAL_TYPE_APPROVE",
      ),
    );
    // the Final approval stage has one seat
    ok(
      await decide(
        admin,
        { ...first, taskId: "task-3" },
        "SIGNAL_TYPE_REJECT",
        "Not yet.",
      ),
    );
    assert.equal(
      (await status(author, "version-4")).status,
      "APPROVAL_STATUS_REJECTED",
    );
  });

  it("makes a rejection final: the author's next save starts a new draft, the rejected version stays", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    ok(
      await decide(
        approver,
        { policyVersionId: "version-4", runId: "run-1", taskId: "task-1" },
        "SIGNAL_TYPE_REJECT",
        "No.",
      ),
    );
    const before = (await byNumber(author, TRAVEL_BOOKING_NUMBER)).policy;
    const saved = ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: "policy-3",
      }),
    ).saveDraft as { id: string; status: string };
    assert.notEqual(saved.id, "version-4");
    assert.equal(saved.status, "DRAFT");
    assert.equal(
      stewardData().versions.find((v) => v.id === "version-4")?.status,
      "REJECTED",
    );
    assert.ok(before);
  });

  it("returns a withdrawn submission to Draft", async () => {
    const author = await as("user-bob");
    const withdrawn = await decide(
      author,
      { policyVersionId: "version-4", runId: "run-1", taskId: "task-1" },
      "SIGNAL_TYPE_WITHDRAW" as never,
      "",
    );
    ok(withdrawn);
    assert.equal(
      stewardData().versions.find((v) => v.id === "version-4")?.status,
      "DRAFT",
    );
    assert.equal(
      (await status(author, "version-4")).status,
      "APPROVAL_STATUS_WITHDRAWN",
    );
  });

  it("refuses to decide a task twice", async () => {
    const approver = await as("user-charlie");
    const task = {
      policyVersionId: "version-4",
      runId: "run-1",
      taskId: "task-1",
    };
    ok(await decide(approver, task, "SIGNAL_TYPE_APPROVE"));
    const again = await decide(approver, task, "SIGNAL_TYPE_REJECT");
    assert.equal(again.refused, "FailedPrecondition");
  });

  it("refuses a decision on a run that has ended", async () => {
    const approver = await as("user-charlie");
    const decided = await decide(
      approver,
      { policyVersionId: "version-8", runId: "run-2", taskId: "task-4" },
      "SIGNAL_TYPE_APPROVE",
    );
    assert.equal(decided.refused, "FailedPrecondition");
  });

  it("wants a comment with an approval", async () => {
    const approver = await as("user-charlie");
    const answer = await decide(
      approver,
      { policyVersionId: "version-4", runId: "run-1", taskId: "task-1" },
      "SIGNAL_TYPE_APPROVE",
      " ",
    );
    assert.equal(answer.refused, "InvalidArgument");
  });
});
