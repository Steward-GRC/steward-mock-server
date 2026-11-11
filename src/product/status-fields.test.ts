// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// workflowStatus tells who submitted the run and when, and per stage its due date and rule with
// the individual approvals it has and needs (steward-gateway#68, steward-workflow#49). The
// approvals and required counts are for individual seats only; group units keep their own tally
// in stageUnitProgress. A stage not yet entered has no due date.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Run, Seat } from "#product/data/policies.ts";

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

const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) {
    submittedBy
    submittedAt
    stageNames
    stageProgress { dueAt quorum quorumN approvals required }
  }
}`;

interface Progress {
  approvals: number;
  dueAt: null | string;
  quorum: string;
  quorumN: number;
  required: number;
}
interface Status {
  stageNames: string[];
  stageProgress: Progress[];
  submittedAt: null | string;
  submittedBy: null | string;
}

const statusOf = async (versionId = "version-4") => {
  const { body } = await query(
    base,
    STATUS,
    await signInAs(base, "user-alice"),
    { policyVersionId: versionId },
  );
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data?.workflowStatus as Status;
};

const seat = (user: string, state = "pending", groupId?: string): Seat => ({
  comment: null,
  decidedAt: null,
  state,
  taskId: `t-${user}-${groupId ?? "solo"}`,
  userId: user,
  ...(groupId ? { groupId } : {}),
});

/** Replace version-4's seeded run with one on the given stages. */
const putRun = (stages: Run["stages"], stageIndex = 0) => {
  const data = stewardData();
  data.runs = data.runs.filter((r) => r.policyVersionId !== "version-4");
  data.runs.push({
    currentStageIdx: stageIndex,
    id: "run-fields",
    policyId: "policy-3",
    policyVersionId: "version-4",
    stages,
    status: "APPROVAL_STATUS_IN_REVIEW",
    submittedAt: "2026-11-02T09:30:00Z",
    submittedBy: "user-dave",
    workflowDefId: "workflow-2",
  });
};

describe("workflowStatus submission and stage fields", () => {
  it("says who submitted the seeded in-review run and when", async () => {
    const status = await statusOf();
    assert.equal(status.submittedBy, "user-bob");
    assert.equal(status.submittedAt, "2026-09-20T00:00:00Z");
    assert.equal(status.stageProgress.length, status.stageNames.length);
  });

  it("carries each stage's rule, nofm with its N", async () => {
    putRun([
      {
        name: "All",
        quorum: "all",
        seats: [seat("user-charlie"), seat("user-alice"), seat("user-dave")],
      },
      {
        name: "Some",
        quorum: "nofm",
        quorumN: 2,
        seats: [seat("user-charlie"), seat("user-alice"), seat("user-dave")],
      },
      {
        name: "Most",
        quorum: "majority",
        seats: [seat("user-charlie"), seat("user-alice"), seat("user-dave")],
      },
      { name: "Any", quorum: "one", seats: [seat("user-alice")] },
    ]);
    const { stageProgress: p } = await statusOf();
    assert.deepEqual(
      p.map((s) => [s.quorum, s.quorumN, s.required]),
      [
        ["all", 0, 3],
        ["nofm", 2, 2],
        ["majority", 0, 2],
        ["one", 0, 1],
      ],
    );
  });

  it("counts individual seats only, leaving group units to stageUnitProgress", async () => {
    putRun([
      {
        groups: [{ id: "group-x", name: "X", quorum: "one", required: 1 }],
        name: "Mixed",
        quorum: "all",
        seats: [
          seat("user-charlie", "approved"),
          seat("user-alice"),
          seat("user-dave", "approved", "group-x"),
          seat("user-erin", "pending", "group-x"),
        ],
      },
    ]);
    const [p] = (await statusOf()).stageProgress;
    assert.equal(p?.approvals, 1);
    assert.equal(p?.required, 2);
  });

  it("gives dueAt only to a stage that has been entered", async () => {
    putRun(
      [
        {
          dueAt: "2026-11-07T09:30:00Z",
          name: "Entered",
          quorum: "one",
          seats: [seat("user-alice")],
        },
        { name: "Later", quorum: "one", seats: [seat("user-alice")] },
      ],
      0,
    );
    const p = (await statusOf()).stageProgress;
    assert.equal(p[0]?.dueAt, "2026-11-07T09:30:00Z");
    assert.equal(p[1]?.dueAt, null);
  });

  it("fixes the first stage's due date from the submit time and its SLA", async () => {
    const data = stewardData();
    const policy = data.policies.find((p) => p.id === "policy-1")!;
    policy.workflowDefId = "workflow-2";
    const author = await signInAs(base, "user-bob");
    const draft = await query(
      base,
      `mutation ($policyId: ID!, $contentJson: String!) { saveDraft(policyId: $policyId, contentJson: $contentJson) { id } }`,
      author,
      {
        contentJson: JSON.stringify({
          root: {
            children: [
              {
                children: [{ text: "Words.", type: "text", version: 1 }],
                type: "paragraph",
                version: 1,
              },
            ],
            type: "root",
            version: 1,
          },
        }),
        policyId: "policy-1",
      },
    );
    const versionId = (draft.body.data?.saveDraft as { id: string }).id;
    const sent = await query(
      base,
      `mutation ($v: ID!, $p: ID!, $c: ID!) { submitWorkflow(policyVersionId: $v, policyId: $p, categoryId: $c, ancestorCategoryIds: []) { runId } }`,
      author,
      { c: policy.homeCategoryId, p: "policy-1", v: versionId },
    );
    assert.equal(sent.body.errors, undefined, JSON.stringify(sent.body.errors));
    const status = await statusOf(versionId);
    const submitted = Date.parse(status.submittedAt!);
    // workflow-2's Review stage has a five-day SLA; its Final approval has none
    assert.equal(
      Date.parse(status.stageProgress[0]!.dueAt!) - submitted,
      5 * 24 * 3600 * 1000,
    );
    assert.equal(status.stageProgress[1]!.dueAt, null);
    assert.equal(status.submittedBy, "user-bob");
  });
});
