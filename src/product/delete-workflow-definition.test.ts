// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Mutation.deleteWorkflowDef, declared in schema-pending.graphql ahead of the gateway
// (steward-gateway#236, refs steward-gateway#62): a template admin deletes a workflow definition
// and its versions. A category default is refused first (WORKFLOW_DEF_IN_USE_BY_CATEGORY, 1247,
// gateway), then any run that ever pinned it or a policy override pointing at it
// (WORKFLOW_DEF_IN_USE, 6013, workflow); an unknown id is WORKFLOW_DEF_NOT_FOUND (6014).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
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
    | {
        extensions: { code: string } & Record<string, unknown>;
        message: string;
      }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    extensions: error?.extensions,
    message: error?.message,
  };
};

const CREATE = `mutation ($name: String!, $stages: [WorkflowStageInput!]!) {
  createWorkflowDef(name: $name, stages: $stages) { id }
}`;
const DELETE = `mutation ($id: ID!) { deleteWorkflowDef(id: $id) }`;
const READ = `query ($id: ID!) { workflowDef(id: $id) { id } }`;
const AUDIT = `query { auditLog(pageSize: 500) { records { action subject subjectLabel } } }`;

const made = async (name = "Throwaway") => {
  const answer = await ask(await as("grace"), CREATE, {
    name,
    stages: [{ approvers: ["user-charlie"], name: "Review", quorum: "one" }],
  });
  assert.equal(answer.code, undefined, answer.message);
  return (answer.data.createWorkflowDef as { id: string }).id;
};

const stillThere = async (id: string) => {
  const answer = await ask(await as("grace"), READ, { id });
  return answer.code === undefined;
};

describe("deleteWorkflowDef", () => {
  it("refuses someone without the template-admin role, as archive does", async () => {
    const id = await made();
    const answer = await ask(await as("bob"), DELETE, { id });
    assert.equal(answer.code, "PermissionDenied");
    assert.equal(await stillThere(id), true);
  });

  it("refuses a workflow a category uses as its default, with the count, and keeps it", async () => {
    const id = await made();
    const categories = stewardData().categories;
    categories[0]!.defaultWorkflowId = id;
    categories[1]!.defaultWorkflowId = id;
    const answer = await ask(await as("grace"), DELETE, { id });
    assert.equal(answer.code, "WORKFLOW_DEF_IN_USE_BY_CATEGORY");
    assert.equal(answer.extensions?.codeNum, 1247);
    assert.equal(answer.extensions?.domain, "gateway");
    assert.equal(answer.extensions?.kind, "business");
    assert.equal(answer.extensions?.id, id);
    assert.equal(answer.extensions?.category_count, "2");
    assert.equal(
      answer.message,
      "This workflow cannot be deleted while categories use it as their default (categories using it: 2). Change those categories first.",
    );
    assert.equal(await stillThere(id), true);
  });

  it("refuses a workflow a run ever pinned, with the run count, and keeps it", async () => {
    const id = await made();
    const data = stewardData();
    const template = data.runs[0]!;
    data.runs.push(
      { ...template, id: "run-pin-1", workflowDefId: id },
      { ...template, id: "run-pin-2", workflowDefId: id },
    );
    const answer = await ask(await as("grace"), DELETE, { id });
    assert.equal(answer.code, "WORKFLOW_DEF_IN_USE");
    assert.equal(answer.extensions?.codeNum, 6013);
    assert.equal(answer.extensions?.domain, "workflow");
    assert.equal(answer.extensions?.kind, "business");
    assert.equal(answer.extensions?.id, id);
    assert.equal(answer.extensions?.run_count, "2");
    assert.equal(answer.extensions?.override_count, "0");
    assert.equal(
      answer.message,
      "This workflow can't be deleted: 2 approval runs used it and 0 policies use it as their own workflow. Archive it instead.",
    );
    assert.equal(await stillThere(id), true);
  });

  it("refuses a workflow a policy uses as its own, with the override count", async () => {
    const id = await made();
    const policies = stewardData().policies;
    policies[0]!.workflowDefId = id;
    const answer = await ask(await as("grace"), DELETE, { id });
    assert.equal(answer.code, "WORKFLOW_DEF_IN_USE");
    assert.equal(answer.extensions?.run_count, "0");
    assert.equal(answer.extensions?.override_count, "1");
    assert.equal(await stillThere(id), true);
  });

  it("checks the category default before runs and overrides", async () => {
    const id = await made();
    const data = stewardData();
    data.categories[0]!.defaultWorkflowId = id;
    data.policies[0]!.workflowDefId = id;
    const answer = await ask(await as("grace"), DELETE, { id });
    assert.equal(answer.code, "WORKFLOW_DEF_IN_USE_BY_CATEGORY");
  });

  it("refuses an unknown id as not found", async () => {
    const answer = await ask(await as("grace"), DELETE, { id: "nope" });
    assert.equal(answer.code, "WORKFLOW_DEF_NOT_FOUND");
    assert.equal(answer.extensions?.codeNum, 6014);
    assert.equal(answer.extensions?.domain, "workflow");
    assert.equal(answer.extensions?.kind, "business");
    assert.equal(answer.extensions?.id, "nope");
    assert.equal(
      answer.message,
      "This workflow no longer exists. Refresh and try again.",
    );
  });

  it("deletes an unused workflow and its versions, answers true and audits it", async () => {
    const id = await made("Gone soon");
    const admin = await as("grace");
    const answer = await ask(admin, DELETE, { id });
    assert.equal(answer.code, undefined, answer.message);
    assert.equal(answer.data.deleteWorkflowDef, true);
    assert.equal(
      stewardData().workflowDefs.some((w) => w.id === id),
      false,
    );
    assert.equal(await stillThere(id), false);
    const records = (
      (await ask(await as("alice"), AUDIT)).data.auditLog as {
        records: { action: string; subject: string; subjectLabel: string }[];
      }
    ).records.filter((r) => r.action === "workflow_def.deleted");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.subject, `workflow_def:${id}`);
    assert.equal(records[0]!.subjectLabel, id);
    const again = await ask(admin, DELETE, { id });
    assert.equal(again.code, "WORKFLOW_DEF_NOT_FOUND");
  });
});
