// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The signed-in person's acknowledgement obligations, as steward-gateway's myObligations and
// myAckSummary answer them from steward-obligations: the published policies with acknowledgement
// triggers the person may acknowledge (a sensitive one only with the read-sensitive grant), less
// the ones they've cleared (ON_PUBLISH by acknowledging any version, ON_CHANGE by acknowledging
// the published one).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { post, startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

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

const EXPENSES = {
  number: "POL-EXPENSES-000002",
  policyId: "policy-1",
  policyVersionId: "version-2",
  title: "Expense Claims Policy",
  version: "3",
};
const DESK = {
  number: "POL-FACILITIES-000001",
  policyId: "policy-9",
  policyVersionId: "version-11",
  title: "Desk Booking Policy",
  version: "1",
};
const VISITOR = {
  number: "POL-FACILITIES-000004",
  policyId: "policy-10",
  policyVersionId: "version-12",
  title: "Visitor Sign-in Policy",
  version: "1",
};

const obligationsOf = async (personId: string) => {
  const answer = await call(
    base,
    await signInAs(base, personId),
    "MyObligations",
  );
  assert.equal(answer.refused, undefined);
  return answer.data.myObligations;
};

const summaryOf = async (personId: string) => {
  const answer = await call(
    base,
    await signInAs(base, personId),
    "MyAckSummary",
  );
  assert.equal(answer.refused, undefined);
  return answer.data.myAckSummary;
};

describe("myObligations", () => {
  it("lists what Erin still has to acknowledge, not what she already has", async () => {
    assert.deepEqual(await obligationsOf("user-erin"), [EXPENSES, VISITOR]);
  });

  it("drops a policy once it's acknowledged", async () => {
    const erin = await signInAs(base, "user-erin");
    await call(base, erin, "RecordAck", {
      policyVersionId: VISITOR.policyVersionId,
    });
    assert.deepEqual(
      (await call(base, erin, "MyObligations")).data.myObligations,
      [EXPENSES],
    );
  });

  it("gives Bob and Charlie what they still owe", async () => {
    assert.deepEqual(await obligationsOf("user-bob"), [DESK, VISITOR]);
    assert.deepEqual(await obligationsOf("user-charlie"), [DESK, VISITOR]);
  });

  it("needs someone signed in", async () => {
    const answer = await post(base, "/query", {
      query: "query { myObligations { policyId } }",
    });
    assert.equal(answer.status, 401);
  });
});

describe("myAckSummary", () => {
  it("counts what each person is asked to acknowledge and what they've done", async () => {
    assert.deepEqual(await summaryOf("user-erin"), { done: 1, required: 3 });
    assert.deepEqual(await summaryOf("user-bob"), { done: 1, required: 3 });
    assert.deepEqual(await summaryOf("user-charlie"), { done: 1, required: 3 });
  });

  it("counts a new acknowledgement as done", async () => {
    const erin = await signInAs(base, "user-erin");
    await call(base, erin, "RecordAck", {
      policyVersionId: VISITOR.policyVersionId,
    });
    assert.deepEqual(
      (await call(base, erin, "MyAckSummary")).data.myAckSummary,
      {
        done: 2,
        required: 3,
      },
    );
  });
});
