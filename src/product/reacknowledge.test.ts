// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// PolicyVersion.reacknowledge, as steward-gateway answers it (steward-gateway#232): true only for
// a POLICY whose acknowledgement trigger is ON_CHANGE and whose change type is MAJOR. The type is
// the argument when given, else the version's own, else its suggestion.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { ChangeType } from "#product/semver.ts";

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

const ASK = `query ($id: ID!, $changeType: ChangeType) {
  policyVersion(id: $id) { reacknowledge(changeType: $changeType) }
}`;

const reacknowledge = async (
  id: string,
  changeType?: ChangeType,
): Promise<boolean> => {
  const signed = await signInAs(base, "user-erin");
  const { body } = await query(base, ASK, signed, {
    changeType: changeType ?? null,
    id,
  });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as { policyVersion: { reacknowledge: boolean } })
    .policyVersion.reacknowledge;
};

/** The expenses policy (policy-1) with its published version-2 stored as the given type. */
const expensesOnChange = (type: ChangeType, suggested: ChangeType = type) => {
  const data = stewardData();
  const policy = data.policies.find((p) => p.id === "policy-1");
  const version = data.versions.find((v) => v.id === "version-2");
  assert.ok(policy && version);
  policy.ackTriggers = "ON_CHANGE";
  version.change = {
    agreedBy: [],
    reason: "",
    requested: null,
    setBy: null,
    suggested,
    type,
  };
};

describe("PolicyVersion.reacknowledge", () => {
  it("is true for a MAJOR change on an ON_CHANGE policy", async () => {
    expensesOnChange("MAJOR");
    assert.equal(await reacknowledge("version-2"), true);
  });

  it("is false for MINOR and for FIX", async () => {
    expensesOnChange("MINOR");
    assert.equal(await reacknowledge("version-2"), false);
    expensesOnChange("FIX");
    assert.equal(await reacknowledge("version-2"), false);
  });

  it("lets the argument override a stored MINOR up to MAJOR", async () => {
    expensesOnChange("MINOR");
    assert.equal(await reacknowledge("version-2", "MAJOR"), true);
  });

  it("lets the argument override a stored MAJOR down to MINOR or FIX", async () => {
    expensesOnChange("MAJOR");
    assert.equal(await reacknowledge("version-2", "MINOR"), false);
    assert.equal(await reacknowledge("version-2", "FIX"), false);
  });

  it("is false for a policy that only acknowledges on publish", async () => {
    expensesOnChange("MAJOR");
    const policy = stewardData().policies.find((p) => p.id === "policy-1");
    assert.ok(policy);
    policy.ackTriggers = "ON_PUBLISH";
    assert.equal(await reacknowledge("version-2"), false);
    assert.equal(await reacknowledge("version-2", "MAJOR"), false);
  });

  it("reads the trigger from the category when the policy sets none", async () => {
    expensesOnChange("MAJOR");
    const data = stewardData();
    const policy = data.policies.find((p) => p.id === "policy-1");
    const category = data.categories.find(
      (c) => c.id === policy?.homeCategoryId,
    );
    assert.ok(policy && category);
    policy.ackTriggers = null;
    category.ackTriggers = "ON_CHANGE";
    assert.equal(await reacknowledge("version-2"), true);
    category.ackTriggers = "ON_PUBLISH";
    assert.equal(await reacknowledge("version-2"), false);
  });

  it("is false for a procedure, which has no acknowledgements", async () => {
    expensesOnChange("MAJOR");
    const procedure = stewardData().policies.find((p) => p.id === "policy-1");
    assert.ok(procedure);
    procedure.documentType = "PROCEDURE";
    assert.equal(await reacknowledge("version-2"), false);
    assert.equal(await reacknowledge("version-2", "MAJOR"), false);
  });

  it("is false when no acknowledgement is required", async () => {
    expensesOnChange("MAJOR");
    const policy = stewardData().policies.find((p) => p.id === "policy-1");
    assert.ok(policy);
    policy.ackTriggers = "NONE";
    assert.equal(await reacknowledge("version-2", "MAJOR"), false);
  });

  it("is false for a first version, which has no change type", async () => {
    const policy = stewardData().policies.find((p) => p.id === "policy-1");
    assert.ok(policy);
    policy.ackTriggers = "ON_CHANGE";
    assert.equal(await reacknowledge("version-1"), false);
    assert.equal(await reacknowledge("version-1", "MAJOR"), true);
  });
});
