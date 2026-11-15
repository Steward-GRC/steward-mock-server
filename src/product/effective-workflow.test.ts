// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// effectiveWorkflow, as steward-gateway answers it (steward-gateway#140): the policy's author sees
// which workflow applies by name and whether it can run, the gate runs first and refuses anyone
// else, and the stages are never part of the answer. The workflow is the one submitWorkflow picks.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { query, startForTests, startFresh } from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

const EFFECTIVE = `query EffectiveWorkflow($policyId: ID!) {
  effectiveWorkflow(policyId: $policyId) {
    workflowDefId
    hasWorkflow
    usable
    firstUnstaffedStage
    name
  }
}`;

interface Effective {
  firstUnstaffedStage: null | string;
  hasWorkflow: boolean;
  name: null | string;
  usable: boolean;
  workflowDefId: null | string;
}

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

const effective = async (signed: Signed, policyId: string) => {
  const { body } = await query(base, EFFECTIVE, signed, { policyId });
  return {
    effective: body.data?.effectiveWorkflow as Effective | undefined,
    refused: body.errors?.[0]?.extensions.code,
  };
};

describe("effectiveWorkflow", () => {
  it("returns the workflow's name to someone who can author the policy", async () => {
    const admin = await as("user-alice");
    const { effective: ew, refused } = await effective(admin, "policy-3");
    assert.equal(refused, undefined);
    assert.deepEqual(ew, {
      firstUnstaffedStage: null,
      hasWorkflow: true,
      name: "Standard 2-stage",
      usable: true,
      workflowDefId: "workflow-2",
    });
  });

  it("falls back to the home category's workflow, as submitWorkflow does", async () => {
    const admin = await as("user-alice");
    const { effective: ew } = await effective(admin, "policy-2");
    assert.equal(ew?.hasWorkflow, true);
    assert.equal(ew?.workflowDefId, "workflow-1");
    assert.equal(ew?.name, "Finance sign-off");
  });

  it("refuses someone who can't edit the policy", async () => {
    const reader = await as("user-erin");
    const { effective: ew, refused } = await effective(reader, "policy-2");
    assert.equal(refused, "PermissionDenied");
    assert.equal(ew, undefined);
  });

  it("gives hasWorkflow false and a null name when none is configured", async () => {
    const admin = await as("user-alice");
    const { effective: ew, refused } = await effective(admin, "policy-5");
    assert.equal(refused, undefined);
    assert.deepEqual(ew, {
      firstUnstaffedStage: null,
      hasWorkflow: false,
      name: null,
      usable: true,
      workflowDefId: null,
    });
  });

  it("does not expose the stages", async () => {
    const admin = await as("user-alice");
    const { body } = await query(
      base,
      `query { effectiveWorkflow(policyId: "policy-3") { stages { name } } }`,
      admin,
    );
    assert.ok(body.errors?.length, "stages must not be selectable");
    assert.equal(body.data, undefined);
  });
});
