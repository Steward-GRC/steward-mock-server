// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// ackActivity, the daily acknowledgement and view series behind steward-web's completion chart
// (A14), as steward-gateway answers it from steward-obligations' Activity: one entry per UTC day
// from `days - 1` days ago through today, oldest first, empty days included; acks counts every
// acknowledgement of the version that day; views counts the distinct people in the version's
// acknowledgement audience who viewed it that day; groupId is accepted and ignored. Views come
// from recordView.

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

interface Day {
  acks: number;
  date: string;
  views: number;
}

const ACTIVITY = `query ($id: ID!, $groupId: ID, $days: Int!) {
  ackActivity(policyVersionId: $id, groupId: $groupId, days: $days) { date acks views }
}`;

const activity = async (
  signed: Signed,
  id: string,
  days: number,
  groupId?: string,
) => {
  const { body } = await query(base, ACTIVITY, signed, { days, groupId, id });
  const error = body.errors?.[0] as
    | { extensions: { code: string } }
    | undefined;
  return {
    code: error?.extensions.code,
    days: (body.data?.ackActivity ?? []) as Day[],
  };
};

const utcDay = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const total = (days: Day[], key: "acks" | "views") =>
  days.reduce((sum, day) => sum + day[key], 0);

describe("ackActivity", () => {
  it("answers one UTC day per entry, oldest first, through today, empty days included", async () => {
    const { days } = await activity(
      await signInAs(base, "user-alice"),
      "version-11",
      30,
    );
    assert.equal(days.length, 30);
    assert.equal(days[0]?.date, utcDay(29));
    assert.equal(days.at(-1)?.date, utcDay(0));
    for (const day of days) {
      assert.match(day.date, /^\d{4}-\d\d-\d\d$/);
      assert.ok(Number.isInteger(day.acks) && Number.isInteger(day.views));
    }
    assert.ok(days.some((day) => day.acks === 0 && day.views === 0));
  });

  it("answers 30 days for a window of zero or less", async () => {
    const admin = await signInAs(base, "user-alice");
    assert.equal((await activity(admin, "version-11", 0)).days.length, 30);
    assert.equal((await activity(admin, "version-11", -5)).days.length, 30);
  });

  it("shows acknowledgements and views on every obligating policy in 30 and 90 days", async () => {
    const admin = await signInAs(base, "user-alice");
    for (const id of ["version-11", "version-12", "version-2"])
      for (const window of [30, 90]) {
        const { days } = await activity(admin, id, window);
        assert.ok(total(days, "acks") > 0, `${id} ${String(window)} acks`);
        assert.ok(total(days, "views") > 0, `${id} ${String(window)} views`);
      }
    const month = await activity(admin, "version-2", 30);
    const quarter = await activity(admin, "version-2", 90);
    assert.ok(total(quarter.days, "acks") > total(month.days, "acks"));
  });

  it("ignores the group, as obligations does", async () => {
    const admin = await signInAs(base, "user-alice");
    assert.deepEqual(
      await activity(admin, "version-12", 30, "group-2"),
      await activity(admin, "version-12", 30),
    );
  });

  it("counts today's acknowledgement and each audience viewer once a day", async () => {
    const admin = await signInAs(base, "user-alice");
    const before = (await activity(admin, "version-12", 1)).days[0];
    const erin = await signInAs(base, "user-erin");
    await query(
      base,
      'mutation { recordView(policyVersionId: "version-12") }',
      erin,
    );
    await query(
      base,
      'mutation { recordView(policyVersionId: "version-12") }',
      erin,
    );
    await query(
      base,
      'mutation { recordAck(policyVersionId: "version-12") { id } }',
      erin,
    );
    const after = (await activity(admin, "version-12", 1)).days[0];
    assert.equal((after?.acks ?? 0) - (before?.acks ?? 0), 1);
    assert.equal((after?.views ?? 0) - (before?.views ?? 0), 1);
  });

  it("counts no views on a version nobody has to acknowledge", async () => {
    const erin = await signInAs(base, "user-erin");
    const { body } = await query(
      base,
      'mutation { recordView(policyVersionId: "version-7") }',
      erin,
    );
    assert.deepEqual(body.data, { recordView: true });
    const { days } = await activity(
      await signInAs(base, "user-alice"),
      "version-7",
      1,
    );
    assert.equal(days[0]?.views, 0);
  });

  it("is for compliance reporters, and fails as the gateway does on an unknown version", async () => {
    assert.equal(
      (await activity(await signInAs(base, "user-erin"), "version-11", 30))
        .code,
      "PermissionDenied",
    );
    assert.equal(
      (await activity(await signInAs(base, "user-dave"), "version-11", 30))
        .code,
      undefined,
    );
    assert.equal(
      (
        await activity(
          await signInAs(base, "user-alice"),
          "version-nowhere",
          30,
        )
      ).code,
      "INTERNAL",
    );
  });
});
