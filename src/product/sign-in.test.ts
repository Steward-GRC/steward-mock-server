// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The gateway's sign-in helpers through HTTP: the sign-in settings (/auth/config), SSO lookup
// (/auth/discover) and an SSO sign-in through the mock's broker, the password reset by emailed
// code, and passkeys, both to sign in and as a second factor. The shapes and refusals are
// steward-gateway's (internal/passwordreset and internal/bff).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { passkeyCredentialId } from "#product/passkeys.ts";
import {
  control,
  GOOD_CODE,
  post,
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

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, redirect: "manual" });

const postRaw = (path: string, body: string) =>
  fetch(`${base}${path}`, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const answerOf = async (answer: Response) => ({
  body: (await answer.json()) as Record<string, unknown>,
  status: answer.status,
});

const sessionWith = async (setCookie: null | string) => {
  const cookie = (setCookie ?? "").split(";", 1)[0] ?? "";
  return (await get("/auth/session", { cookie }).then((a) => a.json())) as {
    authenticated: boolean;
    email?: string;
  };
};

const methods = (body: Record<string, unknown>) =>
  control(base, { kind: "sign-in-methods", ...body });

const discover = async (identifier: unknown) =>
  answerOf(await post(base, "/auth/discover", { identifier }));
const startSso = (query: Record<string, string>) =>
  get(`/auth/sso/start?${new URLSearchParams(query).toString()}`);
const requestReset = async (email: unknown) =>
  answerOf(await post(base, "/auth/password-reset/request", { email }));
const confirmReset = async (body: Record<string, unknown>) =>
  answerOf(await post(base, "/auth/password-reset/confirm", body));
const beginPasskey = async () =>
  answerOf(await post(base, "/auth/passkey/login/begin", {}));
const finishPasskey = async (body: Record<string, unknown>) => {
  const answer = await post(base, "/auth/passkey/login/finish", body);
  return { ...(await answerOf(answer)), answer };
};
const assertion = (id: string) =>
  JSON.stringify({ id, rawId: id, type: "public-key" });
const loginAs = async (username: string) =>
  (await (
    await post(base, "/auth/login", {
      password: `${username}-password`,
      username,
    })
  ).json()) as Record<string, unknown>;
const beginFactor = async (pendingId: unknown) =>
  answerOf(await post(base, "/auth/mfa/webauthn/begin", { pendingId }));
const verifyPasskey = (pendingId: unknown, credentialJson?: string) =>
  post(base, "/auth/mfa/verify", {
    credentialJson,
    kind: "passkey",
    pendingId,
  });

describe("GET /auth/config", () => {
  it("offers every method the mock serves by default", async () => {
    const answer = await get("/auth/config");
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), {
      defaultLoginMethod: "local",
      login2faEnabled: false,
      passkeyEnabled: true,
      reportProblemUrl: "",
      ssoAvailable: true,
    });
  });

  it("switches SSO, passkeys and the first method from the controls", async () => {
    await methods({ passkey: false, sso: false });
    let body = (await (await get("/auth/config")).json()) as Record<
      string,
      unknown
    >;
    assert.equal(body.ssoAvailable, false);
    assert.equal(body.passkeyEnabled, false);
    await methods({ defaultLoginMethod: "sso", passkey: true, sso: true });
    body = (await (await get("/auth/config")).json()) as Record<
      string,
      unknown
    >;
    assert.equal(body.ssoAvailable, true);
    assert.equal(body.passkeyEnabled, true);
    assert.equal(body.defaultLoginMethod, "sso");
  });

  it("answers like a gateway without the reset package while password reset is off", async () => {
    await methods({ passwordReset: false });
    const config = await get("/auth/config");
    assert.equal(config.status, 404);
    assert.equal(await config.text(), "404 page not found\n");
    const request = await post(base, "/auth/password-reset/request", {
      email: "bob@example.org",
    });
    assert.equal(request.status, 404);
    await methods({ passwordReset: true });
    assert.equal((await get("/auth/config")).status, 200);
  });

  it("puts every method back on a fresh start", async () => {
    await methods({ passkey: false, passwordReset: false, sso: false });
    startFresh();
    const body = (await (await get("/auth/config")).json()) as Record<
      string,
      unknown
    >;
    assert.equal(body.ssoAvailable, true);
    assert.equal(body.passkeyEnabled, true);
  });
});

