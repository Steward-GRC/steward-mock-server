// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// StageAssignee.changesRequested and changesRequestedAt, as steward-gateway serves them
// (steward-gateway#106): an approver who sends comments back keeps their seat open (state pending,
// comment null), and the seat shows the latest comment sent and when. The two fields stay after the
// seat later decides, and a reader who sees the policy obfuscated gets neither. They are not on the
// pinned gateway schema yet, so they are read here with a query of their own.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  demoteAlice,
  query,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

interface Seat {
  changesRequested: null | string;
  changesRequestedAt: null | string;
  comment: null | string;
  state: string;
  userId: string;
}

// version-4 is Travel Booking Procedure's draft in review; Charlie (task-1) and Alice (task-2) are
// on its first stage. The policy is SENSITIVE: Alice, a site admin who neither owns it nor has the
// sensitive-read right, reads it obfuscated; Charlie and Bob, its author, read it in full.
const VERSION = "version-4";
const RUN = { policyVersionId: VERSION, runId: "run-1" };
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

const as = async (
  user: string,
  operation: string,
  variables: Record<string, unknown>,
) => call(base, await signInAs(base, user), operation, variables);

const STATUS = `query ($v: ID!) { workflowStatus(policyVersionId: $v) {
  stageAssignees { userId state comment changesRequested changesRequestedAt }
} }`;

/** The first stage's seats, as the given person reads them. */
const seats = async (user: string): Promise<Seat[]> => {
  const { body } = await query(base, STATUS, await signInAs(base, user), {
    v: VERSION,
  });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  const status = body.data?.workflowStatus as { stageAssignees: Seat[][] };
  return status.stageAssignees[0] ?? [];
};
const seatOf = (all: Seat[], userId: string) => {
  const seat = all.find((s) => s.userId === userId);
  assert.ok(seat, `no seat for ${userId}`);
  return seat;
};

const sendComments = async (user: string, comment: string) => {
  const sent = await as(user, "SignalWorkflow", {
    ...RUN,
    comment,
    signal: "SIGNAL_TYPE_REQUEST_CHANGES",
    taskId: user === "user-charlie" ? "task-1" : "task-2",
  });
  assert.equal(sent.refused, undefined, JSON.stringify(sent));
};

describe("a seat that asked for changes", () => {
  it("shows no request before anyone sends comments", async () => {
    for (const seat of await seats("user-bob")) {
      assert.equal(seat.changesRequested, null, seat.userId);
      assert.equal(seat.changesRequestedAt, null, seat.userId);
    }
  });

  it("carries the comment and the time, and stays pending with no decision comment", async () => {
    const before = Date.now();
    await sendComments("user-charlie", "See my comments.");
    const seat = seatOf(await seats("user-bob"), "user-charlie");
    assert.equal(seat.state, "pending");
    assert.equal(seat.comment, null);
    assert.equal(seat.changesRequested, "See my comments.");
    assert.ok(seat.changesRequestedAt);
    const at = Date.parse(seat.changesRequestedAt);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "an ISO time");
  });

  it("leaves the other seats without a request", async () => {
    await sendComments("user-charlie", "See my comments.");
    const other = seatOf(await seats("user-bob"), "user-alice");
    assert.equal(other.changesRequested, null);
    assert.equal(other.changesRequestedAt, null);
  });

  it("keeps the latest comment when the approver asks again", async () => {
    await sendComments("user-charlie", "First pass.");
    await sendComments("user-charlie", "Second pass.");
    const seat = seatOf(await seats("user-bob"), "user-charlie");
    assert.equal(seat.changesRequested, "Second pass.");
  });

  it("keeps the request after the seat decides, beside the decision comment", async () => {
    await sendComments("user-charlie", "See my comments.");
    const approved = await as("user-charlie", "SignalWorkflow", {
      ...RUN,
      comment: "Fine now.",
      signal: "SIGNAL_TYPE_APPROVE",
      taskId: "task-1",
    });
    assert.equal(approved.refused, undefined, JSON.stringify(approved));
    const seat = seatOf(await seats("user-bob"), "user-charlie");
    assert.equal(seat.state, "approved");
    assert.equal(seat.comment, "Fine now.");
    assert.equal(seat.changesRequested, "See my comments.");
    assert.ok(seat.changesRequestedAt);
  });

  it("is hidden from a reader who sees the policy obfuscated", async () => {
    demoteAlice();
    await sendComments("user-charlie", "See my comments.");
    const read = await query(
      base,
      `{ policy(id: "policy-3") { viewerCan { contentObfuscated } } }`,
      await signInAs(base, "user-alice"),
    );
    assert.deepEqual(read.body.data?.policy, {
      viewerCan: { contentObfuscated: true },
    });
    const seat = seatOf(await seats("user-alice"), "user-charlie");
    assert.equal(seat.state, "pending");
    assert.equal(seat.changesRequested, null);
    assert.equal(seat.changesRequestedAt, null);
  });
});
