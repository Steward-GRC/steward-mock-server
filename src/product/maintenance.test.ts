// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's side of the maintenance cycle the controls drive: globalSettings, the banner query
// steward-web reads before sign-in, keeps answering and reports the window in its maintenance
// fields, as steward-gateway reports a site admin's notice; everything else gets the 503. Also
// the summary tiles the controls page shows.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  control,
  post,
  query,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, documentOf, signInAs } from "#product/web-client.ts";

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

const hour = 3_600_000;

/** A maintenance window starting `fromNow` milliseconds ahead and lasting `length`. */
const window = (fromNow: number, length: number) => ({
  endsAt: new Date(Date.now() + fromNow + length).toISOString(),
  startsAt: new Date(Date.now() + fromNow).toISOString(),
});

/** The banners as steward-web reads them on the sign-in page: signed out. */
const banners = async () => {
  const { body, status } = await query(base, documentOf("GlobalSettings"));
  assert.equal(status, 200);
  return body.data?.globalSettings as {
    announcement: Record<string, unknown>;
    maintenance: { enabled: boolean; message: string };
  };
};

describe("maintenance banner", () => {
  it("reports no maintenance when no window is set", async () => {
    assert.deepEqual((await banners()).maintenance, {
      enabled: false,
      message: "",
    });
  });

  it("reports an announced window with its message", async () => {
    await control(base, {
      kind: "maintenance-announce",
      message: "Upgrade on Saturday.",
      ...window(hour, hour),
    });
    assert.deepEqual((await banners()).maintenance, {
      enabled: true,
      message: "Upgrade on Saturday.",
    });
  });

  it("keeps answering globalSettings while maintenance is on, and refuses the rest", async () => {
    const reader = await signInAs(base, "user-erin");
    await control(base, {
      endsAt: new Date(Date.now() + hour).toISOString(),
      kind: "maintenance-start",
      message: "Back at noon.",
    });
    assert.deepEqual((await banners()).maintenance, {
      enabled: true,
      message: "Back at noon.",
    });
    const read = await call(base, reader, "GlobalSettings");
    assert.equal(read.refused, undefined);

    const refused = await post(base, "/query", {
      query: documentOf("Me"),
    });
    assert.equal(refused.status, 503);
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
  });

  it("gives the banner a message when the window has none", async () => {
    await control(base, { kind: "maintenance-start" });
    const { maintenance } = await banners();
    assert.equal(maintenance.enabled, true);
    assert.notEqual(maintenance.message.trim(), "");
  });

  it("goes back to the admin's saved notice when maintenance ends", async () => {
    const admin = await signInAs(base, "user-alice");
    const input = {
      announcement: { enabled: true, level: "info", message: "Audit week." },
      maintenance: { enabled: false, message: "Saved notice." },
    };
    await call(base, admin, "SetGlobalSettings", { input });
    await control(base, { kind: "maintenance-start", message: "Down now." });
    const during = await banners();
    assert.deepEqual(during.maintenance, {
      enabled: true,
      message: "Down now.",
    });
    assert.deepEqual(during.announcement, input.announcement);

    await control(base, { kind: "maintenance-end" });
    assert.deepEqual(await banners(), input);
  });

  it("goes back to no maintenance on a reset", async () => {
    await control(base, { kind: "maintenance-start", message: "Down now." });
    await control(base, { kind: "reset" });
    assert.equal((await banners()).maintenance.enabled, false);
  });
});

describe("summary", () => {
  it("counts people, policies, open runs and cases, beside the IdP test outcome", async () => {
    const state = await control(base, { kind: "reset" });
    const data = stewardData();
    assert.deepEqual(state.summary, {
      cases: data.reportCases.length,
      idpTestOutcome: "pass",
      "open runs": data.runs.filter(
        (run) => run.status === "APPROVAL_STATUS_IN_REVIEW",
      ).length,
      people: data.people.length,
      policies: data.policies.length,
    });
    assert.ok(
      data.runs.some((run) => run.status !== "APPROVAL_STATUS_IN_REVIEW"),
    );
  });

  it("shows the counts as tiles on the controls page", async () => {
    const page = await (await fetch(`${base}/_mock`)).text();
    for (const label of ["people", "policies", "open runs", "cases"])
      assert.ok(
        page.includes(`<span class="tile__label">${label}</span>`),
        `no ${label} tile`,
      );
  });
});