describe("POST /auth/discover", () => {
  it("refuses a missing identifier or an unreadable body", async () => {
    assert.deepEqual(await discover(""), {
      body: { error: "invalid_request" },
      status: 400,
    });
    assert.deepEqual(await answerOf(await postRaw("/auth/discover", "{")), {
      body: { error: "invalid_request" },
      status: 400,
    });
  });

  it("sends anyone to the mock's SSO while it's on", async () => {
    const sso = {
      body: {
        allowLocal: true,
        connectionAlias: "mock-sso",
        idpInitiatedSsoUrl: "",
        method: "sso",
      },
      status: 200,
    };
    assert.deepEqual(await discover("erin@example.org"), sso);
    assert.deepEqual(await discover("nobody"), sso);
  });

  it("answers local for everyone while SSO is off", async () => {
    await methods({ sso: false });
    assert.deepEqual(await discover("erin@example.org"), {
      body: {
        allowLocal: false,
        connectionAlias: "",
        idpInitiatedSsoUrl: "",
        method: "local",
      },
      status: 200,
    });
  });
});

describe("the pass-through SSO sign-in", () => {
  it("signs Erin in and goes home when nobody is named", async () => {
    const answer = await startSso({ connection: "mock-sso" });
    assert.equal(answer.status, 302);
    assert.equal(answer.headers.get("location"), "/home");
    const session = await sessionWith(answer.headers.get("set-cookie"));
    assert.equal(session.authenticated, true);
    assert.equal(session.email, "erin@example.org");
  });

  it("signs in the person the identifier names, by email or username", async () => {
    for (const identifier of ["bob@example.org", "bob"]) {
      const answer = await startSso({ identifier });
      assert.equal(answer.headers.get("location"), "/home");
      const session = await sessionWith(answer.headers.get("set-cookie"));
      assert.equal(session.email, "bob@example.org");
    }
  });

  it("falls back to Erin for someone the mock doesn't know or who is disabled", async () => {
    for (const identifier of ["nobody@example.org", "frank"]) {
      const answer = await startSso({ identifier });
      const session = await sessionWith(answer.headers.get("set-cookie"));
      assert.equal(session.email, "erin@example.org");
    }
  });

  it("parks a person with a second factor and hands the web the pending id", async () => {
    const answer = await startSso({ identifier: "charlie@example.org" });
    assert.equal(answer.status, 302);
    assert.equal(answer.headers.get("set-cookie"), null);
    const location = new URL(
      answer.headers.get("location") ?? "",
      "http://web",
    );
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("mfaFactors"), "totp,email,passkey");
    const verified = await post(base, "/auth/mfa/verify", {
      code: GOOD_CODE,
      kind: "totp",
      pendingId: location.searchParams.get("pendingMfa"),
    });
    assert.equal(verified.status, 200);
  });
});

describe("the password reset", () => {
  const UNREADABLE =
    "That request could not be read. Reload the page and try again.";
  const INVALID_CODE =
    "That code is invalid or has expired. Request a new code, then try again.";

  it("refuses a request with no email or an unreadable body", async () => {
    assert.deepEqual(await requestReset(""), {
      body: { error: "Enter your email address.", kind: "business" },
      status: 400,
    });
    assert.deepEqual(
      await answerOf(await postRaw("/auth/password-reset/request", "{")),
      { body: { error: UNREADABLE, kind: "business" }, status: 400 },
    );
  });

  it("answers the same whether or not the account exists", async () => {
    assert.deepEqual(await requestReset("bob@example.org"), {
      body: { ok: true },
      status: 200,
    });
    assert.deepEqual(await requestReset("nobody@example.org"), {
      body: { ok: true },
      status: 200,
    });
  });

  it("sets the new password with any six digits but the wrong code, once", async () => {
    await requestReset("bob@example.org");
    const given = {
      email: "bob@example.org",
      newPassword: "a new password",
    };
    assert.deepEqual(await confirmReset({ ...given, code: WRONG_CODE }), {
      body: { error: INVALID_CODE, kind: "business" },
      status: 400,
    });
    assert.deepEqual(await confirmReset({ ...given, code: GOOD_CODE }), {
      body: { ok: true },
      status: 200,
    });
    assert.equal(
      (await confirmReset({ ...given, code: GOOD_CODE })).status,
      400,
    );
  });

  it("refuses a code nobody asked for, or for an account with no local password", async () => {
    assert.equal(
      (
        await confirmReset({
          code: GOOD_CODE,
          email: "bob@example.org",
          newPassword: "x",
        })
      ).status,
      400,
    );
    for (const email of ["charlie@example.org", "nobody@example.org"]) {
      await requestReset(email);
      assert.deepEqual(
        await confirmReset({ code: GOOD_CODE, email, newPassword: "x" }),
        { body: { error: INVALID_CODE, kind: "business" }, status: 400 },
      );
    }
  });

  it("needs the email, the code and the new password", async () => {
    assert.deepEqual(
      await confirmReset({ code: GOOD_CODE, email: "bob@example.org" }),
      {
        body: {
          error: "Code and new password are required.",
          kind: "business",
        },
        status: 400,
      },
    );
  });
});

