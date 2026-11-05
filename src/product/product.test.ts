// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's sign-in and first-run setup, as steward-gateway answers them (internal/bff and
// internal/setup), served by the product's own routes. The core's tests cover the rest of the
// server against their own fixture.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  control,
  GOOD_CODE,
  post,
  query,
  SETUP_TOKEN,
  signIn,
  startForTests,
  startFresh,
  WRONG_CODE,
} from "#product/test-client.ts";

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

const login = async (username: string, password = "any password") => {
  const answer = await post(base, "/auth/login", { password, username });
  return { answer, body: (await answer.json()) as Record<string, unknown> };
};

describe("sign-in", () => {
  it("refuses a missing name, a wrong password, an unknown person and a disabled account", async () => {
    const missing = await login("");
    assert.equal(missing.answer.status, 400);
    assert.deepEqual(missing.body, { error: "invalid_request" });
    for (const [username, password] of [
      ["charlie", "wrong-password"],
      ["nobody", "x"],
      ["frank", "x"],
    ] as const) {
      const refused = await login(username, password);
      assert.equal(refused.answer.status, 401);
      assert.deepEqual(refused.body, { error: "invalid_credentials" });
    }
  });

  it("signs straight in without a second factor, with the gateway's cookie", async () => {
    const { answer, body } = await login("bob");
    assert.equal(answer.status, 200);
    assert.equal(typeof body.csrfToken, "string");
    const cookie = answer.headers.get("set-cookie") ?? "";
    assert.match(
      cookie,
      /^steward_sid=[^;]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/,
    );
  });

  it("asks for the second factor, refuses a wrong code or kind, and spends the pending once", async () => {
    const { answer, body } = await login("alice");
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
    const { body } = await login("charlie");
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
    const { body } = await login("charlie");
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
    const { body } = await login("dave");
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
    assert.deepEqual((await login("dave")).body.factors, ["totp", "email"]);
  });

  it("only enrols on an enrolment pending", async () => {
    const { body } = await login("alice");
    const begun = await post(base, "/auth/mfa/enroll/totp/begin", {
      pendingId: body.pendingId,
    });
    assert.equal(begun.status, 400);
    assert.deepEqual(await begun.json(), { error: "invalid_request" });
  });

  it("reports and ends the session", async () => {
    const approver = await signIn(base, "charlie");
    const session = (await (
      await fetch(`${base}/auth/session`, {
        headers: { cookie: approver.cookie },
      })
    ).json()) as Record<string, unknown>;
    assert.deepEqual(session, {
      authenticated: true,
      csrfToken: approver.csrf,
      email: "charlie@example.org",
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

  it("refuses /query without a session, or with a cookie but no CSRF token", async () => {
    // steward-gateway answers these 401 {"error":"unauthorized"} and 403 {"error":"csrf"}; the
    // template's core answers 401 with a GraphQL error for both. steward-web reacts to the
    // status alone, so it behaves the same; matching the body waits on a core setting.
    const admin = await signIn(base, "alice");
    assert.equal(
      (await post(base, "/query", { query: "{ me { name } }" })).status,
      401,
    );
    const noCsrf = await post(
      base,
      "/query",
      { query: "{ me { name } }" },
      { cookie: admin.cookie },
    );
    assert.equal(noCsrf.status, 401);
    const { body } = await query(base, "{ me { name } }", admin);
    assert.deepEqual(body.data, { me: { name: "Alice Admin" } });
  });

  it("gives a native client a bearer token that works without a cookie", async () => {
    const author = await signIn(base, "bob", true);
    assert.ok(author.token);
    const { body } = await query(base, "{ me { username } }", {
      cookie: "",
      csrf: "",
      token: author.token,
    });
    assert.deepEqual(body.data, { me: { username: "bob" } });
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
