// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The gateway's SSO admin routes, through HTTP: a site admin mints an IdP test link, the link ends
// the test at once (no real IdP), and the result is what activateOrganization checks next. The
// IdP import routes answer from invented fixtures.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  control,
  headersFor,
  post,
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call } from "#product/web-client.ts";

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

/** connection-1 is partner.example.net: domain verified, IdP test not passed yet. */
const PARTNER = {
  alias: "connection-1-alias",
  connectionId: "connection-1",
  domain: "partner.example.net",
};

const mint = async (signed: Signed, body: Record<string, unknown>) => {
  const answer = await post(
    base,
    "/admin/sso/test-link",
    body,
    headersFor(signed),
  );
  return {
    body: (await answer.json()) as Record<string, string>,
    status: answer.status,
  };
};

const mintPartner = async (signed: Signed) =>
  mint(signed, {
    alias: PARTNER.alias,
    connectionId: PARTNER.connectionId,
    returnPath: `/admin/organisations/${PARTNER.domain}`,
    tenant: PARTNER.domain,
  });

/** Open a test link the way a browser does, without following a redirect. */
const open = async (url: string) => {
  const answer = await fetch(url, { redirect: "manual" });
  return { answer, text: await answer.text() };
};

const activate = async (signed: Signed) =>
  call(base, signed, "ActivateOrganization", { domain: PARTNER.domain });

