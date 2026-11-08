// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A veto approver (steward-web#256, steward-workflow#26, steward-mock-server#112): a workflow can
// opt in, off by default, to marking an approver (a user, or the members of a group seat) as one
// whose single reject ends the version as rejected, even inside a quorum and below its threshold.
// Without the opt-in, or for anyone not marked, a reject is only a vote.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Run } from "#product/data/policies.ts";
import type { Signed } from "#product/test-client.ts";

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

const SIGNAL = `mutation ($policyVersionId: ID!, $runId: ID!, $taskId: ID!, $signal: SignalType!, $comment: String!) {
  signalWorkflow(policyVersionId: $policyVersionId, runId: $runId, taskId: $taskId, signal: $signal, comment: $comment)
}`;
const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) {
    status
    stageAssignees { userId state veto }
  }
}`;
const SET_ENABLED = `mutation ($id: ID!, $enabled: Boolean!) {
  setWorkflowVetoEnabled(id: $id, enabled: $enabled) { id vetoEnabled }
}`;
const UPDATE = `mutation ($id: ID!, $name: String!, $stages: [WorkflowStageInput!]!) {
  updateWorkflowDef(id: $id, name: $name, stages: $stages) {
    id
    stages { name vetoApproverIds vetoGroupIds }
  }
}`;
const SUBMIT = `mutation ($policyVersionId: ID!, $policyId: ID!, $categoryId: ID!) {
  submitWorkflow(policyVersionId: $policyVersionId, policyId: $policyId, categoryId: $categoryId, ancestorCategoryIds: []) { runId }
}`;

/** A review of one version where any one of three approvers is enough: a reject alone is only a vote. */
const openRun = (vetoUserIds: string[]) => {
  const run: Run = {
    currentStageIdx: 0,
    id: "run-veto",
    policyId: "policy-3",
    policyVersionId: "version-4",
    stages: [
      {
        name: "Review",
        quorum: "one",
        seats: ["user-charlie", "user-alice", "user-dave"].map(
          (userId, index) => ({
            comment: null,
            decidedAt: null,
            state: "pending",
            taskId: `task-veto-${String(index)}`,
            userId,
          }),
        ),
        vetoUserIds,
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
};

const TASKS: Record<string, string> = {
  "user-alice": "task-veto-1",
  "user-charlie": "task-veto-0",
  "user-dave": "task-veto-2",
};

const reject = async (user: string) =>
  ask(await as(user.replace("user-", "")), SIGNAL, {
    comment: "No.",
    policyVersionId: "version-4",
    runId: "run-veto",
    signal: "SIGNAL_TYPE_REJECT",
    taskId: TASKS[user],
  });

const statusOf = async () => {
  const answer = await ask(await as("bob"), STATUS, {
    policyVersionId: "version-4",
  });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.workflowStatus as {
    stageAssignees: { state: string; userId: string; veto: boolean }[][];
    status: string;
  };
};

describe("a reject by a veto approver", () => {
  it("ends the version as rejected although the quorum could still be reached", async () => {
    openRun(["user-dave"]);
    const answer = await reject("user-dave");
    assert.equal(answer.code, undefined, answer.message);
    const status = await statusOf();
    assert.equal(status.status, "APPROVAL_STATUS_REJECTED");
    assert.equal(
      stewardData().versions.find((v) => v.id === "version-4")?.status,
      "REJECTED",
    );
  });

  it("cancels the other seats", async () => {
    openRun(["user-dave"]);
    await reject("user-dave");
    const status = await statusOf();
    assert.deepEqual(
      status.stageAssignees[0]?.map((s) => [s.userId, s.state]),
      [
        ["user-charlie", "cancelled"],
        ["user-alice", "cancelled"],
        ["user-dave", "rejected"],
      ],
    );
  });

  it("shows which seats hold a veto", async () => {
    openRun(["user-dave"]);
    const status = await statusOf();
    assert.deepEqual(
      status.stageAssignees[0]?.map((s) => [s.userId, s.veto]),
      [
        ["user-charlie", false],
        ["user-alice", false],
        ["user-dave", true],
      ],
    );
  });
});

describe("a reject by anyone else", () => {
  it("is only a vote while the quorum can still be reached", async () => {
    openRun(["user-dave"]);
    await reject("user-charlie");
    const status = await statusOf();
    assert.equal(status.status, "APPROVAL_STATUS_IN_REVIEW");
  });
});

const submitWithVeto = async (enabled: boolean) => {
  startFresh();
  const admin = await as("grace");
  await ask(admin, UPDATE, {
    id: "workflow-1",
    name: "Finance sign-off",
    stages: [
      {
        approvers: ["user-charlie"],
        name: "Finance sign-off",
        quorum: "one",
        vetoApproverIds: ["user-charlie"],
      },
    ],
  });
  if (enabled)
    await ask(admin, SET_ENABLED, { enabled: true, id: "workflow-1" });
  const author = await as("bob");
  const content = JSON.stringify({
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
  const draft = await ask(
    author,
    `mutation ($policyId: ID!, $contentJson: String!) { saveDraft(policyId: $policyId, contentJson: $contentJson) { id } }`,
    { contentJson: content, policyId: "policy-1" },
  );
  assert.equal(draft.code, undefined, draft.message);
  const versionId = (draft.data.saveDraft as { id: string }).id;
  const sent = await ask(author, SUBMIT, {
    categoryId: "category-expenses",
    policyId: "policy-1",
    policyVersionId: versionId,
  });
  assert.equal(sent.code, undefined, sent.message);
  const answer = await ask(author, STATUS, { policyVersionId: versionId });
  return (
    answer.data.workflowStatus as { stageAssignees: { veto: boolean }[][] }
  ).stageAssignees[0]?.[0]?.veto;
};

describe("opting a workflow in", () => {
  it("is off by default and set by a template admin", async () => {
    const workflow = stewardData().workflowDefs.find(
      (w) => w.id === "workflow-2",
    );
    assert.equal(workflow?.vetoEnabled, false);
    const refused = await ask(await as("bob"), SET_ENABLED, {
      enabled: true,
      id: "workflow-2",
    });
    assert.equal(refused.code, "PermissionDenied");
    const done = await ask(await as("grace"), SET_ENABLED, {
      enabled: true,
      id: "workflow-2",
    });
    assert.equal(done.code, undefined, done.message);
    assert.equal(
      (done.data.setWorkflowVetoEnabled as { vetoEnabled: boolean })
        .vetoEnabled,
      true,
    );
  });

  it("marks users and group seats on a stage", async () => {
    const answer = await ask(await as("grace"), UPDATE, {
      id: "workflow-1",
      name: "Finance sign-off",
      stages: [
        {
          approvers: ["user-charlie"],
          name: "Finance sign-off",
          quorum: "one",
          vetoApproverIds: ["user-charlie"],
          vetoGroupIds: ["group-finance"],
        },
      ],
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(
      (
        answer.data.updateWorkflowDef as {
          stages: { vetoApproverIds: string[]; vetoGroupIds: string[] }[];
        }
      ).stages[0],
      {
        name: "Finance sign-off",
        vetoApproverIds: ["user-charlie"],
        vetoGroupIds: ["group-finance"],
      },
    );
  });

  it("carries the marks into a run only when the workflow has opted in", async () => {
    assert.equal(await submitWithVeto(true), true);
    assert.equal(await submitWithVeto(false), false);
  });
});