describe("passkey sign-in", () => {
  it("hands out request options a browser takes", async () => {
    const { body, status } = await beginPasskey();
    assert.equal(status, 200);
    assert.equal(typeof body.flowId, "string");
    const options = JSON.parse(body.optionsJson as string) as {
      publicKey: Record<string, unknown>;
    };
    assert.match(options.publicKey.challenge as string, /^[\w-]{43}$/);
    assert.equal(options.publicKey.rpId, "127.0.0.1");
    assert.equal(options.publicKey.userVerification, "preferred");
    assert.equal(options.publicKey.timeout, 300_000);
  });

  it("signs in the person whose passkey answered, once per challenge", async () => {
    const { body } = await beginPasskey();
    const signed = await finishPasskey({
      credentialJson: assertion(passkeyCredentialId("charlie")),
      flowId: body.flowId,
    });
    assert.equal(signed.status, 200);
    assert.equal(typeof signed.body.csrfToken, "string");
    const session = await sessionWith(signed.answer.headers.get("set-cookie"));
    assert.equal(session.email, "charlie@example.org");
    const again = await finishPasskey({
      credentialJson: assertion(passkeyCredentialId("charlie")),
      flowId: body.flowId,
    });
    assert.deepEqual(again.body, { error: "invalid_request" });
  });

  it("refuses a passkey nobody has like a wrong password", async () => {
    const { body } = await beginPasskey();
    const refused = await finishPasskey({
      credentialJson: assertion(passkeyCredentialId("erin")),
      flowId: body.flowId,
    });
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.body, { error: "invalid_credentials" });
  });

  it("refuses a missing field or a challenge it never gave", async () => {
    for (const given of [
      { flowId: "x" },
      { credentialJson: "{}" },
      { credentialJson: "{}", flowId: "never-begun" },
    ]) {
      const refused = await finishPasskey(given);
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body, { error: "invalid_request" });
    }
  });

  it("answers 404 while passkeys are off", async () => {
    await methods({ passkey: false });
    assert.deepEqual(await beginPasskey(), {
      body: { error: "passkey_unavailable" },
      status: 404,
    });
    const refused = await finishPasskey({ credentialJson: "{}", flowId: "x" });
    assert.equal(refused.status, 404);
  });
});

describe("a passkey as the second factor", () => {
  it("offers the passkey to a person who has one", async () => {
    assert.deepEqual((await loginAs("charlie")).factors, [
      "totp",
      "email",
      "passkey",
    ]);
  });

  it("refuses a missing or unknown pending sign-in", async () => {
    assert.deepEqual(await beginFactor(""), {
      body: { error: "invalid_request" },
      status: 400,
    });
    assert.deepEqual(await beginFactor("pending-unknown"), {
      body: { error: "invalid_pending" },
      status: 401,
    });
  });

  it("refuses a person with no passkey", async () => {
    const { pendingId } = await loginAs("alice");
    assert.deepEqual(await beginFactor(pendingId), {
      body: { error: "invalid_request" },
      status: 400,
    });
  });

  it("challenges for the person's own passkey and finishes the sign-in", async () => {
    const { pendingId } = await loginAs("charlie");
    const { body, status } = await beginFactor(pendingId);
    assert.equal(status, 200);
    const options = JSON.parse(body.optionsJson as string) as {
      publicKey: { allowCredentials: { id: string; type: string }[] };
    };
    const id = passkeyCredentialId("charlie");
    assert.deepEqual(options.publicKey.allowCredentials, [
      { id, type: "public-key" },
    ]);
    const verified = await verifyPasskey(
      pendingId,
      JSON.stringify({ id, type: "public-key" }),
    );
    assert.equal(verified.status, 200);
    assert.equal(
      typeof ((await verified.json()) as Record<string, unknown>).csrfToken,
      "string",
    );
  });

  it("refuses the passkey before a challenge, or another person's", async () => {
    const { pendingId } = await loginAs("charlie");
    const own = JSON.stringify({ id: passkeyCredentialId("charlie") });
    let refused = await verifyPasskey(pendingId, own);
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: "invalid_code" });
    await beginFactor(pendingId);
    refused = await verifyPasskey(
      pendingId,
      JSON.stringify({ id: passkeyCredentialId("alice") }),
    );
    assert.equal(refused.status, 401);
    assert.equal((await verifyPasskey(pendingId, own)).status, 200);
  });

  it("needs the credential", async () => {
    const { pendingId } = await loginAs("charlie");
    const refused = await verifyPasskey(pendingId);
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "invalid_request" });
  });
});
