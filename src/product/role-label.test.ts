// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// StageAssignee.roleLabel (steward-gateway#242, refs steward-gateway#52): why the person holds
// the seat, as the stepper shows it. "Approver" when the workflow names them (an individual
// approver or a member of a group unit), "Category owner" when the home category's owner joined
// to meet the stage's quorum, and null when the seat does not record where it came from.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Workflow } from "#product/data/library.ts";

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

const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) {
    stageAssignees { userId groupId roleLabel }
  }
}`;
const SAVE = `mutation ($policyId: ID!, $contentJson: String!) {
  saveDraft(policyId: $policyId, contentJson: $contentJson) { id }
}`;
const SUBMIT = `mutation ($policyVersionId: ID!, $policyId: ID!, $categoryId: ID!) {
  submitWorkflow(policyVersionId: $policyVersionId, policyId: $policyId, categoryId: $categoryId, ancestorCategoryIds: []) { runId }
}`;

interface Assignee {
  groupId: null | string;
  roleLabel: null | string;
  userId: string;
}

/** Who sits on each stage of a version's run, with the label the stepper shows. */
const assigneesOf = async (policyVersionId: string) => {
  const { body } = await query(base, STATUS, await signInAs(base, "user-bob"), {
    policyVersionId,
  });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  const status = body.data?.workflowStatus as { stageAssignees: Assignee[][] };
  return status.stageAssignees.map((row) =>
    Object.fromEntries(row.map((a) => [a.userId, a.roleLabel])),
  );
};

const LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: "normal",
            style: "",
            text: "A new edition.",
            type: "text",
            version: 1,
          },
        ],
        direction: null,
        format: "",
        indent: 0,
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
  const author = await signInAs(base, "user-bob");
  const draft = await query(base, SAVE, author, {
    contentJson: LEXICAL,
    policyId: "policy-1",
  });
  assert.equal(draft.body.errors, undefined, JSON.stringify(draft.body.errors));
  const versionId = (draft.body.data?.saveDraft as { id: string }).id;
  const sent = await query(base, SUBMIT, author, {
    categoryId: policy.homeCategoryId,
    policyId: "policy-1",
    policyVersionId: versionId,
  });
  assert.equal(sent.body.errors, undefined, JSON.stringify(sent.body.errors));
  return versionId;
};

const workflowOf = (stages: Workflow["stages"]): Workflow => ({
  archived: false,
  description: null,
  id: "workflow-role-label",
  name: "Role label",
  stages,
  version: 1,
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

describe("the seeded run in review", () => {
  it("shows an Approver and a Category owner seat", async () => {
    const stages = await assigneesOf("version-4");
    assert.deepEqual(stages, [
      {
        "user-alice": "Category owner",
        "user-charlie": "Approver",
      },
      { "user-alice": "Approver" },
    ]);
  });

  it("is null for a seat that records no source", async () => {
    const run = stewardData().runs.find((r) => r.id === "run-1")!;
    delete run.stages[0]!.seats[0]!.source;
    const stages = await assigneesOf("version-4");
    assert.equal(stages[0]?.["user-charlie"], null);
    assert.equal(stages[0]?.["user-alice"], "Category owner");
  });
});

describe("a run made by submit", () => {
  it("labels the named approvers Approver", async () => {
    const versionId = await submitOn(
      workflowOf([
        stage({
          approvers: ["user-charlie", "user-alice"],
          id: "stage-a",
          name: "Review",
        }),
      ]),
    );
    assert.deepEqual(await assigneesOf(versionId), [
      { "user-alice": "Approver", "user-charlie": "Approver" },
    ]);
  });

  it("labels an owner who joined to meet the quorum Category owner", async () => {
    narrowAccess();
    const versionId = await submitOn(
      workflowOf([
        stage({
          approvers: ["user-charlie", "user-frank", "user-erin"],
          id: "stage-b",
          name: "Review",
          quorum: "nofm",
          quorumN: 2,
        }),
      ]),
    );
    assert.deepEqual(await assigneesOf(versionId), [
      { "user-alice": "Category owner", "user-charlie": "Approver" },
    ]);
  });

  it("labels a group unit's members Approver", async () => {
    const versionId = await submitOn(
      workflowOf([
        stage({
          approvers: ["user-charlie"],
          groupUnits: [
            {
              groupId: "group-finance",
              internalQuorum: "one",
              memberUserIds: ["user-grace"],
            },
          ],
          id: "stage-c",
          name: "Review",
        }),
      ]),
    );
    assert.deepEqual(await assigneesOf(versionId), [
      { "user-charlie": "Approver", "user-grace": "Approver" },
    ]);
  });
});
