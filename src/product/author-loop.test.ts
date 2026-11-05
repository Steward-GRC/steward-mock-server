// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The author's loop, through /query as the web drives it: the reader follows a policy through
// create, save, publish and discard, a draft goes to review with submitWorkflow, and the run
// moves on with each decision until the last approval publishes it or a rejection ends it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { EXPENSE_CLAIMS_NUMBER } from "#product/data/policies.ts";
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
        documentType === "POLICY"
          ? "category-reimbursement"
          : "category-ethics",
      sensitivity: "STANDARD",
      title: "Travel Booking",
    }),
  ).createPolicy as { homeCategoryId: string } & PolicyRow;

describe("the reader follows the author's writes", () => {
  it("numbers a new policy and procedure the way steward-core does", async () => {
    const author = await as("user-alovelace");
    assert.equal((await createTravel(author)).number, "POL-REIMBU-000002");
    assert.equal(
      (await createTravel(author, "PROCEDURE")).number,
      "PRC-ETHICS-000002",
    );
  });

  it("shows a new draft to its author only, then the published policy to everyone", async () => {
    const author = await as("user-alovelace");
    const reader = await as("user-kjohnson");
    const created = await createTravel(author);
    const draft = await byNumber(author, created.number);
    assert.equal(draft.policy.currentVersionStatus, "DRAFT");
    assert.equal(draft.policy.currentVersionNo, 0);
    assert.equal((await byNumber(reader, created.number)).refused, "NOT_FOUND");

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
    const author = await as("user-alovelace");
    const reader = await as("user-kjohnson");
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
    assert.equal(theirs.policy.currentVersionNo, 2);

    ok(await call(base, author, "DiscardDraft", { policyId: "policy-1" }));
    const discarded = await byNumber(author, EXPENSE_CLAIMS_NUMBER);
    assert.equal(discarded.policy.currentDraftVersionId, null);
    assert.equal(discarded.policy.currentVersionStatus, "PUBLISHED");
  });
});

describe("submitting a draft for review", () => {
  it("starts a run on the home category's workflow and gives the approver a task", async () => {
    const author = await as("user-alovelace");
    const approver = await as("user-ghopper");
    const created = await createTravel(author);
    const draftId = created.currentDraftVersionId ?? "";
    const { refused, runId } = await submit(author, created, draftId);
    assert.equal(refused, undefined);
    assert.ok(runId);

    const run = await status(author, draftId);
    assert.equal(run.status, "APPROVAL_STATUS_IN_REVIEW");
    assert.deepEqual(
      run.stageAssignees.map((seats) => seats.map((s) => s.userId)),
      [["user-ghopper"]],
    );
    const row = await byNumber(author, created.number);
    assert.equal(row.policy.currentVersionStatus, "IN_REVIEW");
    assert.ok(
      (await tasksOf(approver)).some((t) => t.policyVersionId === draftId),
    );
  });

  it("refuses someone who can't edit the policy", async () => {
    const reader = await as("user-kjohnson");
    const { refused } = await submit(
      reader,
      { homeCategoryId: "category-usage", id: "policy-2" },
      "version-3",
    );
    assert.equal(refused, "FORBIDDEN");
  });

  it("refuses a policy whose category has no workflow", async () => {
    const admin = await as("user-demo-admin");
    const { refused } = await submit(
      admin,
      { homeCategoryId: "category-due-diligence", id: "policy-5" },
      "version-6",
    );
    assert.equal(refused, "FAILED_PRECONDITION");
  });
});

describe("deciding an approval", () => {
  it("publishes the policy on the last approval", async () => {
    const author = await as("user-alovelace");
    const approver = await as("user-ghopper");
    const reader = await as("user-kjohnson");
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
      { homeCategoryId: "category-reimbursement", id: "policy-1" },
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
    assert.equal(published.policy.currentVersionNo, 3);
    assert.ok(
      !(await tasksOf(approver)).some((t) => t.policyVersionId === draftId),
    );
  });

  it("moves a multi-stage run on stage by stage", async () => {
    const author = await as("user-alovelace");
    const approver = await as("user-ghopper");
    const admin = await as("user-demo-admin");
    const first = { policyVersionId: "version-4", runId: "run-1" };

    // Board review wants a majority of its two approvers.
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
      (await byNumber(author, "POL-DATAGO-000001")).policy.currentVersionStatus,
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
    const policy = (await byNumber(author, "POL-DATAGO-000001")).policy;
    assert.equal(policy.currentPublishedVersionId, "version-4");
    assert.equal(policy.currentVersionStatus, "PUBLISHED");
    assert.equal(policy.currentVersionNo, 1);
  });

  it("marks the run and the policy rejected on a rejection", async () => {
    const author = await as("user-alovelace");
    const approver = await as("user-ghopper");
    const admin = await as("user-demo-admin");
    ok(
      await decide(
        approver,
        { policyVersionId: "version-4", runId: "run-1", taskId: "task-1" },
        "SIGNAL_TYPE_REJECT",
        "The labels need examples.",
      ),
    );
    const run = await status(author, "version-4");
    assert.equal(run.status, "APPROVAL_STATUS_REJECTED");
    const policy = (await byNumber(author, "POL-DATAGO-000001")).policy;
    assert.equal(policy.currentVersionStatus, "REJECTED");
    assert.equal(policy.currentPublishedVersionId, null);
    // A rejection ends the other seats: nobody else has the task any more.
    assert.ok(
      !(await tasksOf(admin)).some((t) => t.policyVersionId === "version-4"),
    );
  });

  it("refuses to decide a task twice", async () => {
    const approver = await as("user-ghopper");
    const task = {
      policyVersionId: "version-4",
      runId: "run-1",
      taskId: "task-1",
    };
    ok(await decide(approver, task, "SIGNAL_TYPE_APPROVE"));
    const again = await decide(approver, task, "SIGNAL_TYPE_REJECT");
    assert.equal(again.refused, "FAILED_PRECONDITION");
  });

  it("refuses a decision on a run that has ended", async () => {
    const approver = await as("user-ghopper");
    const decided = await decide(
      approver,
      { policyVersionId: "version-8", runId: "run-2", taskId: "task-4" },
      "SIGNAL_TYPE_APPROVE",
    );
    assert.equal(decided.refused, "FAILED_PRECONDITION");
  });

  it("wants a comment with an approval", async () => {
    const approver = await as("user-ghopper");
    const answer = await decide(
      approver,
      { policyVersionId: "version-4", runId: "run-1", taskId: "task-1" },
      "SIGNAL_TYPE_APPROVE",
      " ",
    );
    assert.equal(answer.refused, "BAD_USER_INPUT");
  });
});
