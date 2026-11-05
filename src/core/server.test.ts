// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { handle } from "#core/handle.ts";
import {
  control,
  GOOD_CODE,
  headersFor,
  openSocket,
  post,
  query,
  signIn,
  startForTests,
  startFresh,
  WRONG_CODE,
} from "#core/test-client.ts";

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

// Steward's site-admin-only write, used wherever a test needs a role-gated mutation.
const SET_SETTINGS = `mutation ($input: GlobalSettingsInput!) {
  setGlobalSettings(input: $input) { announcement { message } }
}`;

const settingsTo = (message: string) => ({
  input: {
    announcement: { enabled: true, level: "info", message },
    maintenance: { enabled: false, message: "" },
  },
});

describe("health", () => {
  it("answers every probe with the version header", async () => {
    for (const path of ["/livez", "/readyz", "/healthz"]) {
      const answer = await fetch(`${base}${path}`);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("steward-version"), "v0.1.0-mock");
    }
  });

  it("stays up when the controls armed a failure", async () => {
    await control(base, { kind: "fail-next", mode: "http", status: 503 });
    assert.equal((await fetch(`${base}/livez`)).status, 200);
  });
});

describe("sign-in", () => {
  it("refuses a wrong password, an unknown person and a disabled account", async () => {
    assert.equal(
      (
        await post(base, "/auth/login", {
          password: "wrong-password",
          username: "ghopper",
        })
      ).status,
      401,
    );
    assert.equal(
      (await post(base, "/auth/login", { password: "x", username: "nobody" }))
        .status,
      401,
    );
    assert.equal(
      (await post(base, "/auth/login", { password: "x", username: "hlamarr" }))
        .status,
      403,
    );
  });

  it("asks for the second factor and refuses the wrong code", async () => {
    const login = (await (
      await post(base, "/auth/login", { password: "x", username: "demo-admin" })
    ).json()) as Record<string, string>;
    assert.equal(login.mfaRequired, true);
    assert.equal(
      (
        await post(base, "/auth/verify", {
          code: WRONG_CODE,
          pendingId: login.pendingId,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post(base, "/auth/verify", {
          code: GOOD_CODE,
          pendingId: login.pendingId,
        })
      ).status,
      200,
    );
  });

  it("needs the CSRF header with a cookie session", async () => {
    const admin = await signIn(base, "demo-admin");
    const without = await post(
      base,
      "/query",
      { query: "{ me { name } }" },
      { cookie: admin.cookie },
    );
    assert.equal(without.status, 401);
    const { body } = await query(base, "{ me { name } }", admin);
    assert.deepEqual(body.data, { me: { name: "Demo Admin" } });
  });

  it("reports and ends the session", async () => {
    const approver = await signIn(base, "ghopper");
    const session = (await (
      await fetch(`${base}/auth/session`, {
        headers: { cookie: approver.cookie },
      })
    ).json()) as Record<string, unknown>;
    assert.equal(session.personId, "user-ghopper");
    await post(base, "/auth/logout", {}, { cookie: approver.cookie });
    assert.equal((await query(base, "{ me { name } }", approver)).status, 401);
  });

  it("gives a native client a bearer token that works without a cookie", async () => {
    const author = await signIn(base, "alovelace", true);
    assert.ok(author.token);
    const { body } = await query(base, "{ me { username } }", {
      cookie: "",
      csrf: "",
      token: author.token,
    });
    assert.deepEqual(body.data, { me: { username: "alovelace" } });
  });
});

describe("GraphQL", () => {
  it("answers a public field before sign-in and refuses the rest", async () => {
    const open = await query(
      base,
      "{ globalSettings { maintenance { enabled } } }",
    );
    assert.deepEqual(open.body.data, {
      globalSettings: { maintenance: { enabled: false } },
    });
    const closed = await query(
      base,
      "{ globalSettings { maintenance { enabled } } me { userId } }",
    );
    assert.equal(closed.status, 401);
    assert.equal(closed.body.errors?.[0]?.extensions.code, "UNAUTHENTICATED");
  });

  it("refuses what the schema doesn't have, and what doesn't parse", async () => {
    const approver = await signIn(base, "ghopper");
    const invalid = await query(base, "{ me { shoeSize } }", approver);
    assert.equal(invalid.status, 422);
    assert.equal(
      invalid.body.errors?.[0]?.extensions.code,
      "GRAPHQL_VALIDATION_FAILED",
    );
    const broken = await query(base, "{ me {", approver);
    assert.equal(
      broken.body.errors?.[0]?.extensions.code,
      "GRAPHQL_PARSE_FAILED",
    );
  });

  it("answers a role check with FORBIDDEN", async () => {
    const approver = await signIn(base, "ghopper");
    const refused = await query(
      base,
      SET_SETTINGS,
      approver,
      settingsTo("Refused"),
    );
    assert.equal(refused.body.errors?.[0]?.extensions.code, "FORBIDDEN");
    const admin = await signIn(base, "demo-admin");
    assert.deepEqual(
      (await query(base, SET_SETTINGS, admin, settingsTo("Allowed"))).body.data,
      { setGlobalSettings: { announcement: { message: "Allowed" } } },
    );
  });

  it("shares one state between every client", async () => {
    const admin = await signIn(base, "demo-admin");
    const author = await signIn(base, "alovelace", true);
    await query(base, SET_SETTINGS, admin, settingsTo("Shared"));
    const { body } = await query(
      base,
      "{ globalSettings { announcement { message } } }",
      author,
    );
    assert.deepEqual(body.data, {
      globalSettings: { announcement: { message: "Shared" } },
    });
  });

  it("takes a query in the URL but never a mutation", async () => {
    const approver = await signIn(base, "ghopper");
    const read = await fetch(
      `${base}/query?query=${encodeURIComponent("{ me { username } }")}`,
      { headers: headersFor(approver) },
    );
    assert.equal(read.status, 200);
    const write = await fetch(
      `${base}/query?query=${encodeURIComponent(SET_SETTINGS)}`,
      { headers: headersFor(approver) },
    );
    assert.equal(write.status, 405);
  });
});

describe("controls", () => {
  it("fails the next call once, as GraphQL or as HTTP", async () => {
    const approver = await signIn(base, "ghopper");
    await control(base, { kind: "fail-next" });
    assert.equal(
      (await query(base, "{ me { name } }", approver)).body.errors?.[0]
        ?.extensions.code,
      "INTERNAL",
    );
    assert.ok((await query(base, "{ me { name } }", approver)).body.data);
    await control(base, { kind: "fail-next", mode: "http", status: 503 });
    assert.equal(
      (
        await post(
          base,
          "/query",
          { query: "{ me { name } }" },
          headersFor(approver),
        )
      ).status,
      503,
    );
  });

  it("puts the data back and keeps people signed in", async () => {
    const admin = await signIn(base, "demo-admin");
    await query(base, SET_SETTINGS, admin, settingsTo("Before the reset"));
    await control(base, { kind: "reset" });
    const { body } = await query(
      base,
      "{ globalSettings { announcement { enabled } } }",
      admin,
    );
    assert.deepEqual(body.data, {
      globalSettings: { announcement: { enabled: false } },
    });
    assert.ok((await query(base, "{ me { name } }", admin)).body.data);
  });

  it("starts fresh with everyone signed out", async () => {
    const approver = await signIn(base, "ghopper");
    await control(base, { kind: "fresh" });
    assert.equal((await query(base, "{ me { name } }", approver)).status, 401);
  });

  it("signs someone in at once, and refuses an unknown kind", async () => {
    const answer = await post(base, "/_mock/controls", {
      kind: "sign-in",
      personId: "user-alovelace",
      token: true,
    });
    assert.ok(((await answer.json()) as Record<string, string>).accessToken);
    assert.equal(
      (await post(base, "/_mock/controls", { kind: "nope" })).status,
      400,
    );
  });

  it("shows the product's counts", async () => {
    const state = await control(base, { kind: "reset" });
    assert.equal((state.summary as Record<string, number>).people, 6);
  });

  it("serves its page", async () => {
    const page = await fetch(`${base}/_mock`);
    assert.match(await page.text(), /Mock controls · Steward/);
  });
});

describe("first-run setup", () => {
  it("creates the first admin once", async () => {
    await control(base, { firstRun: true, kind: "fresh" });
    assert.deepEqual(await (await fetch(`${base}/setup/state`)).json(), {
      needsSetup: true,
    });
    const admin = {
      email: "first@example.org",
      name: "First Admin",
      password: "x",
      username: "first",
    };
    const done = await post(base, "/setup/complete", admin);
    assert.equal(done.status, 200);
    assert.deepEqual(await (await fetch(`${base}/setup/state`)).json(), {
      needsSetup: false,
    });
    assert.equal((await post(base, "/setup/complete", admin)).status, 409);
  });
});

describe("websocket", () => {
  const SUBSCRIPTION =
    'subscription { liveEvents(topics: ["settings."]) { type } }';

  it("streams changes over graphql-transport-ws", async () => {
    const admin = await signIn(base, "demo-admin", true);
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ payload: { authToken: admin.token }, type: "connection_init" });
    await ws.next("connection_ack");
    ws.send({ id: "1", payload: { query: SUBSCRIPTION }, type: "subscribe" });
    await new Promise((settle) => setTimeout(settle, 50));
    await query(base, SET_SETTINGS, admin, settingsTo("Heard"));
    const message = await ws.next("next");
    assert.deepEqual(message.payload, {
      data: { liveEvents: { type: "settings.updated" } },
    });
    ws.socket.close();
  });

  it("streams over the legacy graphql-ws protocol with a cookie", async () => {
    const admin = await signIn(base, "demo-admin");
    const ws = await openSocket(base, "graphql-ws", { cookie: admin.cookie });
    ws.send({ type: "connection_init" });
    await ws.next("connection_ack");
    await ws.next("ka");
    ws.send({ id: "a", payload: { query: SUBSCRIPTION }, type: "start" });
    await new Promise((settle) => setTimeout(settle, 50));
    await query(base, SET_SETTINGS, admin, settingsTo("Legacy"));
    assert.equal(
      (
        (await ws.next("data")).payload as {
          data: { liveEvents: { type: string } };
        }
      ).data.liveEvents.type,
      "settings.updated",
    );
    ws.socket.close();
  });

  it("refuses a subscription without a session", async () => {
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ type: "connection_init" });
    await ws.next("connection_ack");
    ws.send({ id: "1", payload: { query: SUBSCRIPTION }, type: "subscribe" });
    const error = await ws.next("error");
    assert.equal(
      (error.payload as { extensions: { code: string } }[])[0]?.extensions.code,
      "UNAUTHENTICATED",
    );
    ws.socket.close();
  });

  it("closes with 4401 when the session ends", async () => {
    const admin = await signIn(base, "demo-admin", true);
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ payload: { authToken: admin.token }, type: "connection_init" });
    await ws.next("connection_ack");
    await control(base, { kind: "expire-session" });
    assert.equal(await ws.closed, 4401);
  });
});

describe("routing", () => {
  it("answers routes nobody mocked with 501", async () => {
    const answer = await fetch(`${base}/api/elsewhere`);
    assert.equal(answer.status, 501);
    assert.deepEqual(await answer.json(), { error: "not_mocked" });
  });

  it("allows only the configured origins", async () => {
    process.env.MOCK_CORS_ORIGINS = "http://localhost:3000";
    const allowed = await fetch(`${base}/livez`, {
      headers: { origin: "http://localhost:3000" },
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://localhost:3000",
    );
    const other = await fetch(`${base}/livez`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    delete process.env.MOCK_CORS_ORIGINS;
  });

  it("answers in-process, with no port", async () => {
    const answer = await handle(new Request("https://mock.invalid/readyz"));
    assert.equal(answer.status, 200);
  });
});
