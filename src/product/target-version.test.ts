// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// workflowStatus names what the run publishes, as steward-gateway does (steward-gateway#240,
// refs steward-gateway#52): targetSemanticVersion and targetChangeType are the semantic version
// and change type of the policy version the run is on, and null when there is no run or none is
// known.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

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
    runId
    targetSemanticVersion
    targetChangeType
  }
}`;
const VERSION = `query ($id: ID!) {
  policyVersion(id: $id) { semanticVersion changeType }
}`;

interface Numbers {
  changeType: null | string;
  semanticVersion: null | string;
}
interface Target {
  runId: string;
  targetChangeType: null | string;
  targetSemanticVersion: null | string;
}

const statusOf = async (policyVersionId: string) => {
  const { body } = await query(
    base,
    STATUS,
    await signInAs(base, "user-alice"),
    { policyVersionId },
  );
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data?.workflowStatus as Target;
};

describe("workflowStatus target version", () => {
  it("shows 3.0.0 and MAJOR on a seeded run in review", async () => {
    const status = await statusOf("version-4");
    assert.equal(status.runId, "run-1");
    assert.equal(status.targetSemanticVersion, "3.0.0");
    assert.equal(status.targetChangeType, "MAJOR");
  });

  it("answers the same as the version itself", async () => {
    const alice = await signInAs(base, "user-alice");
    const { body } = await query(base, VERSION, alice, { id: "version-4" });
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const version = body.data?.policyVersion as Numbers;
    const status = await statusOf("version-4");
    assert.equal(status.targetSemanticVersion, version.semanticVersion);
    assert.equal(status.targetChangeType, version.changeType);
  });

  it("is null when the version has no run", async () => {
    const status = await statusOf("version-1");
    assert.equal(status.runId, "");
    assert.equal(status.targetSemanticVersion, null);
    assert.equal(status.targetChangeType, null);
  });

  it("is null for a run on a first version, which has no change type", async () => {
    const status = await statusOf("version-3");
    assert.equal(status.targetChangeType, null);
  });
});
