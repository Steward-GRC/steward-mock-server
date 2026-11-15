// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The due date of an acknowledgement, as steward-obligations gives it (steward-obligations#52) and
// the gateway exposes it as `dueAt` (steward-gateway#55, #77): the publish time of the version to
// acknowledge plus the configured days (14 unless the controls say otherwise; 0 turns the dates
// off and every dueAt is null). It is on myObligations, on the roster's pending entries only, and
// on every overdue entry of the completion report.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { control } from "#core/test-client.ts";
import {
  post,
  query,
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

/** version-2 was published on 2026-08-12 and version-12 on 2026-09-29. */
const EXPENSES_DUE = "2026-08-26T00:00:00.000Z";
const VISITOR_DUE = "2026-10-13T00:00:00.000Z";

interface Entry {
  dueAt: null | string;
  userId: string;
}

const MINE = `query { myObligations { policyVersionId dueAt } }`;
const ROSTER = `query ($id: ID!) {
  ackRoster(policyVersionId: $id) { acked { userId dueAt } pending { userId dueAt } }
}`;
const REPORT = `query ($id: ID!) {
  completionReport(policyVersionId: $id) { overdue { userId dueAt } }
}`;

const obligations = async (personId: string) => {
  const { body } = await query(base, MINE, await signInAs(base, personId));
  assert.equal(body.errors, undefined);
  return body.data?.myObligations as {
    dueAt: null | string;
    policyVersionId: string;
  }[];
};

const roster = async (id: string) => {
  const { body } = await query(
    base,
    ROSTER,
    await signInAs(base, "user-alice"),
    { id },
  );
  assert.equal(body.errors, undefined);
  return body.data?.ackRoster as { acked: Entry[]; pending: Entry[] };
};

const overdue = async (id: string) => {
  const { body } = await query(
    base,
    REPORT,
    await signInAs(base, "user-alice"),
    { id },
  );
  assert.equal(body.errors, undefined);
  return (body.data?.completionReport as { overdue: Entry[] }).overdue;
};

describe("dueAt", () => {
  it("is the publish time of the version plus 14 days on what someone still owes", async () => {
    const due = Object.fromEntries(
      (await obligations("user-erin")).map((o) => [o.policyVersionId, o.dueAt]),
    );
    assert.deepEqual(due, {
      "version-12": VISITOR_DUE,
      "version-2": EXPENSES_DUE,
    });
  });

  it("is on the roster's pending entries only", async () => {
    const { acked, pending } = await roster("version-2");
    assert.ok(acked.length > 0 && pending.length > 0);
    for (const entry of pending) assert.equal(entry.dueAt, EXPENSES_DUE);
    for (const entry of acked) assert.equal(entry.dueAt, null);
  });

  it("is on every overdue entry", async () => {
    const entries = await overdue("version-2");
    assert.ok(entries.length > 0);
    for (const entry of entries) assert.equal(entry.dueAt, EXPENSES_DUE);
  });

  it("follows the days the controls set", async () => {
    await control(base, { days: 30, kind: "ack-due-days" });
    const first = (await obligations("user-erin")).find(
      (o) => o.policyVersionId === "version-2",
    );
    assert.equal(first?.dueAt, "2026-09-11T00:00:00.000Z");
  });

  it("is null everywhere when the days are 0", async () => {
    await control(base, { days: 0, kind: "ack-due-days" });
    for (const o of await obligations("user-erin")) assert.equal(o.dueAt, null);
    for (const entry of (await roster("version-2")).pending)
      assert.equal(entry.dueAt, null);
    for (const entry of await overdue("version-2"))
      assert.equal(entry.dueAt, null);
  });

  it("goes back to 14 days on a reset, and refuses days that are not a whole number of 0 or more", async () => {
    await control(base, { days: 0, kind: "ack-due-days" });
    startFresh();
    assert.ok((await obligations("user-erin")).every((o) => o.dueAt !== null));
    for (const days of [-1, 1.5, "7", null]) {
      const answer = await post(base, "/_mock/controls", {
        days,
        kind: "ack-due-days",
      });
      assert.equal(answer.status, 400);
    }
  });
});
