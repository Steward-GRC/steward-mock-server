// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A procedure shares the policies surface but is excluded from acknowledgement, as steward-core
// and steward-obligations treat it: viewerCan.ack is false for it however the acknowledgement
// trigger is set, and it obliges nobody (myObligations and the acknowledgement audience behind the
// completion report and ackActivity include nothing for it). The same record read as a policy is
// unchanged, so the document type is the only thing that turns the rule on.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

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

// The seeded published procedure (Lost Device Procedure) and its published version.
const PROCEDURE_ID = "policy-6";
const PROCEDURE_VERSION = "version-7";

const askForAck = (documentType: "POLICY" | "PROCEDURE") => {
  const record = stewardData().policies.find((p) => p.id === PROCEDURE_ID);
  assert.ok(record);
  record.documentType = documentType;
  record.ackTriggers = "ON_PUBLISH";
  record.ackAudienceOverride = null;
  record.sensitivity = "STANDARD";
};

const viewerCanAck = async (personId: string) => {
  const { body } = await query(
    base,
    `query ($id: ID!) { policy(id: $id) { viewerCan { ack read } } }`,
    await signInAs(base, personId),
    { id: PROCEDURE_ID },
  );
  assert.equal(body.errors, undefined);
  return (body.data?.policy as { viewerCan: { ack: boolean; read: boolean } })
    .viewerCan;
};

const owedPolicyIds = async (personId: string) => {
  const { body } = await query(
    base,
    "query { myObligations { policyId } }",
    await signInAs(base, personId),
  );
  assert.equal(body.errors, undefined);
  return (body.data?.myObligations as { policyId: string }[]).map(
    (o) => o.policyId,
  );
};

// The audience is observable through the views ackActivity counts, which are limited to it.
const audienceViews = async (viewer: string) => {
  await query(
    base,
    `mutation { recordView(policyVersionId: "${PROCEDURE_VERSION}") }`,
    await signInAs(base, viewer),
  );
  const { body } = await query(
    base,
    `query { ackActivity(policyVersionId: "${PROCEDURE_VERSION}", days: 1) { views } }`,
    await signInAs(base, "user-alice"),
  );
  assert.equal(body.errors, undefined);
  return (body.data?.ackActivity as { views: number }[])[0]?.views ?? 0;
};

describe("a procedure is excluded from acknowledgement", () => {
  it("has viewerCan.ack false even when the trigger asks for acknowledgement", async () => {
    askForAck("PROCEDURE");
    for (const person of ["user-erin", "user-bob", "user-alice"]) {
      const can = await viewerCanAck(person);
      assert.equal(can.read, true, `${person} reads it`);
      assert.equal(can.ack, false, `${person} does not acknowledge it`);
    }
  });

  it("obliges nobody in myObligations", async () => {
    askForAck("PROCEDURE");
    for (const person of ["user-erin", "user-bob", "user-charlie"])
      assert.ok(
        !(await owedPolicyIds(person)).includes(PROCEDURE_ID),
        `${person} owes nothing on a procedure`,
      );
  });

  it("has an empty acknowledgement audience", async () => {
    askForAck("PROCEDURE");
    assert.equal(await audienceViews("user-erin"), 0);
  });

  it("changes nothing for the same record read as a policy", async () => {
    askForAck("POLICY");
    assert.equal((await viewerCanAck("user-erin")).ack, true);
    assert.ok((await owedPolicyIds("user-erin")).includes(PROCEDURE_ID));
    assert.equal(await audienceViews("user-erin"), 1);
  });
});
