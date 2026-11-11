// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The n-of-m stage quorum (steward-mock-server#148), as steward-workflow keeps it: a stage with
// quorum "nofm" and quorumN needs N approvals. A save refuses an N below one, an N on another
// quorum and an N above the stage's approvers. Submit refuses an N above the stage's votes (its
// approvers plus each group unit with members). The tally scores the individual seats against N
// and still needs every group unit met on its own quorum. When the approvers who can read the
// policy cannot meet the quorum, the home category's owners join as individual seats.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Workflow } from "#product/data/library.ts";
import type { Run, Seat } from "#product/data/policies.ts";
import type { Signed } from "#product/test-client.ts";

import { stewardData } from "#product/data.ts";
import { raci, stage } from "#product/data/library.ts";
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

const as = (user: string) => signInAs(base, `user-${user}`);

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const CREATE = `mutation ($name: String!, $stages: [WorkflowStageInput!]!) {
  createWorkflowDef(name: $name, stages: $stages) { id stages { quorum quorumN } }
}`;
const UPDATE = `mutation ($id: ID!, $name: String!, $stages: [WorkflowStageInput!]!) {
  updateWorkflowDef(id: $id, name: $name, stages: $stages) { id stages { quorum quorumN } }
}`;
const SIGNAL = `mutation ($policyVersionId: ID!, $runId: ID!, $taskId: ID!, $signal: SignalType!, $comment: String!) {
  signalWorkflow(policyVersionId: $policyVersionId, runId: $runId, taskId: $taskId, signal: $signal, comment: $comment)
}`;
const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) {
    status
    currentStageIdx
    stageAssignees { userId state groupId }
  }
}`;
const SUBMIT = `mutation ($policyVersionId: ID!, $policyId: ID!, $categoryId: ID!) {
  submitWorkflow(policyVersionId: $policyVersionId, policyId: $policyId, categoryId: $categoryId, ancestorCategoryIds: []) { runId }
}`;

const stageInput = (given: Record<string, unknown>) => ({
  approvers: ["user-charlie", "user-alice", "user-dave"],
  name: "Review",
  quorum: "nofm",
  quorumN: 2,
  ...given,
});

describe("saving a stage with an n-of-m quorum", () => {
  it("keeps the quorum and its N", async () => {
    const admin = await as("grace");
    const made = await ask(admin, CREATE, {
      name: "Two of three",
      stages: [stageInput({})],
    });
    assert.equal(made.code, undefined, made.message);
    assert.deepEqual(
      (made.data.createWorkflowDef as { stages: unknown[] }).stages,
      [{ quorum: "nofm", quorumN: 2 }],
    );
    const changed = await ask(admin, UPDATE, {
      id: "workflow-2",
      name: "Standard 2-stage",
      stages: [stageInput({ quorumN: 3 })],
    });
    assert.equal(changed.code, undefined, changed.message);
    assert.deepEqual(
      (changed.data.updateWorkflowDef as { stages: unknown[] }).stages,
      [{ quorum: "nofm", quorumN: 3 }],
    );
  });

  it("reads N as zero on every other quorum", async () => {
    const answer = await ask(await as("grace"), CREATE, {
      name: "Any one",
      stages: [stageInput({ quorum: "one", quorumN: undefined })],
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(
      (answer.data.createWorkflowDef as { stages: unknown[] }).stages,
      [{ quorum: "one", quorumN: 0 }],
    );
  });

  it("refuses an N below one", async () => {
    const admin = await as("grace");
    for (const quorumN of [0, -1, undefined]) {
      const answer = await ask(admin, CREATE, {
        name: "Bad",
        stages: [stageInput({ quorumN })],
      });
      assert.equal(answer.code, "InvalidArgument", String(quorumN));
      assert.match(answer.message ?? "", /quorum_n must be >= 1/);
    }
  });

  it("refuses an N on a quorum that is not n-of-m", async () => {
    const answer = await ask(await as("grace"), UPDATE, {
      id: "workflow-2",
      name: "Standard 2-stage",
      stages: [stageInput({ quorum: "majority", quorumN: 1 })],
    });
    assert.equal(answer.code, "InvalidArgument");
    assert.match(answer.message ?? "", /quorum_n only valid when quorum is/);
  });

  it("refuses an N above the approvers named, but not on a stage with none", async () => {
    const admin = await as("grace");
    const over = await ask(admin, CREATE, {
      name: "Bad",
      stages: [stageInput({ approvers: ["user-charlie"], quorumN: 2 })],
    });
    assert.equal(over.code, "InvalidArgument");
    assert.match(over.message ?? "", /quorum_n \(2\) exceeds approver count/);
    const draft = await ask(admin, CREATE, {
      name: "Draft",
      stages: [stageInput({ approvers: [], quorumN: 2 })],
    });
    assert.equal(draft.code, undefined, draft.message);
  });
});

const LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [{ text: "Words.", type: "text", version: 1 }],
        type: "paragraph",
        version: 1,
      },
    ],
    direction: null,
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});

/** Put a workflow on policy-1 and send a fresh draft of it for review. */
const submitOn = async (workflow: Workflow) => {
  const data = stewardData();
  data.workflowDefs.push(workflow);
  const policy = data.policies.find((p) => p.id === "policy-1")!;
  policy.workflowDefId = workflow.id;
  const author = await as("bob");
  const draft = await ask(
    author,
    `mutation ($policyId: ID!, $contentJson: String!) { saveDraft(policyId: $policyId, contentJson: $contentJson) { id } }`,
    { contentJson: LEXICAL, policyId: "policy-1" },
  );
  assert.equal(draft.code, undefined, draft.message);
  const versionId = (draft.data.saveDraft as { id: string }).id;
  const sent = await ask(author, SUBMIT, {
    categoryId: policy.homeCategoryId,
    policyId: "policy-1",
    policyVersionId: versionId,
  });
  return { sent, versionId };
};

const workflowOf = (stages: Workflow["stages"]): Workflow => ({
  archived: false,
  description: null,
  id: "workflow-nofm",
  name: "N of m",
  stages,
  version: 1,
  vetoEnabled: false,
});

const nofm = (given: Partial<Workflow["stages"][number]>) =>
  stage({
    approvers: ["user-charlie", "user-alice", "user-dave"],
    id: "stage-nofm",
    name: "Review",
    quorum: "nofm",
    quorumN: 2,
    ...given,
  });

const FINANCE_GROUP = {
  groupId: "group-finance",
  internalQuorum: "one",
  memberUserIds: ["user-grace"],
};

describe("submitting a stage with an n-of-m quorum", () => {
  it("seats the approvers and carries the quorum onto the run", async () => {
    const { sent, versionId } = await submitOn(workflowOf([nofm({})]));
    assert.equal(sent.code, undefined, sent.message);
    const run = stewardData().runs.find((r) => r.policyVersionId === versionId);
    assert.deepEqual(
      [run?.stages[0]?.quorum, run?.stages[0]?.quorumN],
      ["nofm", 2],
    );
    assert.equal(run?.stages[0]?.seats.length, 3);
  });

  it("refuses an N above the approvers", async () => {
    const { sent } = await submitOn(
      workflowOf([nofm({ approvers: ["user-charlie"], quorumN: 3 })]),
    );
    assert.equal(sent.code, "FailedPrecondition");
    assert.equal(sent.message, "stage 0: quorum_n=3 exceeds pool size 1");
  });

  it("counts each group unit with members as a vote, as steward-workflow does", async () => {
    const ok = await submitOn(
      workflowOf([
        nofm({
          approvers: ["user-charlie"],
          groupUnits: [FINANCE_GROUP],
          quorumN: 2,
        }),
      ]),
    );
    assert.equal(ok.sent.code, undefined, ok.sent.message);
    startFresh();
    const over = await submitOn(
      workflowOf([
        nofm({
          approvers: ["user-charlie"],
          groupUnits: [
            FINANCE_GROUP,
            { ...FINANCE_GROUP, groupId: "group-empty", memberUserIds: [] },
          ],
          quorumN: 3,
        }),
      ]),
    );
    assert.equal(over.sent.code, "FailedPrecondition");
    assert.equal(over.sent.message, "stage 0: quorum_n=3 exceeds pool size 2");
  });

  it("names the stage that is short, by its place in the workflow", async () => {
    const { sent } = await submitOn(
      workflowOf([
        nofm({}),
        nofm({ approvers: ["user-alice"], id: "stage-b", quorumN: 2 }),
      ]),
    );
    assert.equal(sent.code, "FailedPrecondition");
    assert.equal(sent.message, "stage 1: quorum_n=2 exceeds pool size 1");
  });
});

const seat = (taskId: string, userId: string, groupId?: string): Seat => ({
  comment: null,
  decidedAt: null,
  state: "pending",
  taskId,
  userId,
  ...(groupId ? { groupId } : {}),
});

/** A review of version-4 on one stage; policy-3's own run is replaced. */
const openRun = (stageFields: Partial<Run["stages"][number]>): Run => {
  const run: Run = {
    currentStageIdx: 0,
    id: "run-nofm",
    policyId: "policy-3",
    policyVersionId: "version-4",
    stages: [
      {
        name: "Review",
        quorum: "nofm",
        quorumN: 2,
        seats: [
          seat("t-charlie", "user-charlie"),
          seat("t-alice", "user-alice"),
          seat("t-dave", "user-dave"),
        ],
        ...stageFields,
      },
    ],
    status: "APPROVAL_STATUS_IN_REVIEW",
    submittedAt: "2026-11-07T00:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-2",
  };
  const data = stewardData();
  data.runs = data.runs.filter((r) => r.policyVersionId !== "version-4");
  data.runs.push(run);
  return run;
};

const decide = async (
  user: string,
  taskId: string,
  signal: "SIGNAL_TYPE_APPROVE" | "SIGNAL_TYPE_REJECT",
) => {
  const answer = await ask(await as(user), SIGNAL, {
    comment: "Reviewed.",
    policyVersionId: "version-4",
    runId: "run-nofm",
    signal,
    taskId,
  });
  assert.equal(answer.code, undefined, answer.message);
};
const approve = (user: string) =>
  decide(user, `t-${user}`, "SIGNAL_TYPE_APPROVE");
const rejectAs = (user: string) =>
  decide(user, `t-${user}`, "SIGNAL_TYPE_REJECT");

const statusOf = async () => {
  const answer = await ask(await as("bob"), STATUS, {
    policyVersionId: "version-4",
  });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.workflowStatus as { status: string };
};

const IN_REVIEW = "APPROVAL_STATUS_IN_REVIEW";

describe("the tally of an n-of-m stage", () => {
  it("waits below N approvals and passes on the Nth", async () => {
    const run = openRun({});
    await approve("charlie");
    assert.equal((await statusOf()).status, IN_REVIEW);
    await approve("alice");
    assert.equal((await statusOf()).status, "APPROVAL_STATUS_PUBLISHED");
    assert.deepEqual(
      run.stages[0]?.seats.map((s) => s.state),
      ["approved", "approved", "cancelled"],
    );
  });

  it("treats a rejection as a vote while N can still be reached", async () => {
    openRun({});
    await rejectAs("charlie");
    assert.equal((await statusOf()).status, IN_REVIEW);
    await approve("alice");
    await approve("dave");
    assert.equal((await statusOf()).status, "APPROVAL_STATUS_PUBLISHED");
  });

  it("rejects once the approvals still possible fall below N", async () => {
    openRun({});
    await rejectAs("charlie");
    await rejectAs("alice");
    assert.equal((await statusOf()).status, "APPROVAL_STATUS_REJECTED");
  });

  it("needs a three-of-three stage to hold every approval", async () => {
    openRun({ quorumN: 3 });
    await approve("charlie");
    await approve("alice");
    assert.equal((await statusOf()).status, IN_REVIEW);
    await rejectAs("dave");
    assert.equal((await statusOf()).status, "APPROVAL_STATUS_REJECTED");
  });

  it("scores the individual seats on N and still needs every group met", async () => {
    openRun({
      groups: [
        { id: "group-finance", name: "Finance", quorum: "one", required: 1 },
      ],
      seats: [
        seat("t-charlie", "user-charlie"),
        seat("t-alice", "user-alice"),
        seat("t-dave", "user-dave"),
        seat("t-grace", "user-grace", "group-finance"),
      ],
    });
    await approve("charlie");
    await approve("alice");
    // N is met by the individual seats, the group is not
    assert.equal((await statusOf()).status, IN_REVIEW);
    await approve("grace");
    assert.equal((await statusOf()).status, "APPROVAL_STATUS_PUBLISHED");
  });

  it("does not let a met group stand in for an individual vote", async () => {
    openRun({
      groups: [
        { id: "group-finance", name: "Finance", quorum: "one", required: 1 },
      ],
      seats: [
        seat("t-charlie", "user-charlie"),
        seat("t-alice", "user-alice"),
        seat("t-grace", "user-grace", "group-finance"),
      ],
    });
    await approve("grace");
    await approve("charlie");
    assert.equal((await statusOf()).status, IN_REVIEW);
    await approve("alice");
    assert.equal((await statusOf()).status, "APPROVAL_STATUS_PUBLISHED");
  });
});

/** Only charlie and dave read policy-1, and alice owns its home category. */
const narrowAccess = () => {
  const data = stewardData();
  for (const c of data.categories)
    if (c.id === "category-finance") c.rules = [];
  const expenses = data.categories.find((c) => c.id === "category-expenses")!;
  expenses.owners = ["user-alice"];
  expenses.rules = [
    raci("USER", "user-charlie", ["ALLOW", "BLANK", "BLANK", "BLANK"]),
    raci("USER", "user-dave", ["ALLOW", "BLANK", "BLANK", "BLANK"]),
  ];
};

/** The individual seats on a version's first stage (group seats are kept apart). */
const seatedOn = (versionId: string) =>
  stewardData()
    .runs.find((r) => r.policyVersionId === versionId)
    ?.stages[0]?.seats.filter((s) => !s.groupId)
    .map((s) => s.userId);

describe("the owner fallback", () => {
  it("seats the category owners when the readers left cannot meet N", async () => {
    narrowAccess();
    const { sent, versionId } = await submitOn(
      workflowOf([
        nofm({ approvers: ["user-charlie", "user-frank", "user-erin"] }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(seatedOn(versionId), ["user-charlie", "user-alice"]);
  });

  it("leaves the owners out when the readers left meet N", async () => {
    narrowAccess();
    const { sent, versionId } = await submitOn(
      workflowOf([nofm({ approvers: ["user-charlie", "user-dave"] })]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(seatedOn(versionId), ["user-charlie", "user-dave"]);
  });

  it("does not seat an owner twice", async () => {
    narrowAccess();
    const { versionId } = await submitOn(
      workflowOf([
        nofm({
          approvers: ["user-alice", "user-frank"],
          quorumN: 2,
        }),
      ]),
    );
    assert.deepEqual(seatedOn(versionId), ["user-alice"]);
  });

  it("counts a group with a reader as one vote, as steward-workflow does", async () => {
    narrowAccess();
    const { sent, versionId } = await submitOn(
      workflowOf([
        nofm({
          approvers: ["user-charlie", "user-frank"],
          groupUnits: [{ ...FINANCE_GROUP, memberUserIds: ["user-dave"] }],
          quorumN: 2,
        }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    // charlie plus the group make two votes, so no owner joins
    assert.deepEqual(seatedOn(versionId), ["user-charlie"]);
    // the group's reader holds a group seat, not an individual one
    assert.deepEqual(
      stewardData()
        .runs.find((r) => r.policyVersionId === versionId)
        ?.stages[0]?.seats.filter((s) => s.groupId === "group-finance")
        .map((s) => s.userId),
      ["user-dave"],
    );
  });

  it("applies to every quorum: an empty pool of readers falls back to the owners", async () => {
    narrowAccess();
    const { sent, versionId } = await submitOn(
      workflowOf([
        nofm({
          approvers: ["user-frank"],
          quorum: "one",
          quorumN: 0,
        }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(seatedOn(versionId), ["user-alice"]);
  });
});
