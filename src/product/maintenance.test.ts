// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's side of the maintenance cycle the controls drive, as steward-gateway's
// internal/maintenance answers it: an announced window is an announcement, maintenance shows as
// on only once it starts, and then only the gateway's whitelisted reads (globalSettings, me and
// introspection) answer GraphQL, with the gateway's MAINTENANCE error for the rest. The /auth and
// /setup routes keep answering, and GET /maintenance reports the state. Also the summary tiles
// the controls page shows.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  control,
  openSocket,
  post,
  query,
  type Signed,
  signIn,
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

  it("shows an announced window as a warning announcement, not as maintenance", async () => {
    await control(base, {
      kind: "maintenance-announce",
      message: "Upgrade on Saturday.",
      ...window(hour, hour),
    });
    assert.deepEqual(await banners(), {
      announcement: {
        enabled: true,
        level: "warning",
        message: "Upgrade on Saturday.",
      },
      maintenance: { enabled: false, message: "" },
    });
    const reader = await signInAs(base, "user-erin");
    assert.equal((await call(base, reader, "Me")).refused, undefined);
  });

  it("names the announced window when it has no message", async () => {
    const given = window(hour, hour);
    await control(base, { kind: "maintenance-announce", ...given });
    const { announcement } = await banners();
    assert.equal(announcement.enabled, true);
    assert.ok(String(announcement.message).includes(given.startsAt));
  });

  it("keeps answering globalSettings and me while maintenance is on, and refuses the rest the gateway's way", async () => {
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
    assert.equal(
      (await call(base, reader, "GlobalSettings")).refused,
      undefined,
    );
    const own = await call(base, reader, "Me");
    assert.equal(own.refused, undefined);
    const { me: user } = own.data as { me: { userId: string } };
    assert.equal(user.userId, "user-erin");

    const refused = await query(
      base,
      "query { me { userId } myManagedGroups { id } }",
      reader,
    );
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.body, {
      errors: [
        {
          extensions: { code: "MAINTENANCE", message: "Back at noon." },
          message: "the system is in maintenance mode",
        },
      ],
    });
  });

  it("lets a site admin see their roles during maintenance, so the lockdown can lead to admin", async () => {
    const admin = await signInAs(base, "user-alice");
    await control(base, { kind: "maintenance-start" });
    const own = await call(base, admin, "Me");
    assert.equal(own.refused, undefined);
    const { me: user } = own.data as { me: { roles: string[] } };
    assert.deepEqual(user.roles, ["site-admin"]);
  });

  it("lets a site admin run every operation during maintenance, and lift it from admin", async () => {
    const admin = await signInAs(base, "user-alice");
    await control(base, { kind: "maintenance-start", message: "Down now." });
    const users = await query(
      base,
      "query { users { users { userId } } }",
      admin,
    );
    assert.equal(users.body.errors, undefined);
    const { users: page } = users.body.data as { users: { users: unknown[] } };
    assert.ok(page.users.length > 0);
    const lifted = await call(base, admin, "SetGlobalSettings", {
      input: {
        announcement: { enabled: false, level: "info", message: "" },
        maintenance: { enabled: false, message: "" },
      },
    });
    assert.equal(lifted.refused, undefined);
    assert.deepEqual(await (await fetch(`${base}/maintenance`)).json(), {
      enabled: false,
      message: "",
    });
    const reader = await signInAs(base, "user-erin");
    assert.equal(
      (await call(base, reader, "MyManagedGroups")).refused,
      undefined,
    );
  });

  it("starts maintenance when a site admin saves it on, as the gateway's setting does", async () => {
    const admin = await signInAs(base, "user-alice");
    await call(base, admin, "SetGlobalSettings", {
      input: {
        announcement: { enabled: false, level: "info", message: "" },
        maintenance: { enabled: true, message: "Patching." },
      },
    });
    assert.deepEqual(await (await fetch(`${base}/maintenance`)).json(), {
      enabled: true,
      message: "Patching.",
    });
    const reader = await signInAs(base, "user-erin");
    assert.equal(
      (await call(base, reader, "MyManagedGroups")).refused,
      "MAINTENANCE",
    );
  });

  it("refuses a reader's operation beyond the whitelist", async () => {
    const reader = await signInAs(base, "user-erin");
    await control(base, { kind: "maintenance-start" });
    const refused = await query(
      base,
      "query { myManagedGroups { id } }",
      reader,
    );
    assert.equal(refused.body.errors?.[0]?.extensions.code, "MAINTENANCE");
  });

  it("refuses a signed-out caller's operation beyond the whitelist", async () => {
    await control(base, { kind: "maintenance-start" });
    const refused = await query(
      base,
      "query { me { userId } myManagedGroups { id } }",
    );
    assert.equal(refused.body.errors?.[0]?.extensions.code, "MAINTENANCE");
  });

  it("keeps the sign-in and setup routes answering while maintenance is on", async () => {
    await control(base, { kind: "maintenance-start" });
    const login = await post(base, "/auth/login", {
      password: "bob-password",
      username: "bob",
    });
    assert.equal(login.status, 200);
    const session = await fetch(`${base}/auth/session`);
    assert.deepEqual(await session.json(), { authenticated: false });
    const state = await fetch(`${base}/setup/state`);
    assert.equal(state.status, 200);
  });

  it("leaves the gateway's other routes open: assets answer as without maintenance", async () => {
    await control(base, { kind: "maintenance-start" });
    const assets = await post(base, "/api/assets", {});
    assert.equal(assets.status, 501);
    assert.deepEqual(await assets.json(), { error: "not_mocked" });
  });

  it("stays ready, as the gateway's /readyz does during maintenance", async () => {
    await control(base, { kind: "maintenance-start" });
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
  });

  it("keeps the co-editing socket open during maintenance", async () => {
    const author = await signIn(base, "bob");
    const minted = await call(base, author, "IssueCollabToken", {
      draftId: "version-3",
      policyId: "policy-2",
    });
    const { token } = minted.data.issueCollabToken as { token: string };
    await control(base, { kind: "maintenance-start" });
    const socket = new WebSocket(
      `${base.replace("http", "ws")}/collab/ws/version-3?token=${encodeURIComponent(token)}`,
      { headers: { cookie: author.cookie } },
    );
    const opened = await new Promise<boolean>((done) => {
      socket.once("open", () => done(true));
      socket.once("error", () => done(false));
    });
    socket.close();
    assert.equal(opened, true);
  });

  it("runs a site admin's subscription during maintenance and refuses a reader's", async () => {
    await control(base, { kind: "maintenance-start", message: "Down now." });
    const subscribe = async (signed: Signed) => {
      const ws = await openSocket(base, "graphql-transport-ws");
      ws.send({
        payload: { authToken: signed.token },
        type: "connection_init",
      });
      await ws.next("connection_ack");
      ws.send({
        id: "1",
        payload: { query: "subscription { liveEvents { type } }" },
        type: "subscribe",
      });
      return ws;
    };
    const reader = await subscribe(await signInAs(base, "user-erin"));
    const refused = await reader.next("error");
    reader.socket.close();
    assert.deepEqual(refused.payload, [
      { extensions: { code: "MAINTENANCE" }, message: "Down now." },
    ]);

    const admin = await signInAs(base, "user-alice");
    const live = await subscribe(admin);
    // A site admin's change during maintenance arrives on their stream.
    const saved = await call(base, admin, "SetGlobalSettings", {
      input: {
        announcement: { enabled: true, level: "info", message: "Back soon." },
        maintenance: { enabled: true, message: "Down now." },
      },
    });
    assert.equal(saved.refused, undefined);
    const event = await live.next("next");
    live.socket.close();
    assert.deepEqual(event.payload, {
      data: { liveEvents: { type: "global_settings.updated" } },
    });
  });

  it("reports the state at GET /maintenance, as the gateway's public route does", async () => {
    const status = async () =>
      (await fetch(`${base}/maintenance`)).json() as Promise<unknown>;
    assert.deepEqual(await status(), { enabled: false, message: "" });
    await control(base, {
      kind: "maintenance-announce",
      message: "Soon.",
      ...window(hour, hour),
    });
    assert.deepEqual(await status(), { enabled: false, message: "" });
    await control(base, { kind: "maintenance-start", message: "Down now." });
    assert.deepEqual(await status(), { enabled: true, message: "Down now." });
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
  it("counts people, policies, open runs and cases, beside the IdP test outcome and the sign-in methods", async () => {
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
      "sign-in": "passkey, passwordReset, sso",
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