describe("the IdP test link", () => {
  it("refuses a caller with no session", async () => {
    const answer = await post(base, "/admin/sso/test-link", {
      alias: PARTNER.alias,
      connectionId: PARTNER.connectionId,
    });
    assert.equal(answer.status, 401);
    assert.deepEqual(await answer.json(), { error: "unauthorized" });
  });

  it("refuses a cookie without its CSRF token", async () => {
    const admin = await signIn(base, "demo-admin");
    const answer = await post(
      base,
      "/admin/sso/test-link",
      { alias: PARTNER.alias, connectionId: PARTNER.connectionId },
      { cookie: admin.cookie },
    );
    assert.equal(answer.status, 403);
    assert.deepEqual(await answer.json(), { error: "csrf" });
  });

  it("refuses someone who isn't a site admin", async () => {
    const reader = await signIn(base, "kjohnson");
    const { body, status } = await mintPartner(reader);
    assert.equal(status, 403);
    assert.deepEqual(body, { error: "site-admin role required" });
  });

  it("asks for both the connection and its alias", async () => {
    const admin = await signIn(base, "demo-admin");
    const { body, status } = await mint(admin, {
      alias: "  ",
      connectionId: PARTNER.connectionId,
    });
    assert.equal(status, 400);
    assert.deepEqual(body, { error: "connectionId and alias are required" });
  });

  it("answers a start link on the mock's own origin, valid for 30 minutes", async () => {
    const admin = await signIn(base, "demo-admin");
    const before = Date.now();
    const { body, status } = await mintPartner(admin);
    assert.equal(status, 200);
    const url = new URL(body.url ?? "");
    assert.equal(url.origin, base);
    assert.equal(url.pathname, "/auth/sso/start");
    assert.deepEqual(
      [...url.searchParams.keys()],
      ["connection", "mode", "testToken"],
    );
    assert.equal(url.searchParams.get("connection"), PARTNER.alias);
    assert.equal(url.searchParams.get("mode"), "test");
    assert.match(url.searchParams.get("testToken") ?? "", /^[\w-]{43}$/);
    assert.match(body.expiresAt ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const ttl = Date.parse(body.expiresAt ?? "") - before;
    assert.ok(ttl > 29 * 60_000 && ttl <= 30 * 60_000 + 1000, String(ttl));
  });

  it("passes the test, and activation then succeeds", async () => {
    const admin = await signIn(base, "demo-admin");
    assert.equal((await activate(admin)).refused, "FailedPrecondition");
    const { body } = await mintPartner(admin);
    const { answer, text } = await open(body.url ?? "");
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(answer.headers.get("referrer-policy"), "no-referrer");
    assert.ok(
      text.includes('{"detail":"","success":true,"type":"idp-test-result"}'),
    );
    assert.ok(text.includes(`var origin = ${JSON.stringify(base)};`));
    assert.ok(text.includes("window.opener.postMessage"));
    assert.ok(text.includes("window.close()"));
    assert.ok(
      text.includes(`"/admin/organisations/${PARTNER.domain}?test=passed"`),
    );
    const activated = await activate(admin);
    assert.equal(activated.refused, undefined);
    const org = activated.data.activateOrganization as Record<string, unknown>;
    assert.equal(org.enabled, true);
    assert.equal(org.testPassed, true);
  });

  it("fails the test when the controls say so, and activation stays refused", async () => {
    const admin = await signIn(base, "demo-admin");
    const state = await control(base, {
      kind: "idp-test-outcome",
      outcome: "fail",
    });
    assert.equal(
      (state.summary as Record<string, unknown>).idpTestOutcome,
      "fail",
    );
    const { body } = await mintPartner(admin);
    const { answer, text } = await open(body.url ?? "");
    assert.equal(answer.status, 200);
    assert.ok(
      text.includes(
        '{"detail":"code_exchange_failed","success":false,"type":"idp-test-result"}',
      ),
    );
    assert.ok(
      text.includes(
        `"/admin/organisations/${PARTNER.domain}?test=failed&reason=code_exchange_failed"`,
      ),
    );
    assert.equal((await activate(admin)).refused, "FailedPrecondition");
  });

  it("passes by default, and the summary says so", async () => {
    const state = await control(base, { kind: "idp-test-outcome" });
    assert.equal(
      (state.summary as Record<string, unknown>).idpTestOutcome,
      "pass",
    );
  });

  it("sends a return path outside /admin/ to the organisations page", async () => {
    const admin = await signIn(base, "demo-admin");
    const { body } = await mint(admin, {
      alias: PARTNER.alias,
      connectionId: PARTNER.connectionId,
      returnPath: "https://elsewhere.example.net/admin/",
    });
    const { text } = await open(body.url ?? "");
    assert.ok(text.includes('"/admin/organizations?test=passed"'));
  });

  it("answers 410 for an unknown link", async () => {
    const { answer, text } = await open(
      `${base}/auth/sso/start?connection=${PARTNER.alias}&mode=test&testToken=${"A".repeat(43)}`,
    );
    assert.equal(answer.status, 410);
    assert.match(answer.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(answer.headers.get("referrer-policy"), "no-referrer");
    assert.ok(text.includes("This IdP test link has expired"));
  });

  it("answers 410 for an expired link, and records nothing", async () => {
    const admin = await signIn(base, "demo-admin");
    const { body } = await mintPartner(admin);
    await control(base, { kind: "expire-test-links" });
    const { answer, text } = await open(body.url ?? "");
    assert.equal(answer.status, 410);
    assert.ok(text.includes("This IdP test link has expired"));
    assert.equal((await activate(admin)).refused, "FailedPrecondition");
  });
});

/** POST to a JSON route as someone (or no one). */
const send = async (signed: Signed | undefined, path: string, body = {}) => {
  const answer = await post(base, path, body, signed ? headersFor(signed) : {});
  return {
    body: (await answer.json()) as Record<string, string>,
    status: answer.status,
  };
};

describe("the IdP import routes", () => {
  it("keeps the session and site-admin guards", async () => {
    for (const path of [
      "/admin/idp/fetch-cert",
      "/admin/idp/import-metadata",
      "/admin/idp/parse-metadata",
    ]) {
      assert.equal((await send(undefined, path)).status, 401, path);
      const reader = await signIn(base, "kjohnson");
      assert.deepEqual(await send(reader, path), {
        body: { error: "site-admin role required" },
        status: 403,
      });
    }
  });

  it("fetches an invented certificate", async () => {
    const admin = await signIn(base, "demo-admin");
    const { body, status } = await send(admin, "/admin/idp/fetch-cert", {
      url: "https://idp.example.org/cert.pem",
    });
    assert.equal(status, 200);
    assert.match(
      body.certificatePem ?? "",
      /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/,
    );
  });

  it("refuses a missing or non-https url the way the gateway does", async () => {
    const admin = await signIn(base, "demo-admin");
    for (const path of [
      "/admin/idp/fetch-cert",
      "/admin/idp/import-metadata",
    ]) {
      assert.deepEqual(await send(admin, path, { url: " " }), {
        body: { error: "Missing url — provide a URL" },
        status: 400,
      });
      assert.deepEqual(
        await send(admin, path, { url: "http://idp.example.org/metadata" }),
        { body: { error: "Only https URLs are allowed" }, status: 400 },
      );
    }
  });

  it("imports invented metadata from a url", async () => {
    const admin = await signIn(base, "demo-admin");
    const { body, status } = await send(admin, "/admin/idp/import-metadata", {
      url: "https://idp.example.org/metadata",
    });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).toSorted(), [
      "displayName",
      "entityId",
      "signingCertificate",
      "ssoUrl",
    ]);
    assert.match(body.entityId ?? "", /example\.(org|net)/);
    assert.match(body.ssoUrl ?? "", /^https:\/\/[\w.-]+\.example\.(org|net)\//);
    assert.match(body.signingCertificate ?? "", /BEGIN CERTIFICATE/);
  });

  it("parses uploaded metadata, and asks for it when it's missing", async () => {
    const admin = await signIn(base, "demo-admin");
    assert.deepEqual(
      await send(admin, "/admin/idp/parse-metadata", { metadata: "" }),
      {
        body: { error: "Missing metadata — upload a SAML metadata XML file" },
        status: 400,
      },
    );
    const { body, status } = await send(admin, "/admin/idp/parse-metadata", {
      metadata: "<EntityDescriptor/>",
    });
    assert.equal(status, 200);
    assert.ok(body.entityId && body.ssoUrl && body.displayName);
  });
});
