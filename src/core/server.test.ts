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
  SETUP_TOKEN,
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

const login = async (username: string, password = "any password") => {
  const answer = await post(base, "/auth/login", { password, username });
  return { answer, body: (await answer.json()) as Record<string, unknown> };
};

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
  it("refuses a missing name, a wrong password, an unknown person and a disabled account", async () => {
    const missing = await login("");
    assert.equal(missing.answer.status, 400);
    assert.deepEqual(missing.body, { error: "invalid_request" });
    for (const [username, password] of [
      ["ghopper", "wrong-password"],
      ["nobody", "x"],
      ["hlamarr", "x"],
    ] as const) {
      const refused = await login(username, password);
      assert.equal(refused.answer.status, 401);
      assert.deepEqual(refused.body, { error: "invalid_credentials" });
    }
  });

  it("signs straight in without a second factor, with the gateway's cookie", async () => {
    const { answer, body } = await login("alovelace");
    assert.equal(answer.status, 200);
    assert.equal(typeof body.csrfToken, "string");
    const cookie = answer.headers.get("set-cookie") ?? "";
    assert.match(
      cookie,
      /^steward_sid=[^;]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/,
    );
  });

  it("asks for the second factor, refuses a wrong code or kind, and spends the pending once", async () => {
    const { answer, body } = await login("demo-admin");
    assert.equal(answer.headers.get("set-cookie"), null);
    assert.equal(body.mfaRequired, true);
    assert.deepEqual(body.factors, ["totp", "email"]);
    const pendingId = body.pendingId as string;
    const verify = (kind: string, code: string) =>
      post(base, "/auth/mfa/verify", { code, kind, pendingId });
    const wrong = await verify("totp", WRONG_CODE);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "invalid_code" });
    assert.equal((await verify("passkey", GOOD_CODE)).status, 401);
    const good = await verify("totp", GOOD_CODE);
    assert.equal(good.status, 200);
    assert.match(good.headers.get("set-cookie") ?? "", /^steward_sid=/);
    const again = await verify("totp", GOOD_CODE);
    assert.equal(again.status, 401);
    assert.deepEqual(await again.json(), { error: "invalid_pending" });
  });

  it("gives up on a pending sign-in after five wrong codes", async () => {
    const { body } = await login("ghopper");
    const verify = (code: string) =>
      post(base, "/auth/mfa/verify", {
        code,
        kind: "totp",
        pendingId: body.pendingId,
      });
    for (let attempt = 0; attempt < 5; attempt += 1) await verify(WRONG_CODE);
    assert.deepEqual(await (await verify(GOOD_CODE)).json(), {
      error: "invalid_pending",
    });
  });

  it("sends an email code and takes it", async () => {
    const { body } = await login("ghopper");
    const sent = await post(base, "/auth/mfa/otp/send", {
      pendingId: body.pendingId,
    });
    assert.deepEqual(await sent.json(), { ok: true });
    const unknown = await post(base, "/auth/mfa/otp/send", {
      pendingId: "nope",
    });
    assert.equal(unknown.status, 401);
    const verified = await post(base, "/auth/mfa/verify", {
      code: GOOD_CODE,
      kind: "email",
      pendingId: body.pendingId,
    });
    assert.equal(verified.status, 200);
  });

  it("makes a person with no second factor enrol one before signing in", async () => {
    const { body } = await login("mhamilton");
    assert.deepEqual(Object.keys(body).toSorted(), [
      "enrollmentRequired",
      "mfaRequired",
      "pendingId",
    ]);
    const pendingId = body.pendingId as string;
    assert.equal(
      (
        await post(base, "/auth/mfa/verify", {
          code: GOOD_CODE,
          kind: "totp",
          pendingId,
        })
      ).status,
      401,
    );
    const begun = (await (
      await post(base, "/auth/mfa/enroll/totp/begin", { pendingId })
    ).json()) as Record<string, string>;
    assert.match(begun.otpauthUri ?? "", /^otpauth:\/\/totp\//);
    assert.equal(typeof begun.secret, "string");
    const wrong = await post(base, "/auth/mfa/enroll/totp/confirm", {
      code: WRONG_CODE,
      pendingId,
    });
    assert.deepEqual(await wrong.json(), { error: "invalid_code" });
    const confirmed = await post(base, "/auth/mfa/enroll/totp/confirm", {
      code: GOOD_CODE,
      pendingId,
    });
    assert.equal(confirmed.status, 200);
    assert.deepEqual((await login("mhamilton")).body.factors, [
      "totp",
      "email",
    ]);
  });

  it("only enrols on an enrolment pending", async () => {
    const { body } = await login("demo-admin");
    const begun = await post(base, "/auth/mfa/enroll/totp/begin", {
      pendingId: body.pendingId,
    });
    assert.equal(begun.status, 400);
    assert.deepEqual(await begun.json(), { error: "invalid_request" });
  });

  it("reports and ends the session", async () => {
    const approver = await signIn(base, "ghopper");
    const session = (await (
      await fetch(`${base}/auth/session`, {
        headers: { cookie: approver.cookie },
      })
    ).json()) as Record<string, unknown>;
    assert.deepEqual(session, {
      authenticated: true,
      csrfToken: approver.csrf,
      email: "grace.hopper@example.org",
    });
    const out = await post(
      base,
      "/auth/logout",
      {},
      { cookie: approver.cookie },
    );
    assert.deepEqual(await out.json(), { status: "logged_out" });
    assert.match(
      out.headers.get("set-cookie") ?? "",
      /^steward_sid=; Path=\/; Max-Age=0;/,
    );
    assert.deepEqual(
      await (
        await fetch(`${base}/auth/session`, {
          headers: { cookie: approver.cookie },
        })
      ).json(),
      { authenticated: false },
    );
  });

  it("guards /query the gateway's way: no session is 401, a cookie without CSRF is 403", async () => {
    const admin = await signIn(base, "demo-admin");
    const nobody = await post(base, "/query", { query: "{ me { name } }" });
    assert.equal(nobody.status, 401);
    assert.deepEqual(await nobody.json(), { error: "unauthorized" });
    const noCsrf = await post(
      base,
      "/query",
      { query: "{ me { name } }" },
      { cookie: admin.cookie },
    );
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(await noCsrf.json(), { error: "csrf" });
    const { body } = await query(base, "{ me { name } }", admin);
    assert.deepEqual(body.data, { me: { name: "Demo Admin" } });
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
  it("bootstraps the first admin once, with the setup token, and signs nobody in", async () => {
    await control(base, { firstRun: true, kind: "fresh" });
    assert.deepEqual(await (await fetch(`${base}/setup/state`)).json(), {
      needsSetup: true,
    });
    const admin = {
      email: "first@example.org",
      name: "First Admin",
      password: "x",
      setupToken: SETUP_TOKEN,
      username: "first",
    };
    const badToken = await post(base, "/setup/bootstrap", {
      ...admin,
      setupToken: "nope",
    });
    assert.equal(badToken.status, 403);
    const done = await post(base, "/setup/bootstrap", admin);
    assert.equal(done.status, 200);
    assert.equal(done.headers.get("set-cookie"), null);
    assert.equal(
      typeof ((await done.json()) as Record<string, unknown>).userId,
      "string",
    );
    assert.deepEqual(await (await fetch(`${base}/setup/state`)).json(), {
      needsSetup: false,
    });
    assert.equal((await post(base, "/setup/bootstrap", admin)).status, 409);
    const first = await signIn(base, "first");
    const { body } = await query(base, "{ me { roles } }", first);
    assert.deepEqual(body.data, { me: { roles: ["site-admin"] } });
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
