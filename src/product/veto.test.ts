// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A veto holder (steward-mock-server#112, #223): a stage names people, in vetoUserIds, whose single
// reject ends the version as rejected, even inside a quorum and below its threshold. A vetoer must
// be one of the stage's approvers (no veto-only seats, and site admin or root does not count); a
// vetoer who is not seated holds no veto. There is no workflow-wide switch. Anyone not named
// casts only a vote. The old vetoApproverIds, vetoGroupIds, vetoEnabled and
// setWorkflowVetoEnabled are gone from the schema (steward-gateway#224).

import { buildSchema } from "graphql";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const UPDATE = `mutation ($id: ID!, $name: String!, $stages: [WorkflowStageInput!]!) {
  updateWorkflowDef(id: $id, name: $name, stages: $stages) {
    id
    stages { name vetoUserIds }
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
        ["user-charlie", "superseded"],
        ["user-alice", "superseded"],
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

const stageInput = (
  extra: Record<string, unknown> = {},
  name = "Finance sign-off",
) => ({
  approvers: ["user-charlie", "user-dave"],
  name,
  quorum: "one",
  ...extra,
});

const save = async (stages: Record<string, unknown>[]) =>
  ask(await as("grace"), UPDATE, {
    id: "workflow-1",
    name: "Finance sign-off",
    stages,
  });

const CONTENT = JSON.stringify({
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

/** Submit policy-1 (category Expenses, workflow-1) and answer its stage assignees. */
const submitted = async () => {
  const author = await as("bob");
  const draft = await ask(
    author,
    `mutation ($policyId: ID!, $contentJson: String!) { saveDraft(policyId: $policyId, contentJson: $contentJson) { id } }`,
    { contentJson: CONTENT, policyId: "policy-1" },
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
  const status = answer.data.workflowStatus as {
    stageAssignees: { userId: string; veto: boolean }[][];
    status: string;
  };
  return {
    holders: status.stageAssignees.map((seats) =>
      seats.filter((s) => s.veto).map((s) => s.userId),
    ),
    status,
    versionId,
  };
};

/** A seated person decides on the open run of a version. */
const decide = async (
  user: string,
  versionId: string,
  signal: "SIGNAL_TYPE_APPROVE" | "SIGNAL_TYPE_REJECT",
) => {
  const run = stewardData().runs.find((r) => r.policyVersionId === versionId)!;
  const seat = run.stages[run.currentStageIdx]!.seats.find(
    (s) => s.userId === `user-${user}`,
  )!;
  return ask(await as(user), SIGNAL, {
    comment: "Decided.",
    policyVersionId: versionId,
    runId: run.id,
    signal,
    taskId: seat.taskId,
  });
};

describe("naming veto people on a stage", () => {
  it("stores a list of people per stage and answers it", async () => {
    const answer = await save([
      stageInput({ vetoUserIds: ["user-charlie", "user-dave"] }),
      stageInput({ vetoUserIds: ["user-dave"] }, "Second"),
      stageInput({}, "Third"),
    ]);
    assert.equal(answer.code, undefined, answer.message);
    const stages = (
      answer.data.updateWorkflowDef as {
        stages: { vetoUserIds: string[] }[];
      }
    ).stages;
    assert.deepEqual(
      stages.map((s) => s.vetoUserIds),
      [["user-charlie", "user-dave"], ["user-dave"], []],
    );
  });

  it("refuses a person who is not one of the stage's approvers", async () => {
    const answer = await save([stageInput({ vetoUserIds: ["user-bob"] })]);
    assert.equal(answer.code, "InvalidArgument");
    assert.match(answer.message ?? "", /veto/);
    assert.match(answer.message ?? "", /approver/);
  });

  it("refuses site admin and root unless they are an approver", async () => {
    const refused = await save([stageInput({ vetoUserIds: ["user-alice"] })]);
    assert.equal(refused.code, "InvalidArgument");
    const named = await save([
      stageInput({
        approvers: ["user-charlie", "user-alice"],
        vetoUserIds: ["user-alice"],
      }),
    ]);
    assert.equal(named.code, undefined, named.message);
  });

  it("accepts a person only the category or group lists name", async () => {
    const answer = await save([
      stageInput({
        approversByCategory: [
          { approverIds: ["user-erin"], categoryId: "category-people" },
        ],
        groupUnits: [
          {
            groupId: "group-finance",
            internalQuorum: "one",
            memberUserIds: ["user-frank"],
          },
        ],
        vetoUserIds: ["user-erin", "user-frank"],
      }),
    ]);
    assert.equal(answer.code, undefined, answer.message);
  });

  it("creates a workflow with the list, and refuses a stranger there too", async () => {
    const CREATE = `mutation ($name: String!, $stages: [WorkflowStageInput!]!) {
      createWorkflowDef(name: $name, stages: $stages) { stages { vetoUserIds } }
    }`;
    const admin = await as("grace");
    const refused = await ask(admin, CREATE, {
      name: "New",
      stages: [stageInput({ vetoUserIds: ["user-bob"] })],
    });
    assert.equal(refused.code, "InvalidArgument");
    const made = await ask(admin, CREATE, {
      name: "New",
      stages: [stageInput({ vetoUserIds: ["user-dave"] })],
    });
    assert.equal(made.code, undefined, made.message);
    assert.deepEqual(
      (made.data.createWorkflowDef as { stages: { vetoUserIds: string[] }[] })
        .stages[0]?.vetoUserIds,
      ["user-dave"],
    );
  });
});

describe("a run's veto holders", () => {
  it("are the stage's named people who are seated, stage by stage", async () => {
    const saved = await save([
      stageInput({ vetoUserIds: ["user-dave"] }, "First"),
      stageInput({ vetoUserIds: ["user-charlie"] }, "Second"),
      stageInput({}, "Third"),
    ]);
    assert.equal(saved.code, undefined, saved.message);
    const { holders } = await submitted();
    assert.deepEqual(holders, [["user-dave"], ["user-charlie"], []]);
  });

  it("do not include a named person who is not in the pool at seating", async () => {
    // the stage lists Erin only for another category, so on this lineage she is not seated
    await save([
      stageInput({
        approversByCategory: [
          { approverIds: ["user-erin"], categoryId: "category-people" },
        ],
        vetoUserIds: ["user-erin", "user-dave"],
      }),
    ]);
    assert.deepEqual((await submitted()).holders, [["user-dave"]]);
  });

  it("never include site admin or root who is not in the pool", async () => {
    await save([stageInput({ vetoUserIds: ["user-dave"] })]);
    // reach past the save check, as an older definition could
    const stage = stewardData().workflowDefs.find((w) => w.id === "workflow-1")!
      .stages[0]!;
    stage.vetoUserIds = ["user-alice", "user-dave"];
    const { holders } = await submitted();
    assert.deepEqual(holders, [["user-dave"]]);
  });

  it("are empty for a stage without veto people", async () => {
    await save([stageInput()]);
    assert.deepEqual((await submitted()).holders, [[]]);
  });
});

const twoVetoers = async () => {
  await save([
    stageInput({
      approvers: ["user-charlie", "user-dave", "user-alice"],
      vetoUserIds: ["user-charlie", "user-dave"],
    }),
  ]);
  return submitted();
};

describe("two veto people at one stage", () => {
  it("end the version when either rejects", async () => {
    for (const who of ["charlie", "dave"]) {
      startFresh();
      const { holders, versionId } = await twoVetoers();
      assert.deepEqual(holders, [["user-charlie", "user-dave"]]);
      const answer = await decide(who, versionId, "SIGNAL_TYPE_REJECT");
      assert.equal(answer.code, undefined, answer.message);
      assert.equal(
        stewardData().versions.find((v) => v.id === versionId)?.status,
        "REJECTED",
      );
    }
  });

  it("leave a reject by a seat that holds none as a vote", async () => {
    const { versionId } = await twoVetoers();
    await decide("alice", versionId, "SIGNAL_TYPE_REJECT");
    assert.notEqual(
      stewardData().versions.find((v) => v.id === versionId)?.status,
      "REJECTED",
    );
  });
});

describe("the removed switch and lists", () => {
  const schema = buildSchema(
    readFileSync(new URL("schema.graphql", import.meta.url), "utf8"),
  );
  const fields = (type: string) =>
    Object.keys(
      (
        schema.getType(type) as
          | { getFields: () => Record<string, unknown> }
          | undefined
      )?.getFields() ?? {},
    );

  it("are not in the schema", () => {
    assert.ok(!fields("WorkflowDef").includes("vetoEnabled"));
    assert.ok(!fields("Mutation").includes("setWorkflowVetoEnabled"));
    for (const type of ["WorkflowStageDef", "WorkflowStageInput"]) {
      assert.ok(!fields(type).includes("vetoApproverIds"), type);
      assert.ok(!fields(type).includes("vetoGroupIds"), type);
      assert.ok(fields(type).includes("vetoUserIds"), type);
    }
  });

  it("have no resolver left", () => {
    assert.equal("vetoEnabled" in (stewardData().workflowDefs[0] ?? {}), false);
  });
});
