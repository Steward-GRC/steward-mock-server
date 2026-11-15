// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What submitWorkflow seats (steward-mock-server#152), as steward-workflow's Submit and stage
// assigner do: a stage's individual pool is the first approversByCategory entry on the policy's
// category lineage (home first, then each ancestor), else its approvers; each group unit with
// members gets group seats and a unit on the run; a stage is unstaffed only with neither pool nor
// group members; the read filter and the owner fallback cover group members too.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Workflow } from "#product/data/library.ts";
import type { Run } from "#product/data/policies.ts";

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
  signed: Awaited<ReturnType<typeof as>>,
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

const SUBMIT = `mutation ($policyVersionId: ID!, $policyId: ID!, $categoryId: ID!) {
  submitWorkflow(policyVersionId: $policyVersionId, policyId: $policyId, categoryId: $categoryId, ancestorCategoryIds: []) { runId }
}`;
const SIGNAL = `mutation ($policyVersionId: ID!, $runId: ID!, $taskId: ID!, $signal: SignalType!, $comment: String!) {
  signalWorkflow(policyVersionId: $policyVersionId, runId: $runId, taskId: $taskId, signal: $signal, comment: $comment)
}`;
const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) {
    status
    currentStageIdx
    stageAssignees { userId state groupId }
    stageUnitProgress { groupId groupName quorum required approvals pending roster status }
  }
}`;

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

/** Put a workflow on policy-1 (home category-expenses, under category-finance) and submit a draft. */
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
  const run = data.runs.find((r) => r.policyVersionId === versionId);
  return { run, sent, versionId };
};

const workflowOf = (stages: Workflow["stages"]): Workflow => ({
  archived: false,
  description: null,
  id: "workflow-seats",
  name: "Seats",
  stages,
  version: 1,
});

const review = (given: Partial<Workflow["stages"][number]>) =>
  stage({
    approvers: ["user-charlie"],
    id: "stage-seats",
    name: "Review",
    ...given,
  });

const FINANCE = {
  groupId: "group-2",
  internalQuorum: "majority",
  memberUserIds: ["user-grace", "user-heidi", "user-erin"],
};

/** The users on a stage's individual seats, or on one group's seats. */
const individuals = (run: Run | undefined, index = 0) =>
  run?.stages[index]?.seats.filter((s) => !s.groupId).map((s) => s.userId);
const membersOf = (run: Run | undefined, groupId: string, index = 0) =>
  run?.stages[index]?.seats
    .filter((s) => s.groupId === groupId)
    .map((s) => s.userId);

describe("submitting a stage with group units", () => {
  it("seats the members under the group and puts the unit on the run", async () => {
    const { run, sent } = await submitOn(
      workflowOf([review({ groupUnits: [FINANCE] })]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(individuals(run), ["user-charlie"]);
    assert.deepEqual(membersOf(run, "group-2"), [
      "user-grace",
      "user-heidi",
      "user-erin",
    ]);
    assert.deepEqual(run?.stages[0]?.groups, [
      { id: "group-2", name: "Finance team", quorum: "majority", required: 2 },
    ]);
  });

  it("works the unit's required number out of its quorum and roster", async () => {
    const { run } = await submitOn(
      workflowOf([
        review({
          groupUnits: [
            { ...FINANCE, groupId: "group-a", internalQuorum: "all" },
            { ...FINANCE, groupId: "group-b", internalQuorum: "one" },
          ],
        }),
      ]),
    );
    assert.deepEqual(
      run?.stages[0]?.groups?.map((g) => [g.id, g.quorum, g.required]),
      [
        ["group-a", "all", 3],
        ["group-b", "one", 1],
      ],
    );
  });

  it("reports the unit in workflowStatus", async () => {
    const { sent, versionId } = await submitOn(
      workflowOf([review({ groupUnits: [FINANCE] })]),
    );
    assert.equal(sent.code, undefined, sent.message);
    const answer = await ask(await as("bob"), STATUS, {
      policyVersionId: versionId,
    });
    const status = answer.data.workflowStatus as {
      stageAssignees: { groupId: null | string; userId: string }[][];
      stageUnitProgress: Record<string, unknown>[][];
    };
    assert.equal(
      status.stageAssignees[0]?.filter((s) => s.groupId === "group-2").length,
      3,
    );
    assert.deepEqual(status.stageUnitProgress[0], [
      {
        approvals: 0,
        groupId: "group-2",
        groupName: "Finance team",
        pending: 3,
        quorum: "majority",
        required: 2,
        roster: 3,
        status: "PENDING",
      },
    ]);
  });

  it("is staffed by group units alone", async () => {
    const { run, sent } = await submitOn(
      workflowOf([review({ approvers: [], groupUnits: [FINANCE] })]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(individuals(run), []);
    assert.equal(membersOf(run, "group-2")?.length, 3);
  });

  it("still refuses a stage with neither approvers nor group members", async () => {
    const { sent } = await submitOn(
      workflowOf([
        review({
          approvers: [],
          groupUnits: [{ ...FINANCE, memberUserIds: [] }],
        }),
      ]),
    );
    assert.equal(sent.code, "FailedPrecondition");
    assert.equal(sent.message, 'The "Review" stage has no approver.');
  });

  it("leaves a unit with no members out of the run", async () => {
    const { run, sent } = await submitOn(
      workflowOf([
        review({
          groupUnits: [
            FINANCE,
            { ...FINANCE, groupId: "group-empty", memberUserIds: [] },
          ],
        }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(
      run?.stages[0]?.groups?.map((g) => g.id),
      ["group-2"],
    );
  });
});

const byCategory = (categoryId: string, approverIds: string[]) => ({
  approverIds,
  categoryId,
});

describe("submitting a stage with approvers by category", () => {
  it("seats the home category's entry instead of the stage's approvers", async () => {
    const { run, sent } = await submitOn(
      workflowOf([
        review({
          approversByCategory: [
            byCategory("category-expenses", ["user-dave", "user-erin"]),
          ],
        }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(individuals(run), ["user-dave", "user-erin"]);
  });

  it("falls to the nearest ancestor's entry when the home category has none", async () => {
    const { run } = await submitOn(
      workflowOf([
        review({
          approversByCategory: [
            byCategory("category-people", ["user-frank"]),
            byCategory("category-finance", ["user-dave"]),
          ],
        }),
      ]),
    );
    assert.deepEqual(individuals(run), ["user-dave"]);
  });

  it("takes the nearest entry when the home category and an ancestor both have one", async () => {
    const { run } = await submitOn(
      workflowOf([
        review({
          approversByCategory: [
            byCategory("category-finance", ["user-dave"]),
            byCategory("category-expenses", ["user-erin"]),
          ],
        }),
      ]),
    );
    assert.deepEqual(individuals(run), ["user-erin"]);
  });

  it("uses the stage's approvers when no entry is on the lineage", async () => {
    const { run } = await submitOn(
      workflowOf([
        review({
          approversByCategory: [byCategory("category-people", ["user-dave"])],
        }),
      ]),
    );
    assert.deepEqual(individuals(run), ["user-charlie"]);
  });

  it("uses the stage's approvers when the nearest entry is empty", async () => {
    const { run } = await submitOn(
      workflowOf([
        review({
          approversByCategory: [
            byCategory("category-expenses", []),
            byCategory("category-finance", ["user-dave"]),
          ],
        }),
      ]),
    );
    assert.deepEqual(individuals(run), ["user-charlie"]);
  });

  it("seats the entry beside the group units, which an entry does not replace", async () => {
    const { run } = await submitOn(
      workflowOf([
        review({
          approversByCategory: [byCategory("category-expenses", ["user-dave"])],
          groupUnits: [FINANCE],
        }),
      ]),
    );
    assert.deepEqual(individuals(run), ["user-dave"]);
    assert.equal(membersOf(run, "group-2")?.length, 3);
  });

  it("is staffed by an entry when the stage names no approvers", async () => {
    const { run, sent } = await submitOn(
      workflowOf([
        review({
          approvers: [],
          approversByCategory: [byCategory("category-finance", ["user-dave"])],
        }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    assert.deepEqual(individuals(run), ["user-dave"]);
  });

  it("checks an n-of-m stage against the pool the category resolves", async () => {
    const wide = await submitOn(
      workflowOf([
        review({
          approversByCategory: [
            byCategory("category-expenses", [
              "user-charlie",
              "user-dave",
              "user-erin",
            ]),
          ],
          quorum: "nofm",
          quorumN: 3,
        }),
      ]),
    );
    assert.equal(wide.sent.code, undefined, wide.sent.message);
    startFresh();
    const narrow = await submitOn(
      workflowOf([
        review({
          approvers: ["user-charlie", "user-dave", "user-erin"],
          approversByCategory: [byCategory("category-expenses", ["user-dave"])],
          quorum: "nofm",
          quorumN: 2,
        }),
      ]),
    );
    assert.equal(narrow.sent.code, "FailedPrecondition");
    assert.equal(
      narrow.sent.message,
      "stage 0: quorum_n=2 exceeds pool size 1",
    );
  });
});

/** Only charlie, dave and grace read policy-1, and alice owns its home category. */
const narrowAccess = () => {
  const data = stewardData();
  for (const c of data.categories)
    if (c.id === "category-finance") c.rules = [];
  const expenses = data.categories.find((c) => c.id === "category-expenses")!;
  expenses.owners = ["user-alice"];
  expenses.rules = ["charlie", "dave", "grace"].map((u) =>
    raci("USER", `user-${u}`, ["ALLOW", "BLANK", "BLANK", "BLANK"]),
  );
};

describe("the read filter and the owner fallback on a mixed stage", () => {
  it("drops group members who cannot read the policy", async () => {
    narrowAccess();
    const { run } = await submitOn(
      workflowOf([review({ groupUnits: [FINANCE] })]),
    );
    assert.deepEqual(membersOf(run, "group-2"), ["user-grace"]);
    assert.deepEqual(
      run?.stages[0]?.groups?.map((g) => [g.id, g.required]),
      [["group-2", 1]],
    );
  });

  it("leaves a unit with no reader out of the run", async () => {
    narrowAccess();
    const { run } = await submitOn(
      workflowOf([
        review({
          groupUnits: [
            { ...FINANCE, groupId: "group-gone", memberUserIds: ["user-erin"] },
          ],
        }),
      ]),
    );
    assert.deepEqual(run?.stages[0]?.groups ?? [], []);
    assert.deepEqual(membersOf(run, "group-gone"), []);
  });

  it("seats the owners as individuals when the readers left cannot meet N", async () => {
    narrowAccess();
    const { run, sent } = await submitOn(
      workflowOf([
        review({
          approvers: ["user-charlie", "user-frank"],
          groupUnits: [
            { ...FINANCE, groupId: "group-gone", memberUserIds: ["user-erin"] },
          ],
          quorum: "nofm",
          quorumN: 2,
        }),
      ]),
    );
    assert.equal(sent.code, undefined, sent.message);
    // charlie is one vote; the group has no reader, so alice joins
    assert.deepEqual(individuals(run), ["user-charlie", "user-alice"]);
  });

  it("counts a unit with a reader as a vote, so no owner joins", async () => {
    narrowAccess();
    const { run } = await submitOn(
      workflowOf([
        review({
          approvers: ["user-charlie", "user-frank"],
          groupUnits: [{ ...FINANCE, memberUserIds: ["user-dave"] }],
          quorum: "nofm",
          quorumN: 2,
        }),
      ]),
    );
    assert.deepEqual(individuals(run), ["user-charlie"]);
    assert.deepEqual(membersOf(run, "group-2"), ["user-dave"]);
  });
});

const act = async (
  user: string,
  versionId: string,
  signal: "SIGNAL_TYPE_APPROVE" | "SIGNAL_TYPE_REJECT",
) => {
  const run = stewardData().runs.find((r) => r.policyVersionId === versionId)!;
  const seat = run.stages[run.currentStageIdx]!.seats.find(
    (s) => s.userId === `user-${user}` && s.state === "pending",
  )!;
  const answer = await ask(await as(user), SIGNAL, {
    comment: "Reviewed.",
    policyVersionId: versionId,
    runId: run.id,
    signal,
    taskId: seat.taskId,
  });
  assert.equal(answer.code, undefined, answer.message);
  return run;
};

const mixed = () =>
  workflowOf([
    review({
      groupUnits: [
        {
          groupId: "group-2",
          internalQuorum: "all",
          memberUserIds: ["user-grace", "user-heidi"],
        },
      ],
    }),
    review({ approvers: ["user-dave"], id: "stage-two", name: "Second" }),
  ]);

describe("a mixed stage run from submitWorkflow", () => {
  it("waits for the individual and the group, then moves on and publishes", async () => {
    const { run, versionId } = await submitOn(mixed());
    await act("charlie", versionId, "SIGNAL_TYPE_APPROVE");
    await act("grace", versionId, "SIGNAL_TYPE_APPROVE");
    assert.equal(run?.currentStageIdx, 0);
    await act("heidi", versionId, "SIGNAL_TYPE_APPROVE");
    assert.equal(run?.currentStageIdx, 1);
    await act("dave", versionId, "SIGNAL_TYPE_APPROVE");
    assert.equal(run?.status, "APPROVAL_STATUS_PUBLISHED");
  });

  it("ends the run when a group that needs all of its members loses one", async () => {
    const { run, versionId } = await submitOn(mixed());
    await act("grace", versionId, "SIGNAL_TYPE_REJECT");
    assert.equal(run?.status, "APPROVAL_STATUS_REJECTED");
  });

  it("does not let the individual's approval stand in for the group", async () => {
    const { run, versionId } = await submitOn(mixed());
    await act("charlie", versionId, "SIGNAL_TYPE_APPROVE");
    assert.equal(run?.status, "APPROVAL_STATUS_IN_REVIEW");
    assert.equal(run?.currentStageIdx, 0);
  });
});
