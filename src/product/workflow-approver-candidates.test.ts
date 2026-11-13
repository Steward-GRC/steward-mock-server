// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// workflowApproverCandidates (steward-gateway#215): who the workflow editor may offer as an
// approver. A workflow draws its approvers from the categories that use it as their default
// workflow, so the answer is the union of those categories' Approve pools; a workflow no category
// uses has nobody to offer and says it is not attached.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
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

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const first = body.errors?.[0] as
    | { extensions: { code: string }; message?: string }
    | undefined;
  return {
    code: first?.extensions.code,
    // oxlint-disable-next-line typescript/no-explicit-any
    data: (body.data ?? {}) as Record<string, any>,
    message: first?.message,
  };
};

const as = (id: string) => signInAs(base, id);

const RULES = `mutation ($categoryId: ID!, $rules: [RaciRuleInput!]!) {
  setCategoryRuleset(categoryId: $categoryId, rules: $rules) { categoryId }
}`;

const row = (
  subjectKind: string,
  subjectReference: string,
  cells: Partial<
    Record<"ack" | "approve" | "author" | "manage" | "read", string>
  >,
) => ({
  ack: "BLANK",
  approve: "BLANK",
  author: "BLANK",
  manage: "BLANK",
  read: "BLANK",
  ...cells,
  subjectKind,
  subjectRef: subjectReference,
});

const setRules = async (categoryId: string, rules: unknown[]) => {
  const answer = await ask(await as("user-alice"), RULES, {
    categoryId,
    rules,
  });
  assert.equal(answer.code, undefined, answer.message);
};

const CANDIDATES = `query ($workflowId: ID!) {
  workflowApproverCandidates(workflowId: $workflowId) {
    workflowId attached categoryIds users { userId }
  }
}`;
const APPROVERS = `query ($categoryId: ID!) { categoryApprovers(categoryId: $categoryId) { userId } }`;
const ATTACH = `mutation ($id: ID!, $workflowId: ID) {
  setCategoryDefaults(id: $id, defaultWorkflowId: $workflowId) { id defaultWorkflowId }
}`;

const attach = async (categoryId: string, workflowId: string) => {
  const answer = await ask(await as("user-alice"), ATTACH, {
    id: categoryId,
    workflowId,
  });
  assert.equal(answer.code, undefined, answer.message);
};

const candidates = async (workflowId: string, who = "user-alice") => {
  const answer = await ask(await as(who), CANDIDATES, { workflowId });
  return {
    ...answer,
    result: answer.data.workflowApproverCandidates as
      | {
          attached: boolean;
          categoryIds: string[];
          users: { userId: string }[];
          workflowId: string;
        }
      | undefined,
  };
};

const poolIds = async (categoryId: string) =>
  (
    await ask(await as("user-alice"), APPROVERS, { categoryId })
  ).data.categoryApprovers.map((u: { userId: string }) => u.userId);

describe("workflowApproverCandidates", () => {
  it("offers the Approve pool of the category that uses the workflow", async () => {
    const { code, message, result } = await candidates("workflow-2");
    assert.equal(code, undefined, message);
    assert.equal(result?.workflowId, "workflow-2");
    assert.equal(result?.attached, true);
    assert.deepEqual(result?.categoryIds, ["category-facilities"]);
    assert.deepEqual(
      result?.users.map((u) => u.userId),
      await poolIds("category-facilities"),
    );
  });

  it("offers nobody, and says so, for a workflow no category uses", async () => {
    const { code, message, result } = await candidates("workflow-3");
    assert.equal(code, undefined, message);
    assert.deepEqual(result, {
      attached: false,
      categoryIds: [],
      users: [],
      workflowId: "workflow-3",
    });
  });

  it("leaves root out unless a row allows Approve", async () => {
    await setRules("category-leave", []);
    await attach("category-leave", "workflow-3");
    const without = await candidates("workflow-3");
    assert.equal(without.result?.attached, true);
    assert.ok(!without.result?.users.some((u) => u.userId === "user-alice"));
    await setRules("category-leave", [
      row("USER", "user-alice", { approve: "ALLOW" }),
    ]);
    const allowed = await candidates("workflow-3");
    assert.deepEqual(
      allowed.result?.users.map((u) => u.userId),
      ["user-alice"],
    );
  });

  it("is the union of every category that uses the workflow, each person once", async () => {
    await attach("category-leave", "workflow-3");
    await attach("category-expenses", "workflow-3");
    const { result } = await candidates("workflow-3");
    assert.deepEqual(result?.categoryIds.toSorted(), [
      "category-expenses",
      "category-leave",
    ]);
    const ids = result?.users.map((u) => u.userId) ?? [];
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      ids.toSorted(),
      [
        ...new Set([
          ...(await poolIds("category-expenses")),
          ...(await poolIds("category-leave")),
        ]),
      ].toSorted(),
    );
  });

  it("is for template admins and above, and an unknown workflow is NotFound", async () => {
    assert.equal(
      (await candidates("workflow-2", "user-erin")).code,
      "PermissionDenied",
    );
    assert.equal((await candidates("workflow-nowhere")).code, "NotFound");
  });
});
