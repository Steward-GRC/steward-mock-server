// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's SSO routes (internal/bff discover.go, ssotestlink.go, sso.go, idpimport.go).
// A site admin mints an IdP test link, the link runs the connection test, and the result is what
// activateOrganization checks next. There's no IdP behind the mock, so opening a live link ends
// the test at once with the outcome the controls chose (pass unless told otherwise). An SSO
// sign-in is a pass-through: while SSO is on, discovery sends anyone to it, and /auth/sso/start
// signs the person in at once and redirects back the way the gateway's callback does. The IdP
// import routes answer from invented fixtures instead of fetching anything.

import { randomBytes } from "node:crypto";

import { sessionOf, sessionOfCookie } from "#core/auth.ts";
import { json, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import { personById } from "#core/state.ts";
import { stewardData } from "#product/data.ts";
import {
  cookie,
  factorsOf,
  findPerson,
  newSession,
  park,
  SESSION_SECONDS,
} from "#product/sign-in-state.ts";

/** How long a test link stays live: the gateway's defaultTestLinkTTL. */
const TEST_LINK_MS = 30 * 60_000;

/** Where a test ends when its return path isn't a same-origin path under /admin/. */
const DEFAULT_RETURN_PATH = "/admin/organizations";

/** The detail a failed test reports: the gateway's when the IdP's code doesn't exchange. */
const FAILED_DETAIL = "code_exchange_failed";

const log = createLogger("steward-sso");

interface TestLink {
  adminUserId: string;
  alias: string;
  connectionId: string;
  expiresAt: number;
  returnPath: string;
  tenant: string;
}

/** Live test links by token. A link may be opened more than once until it expires. */
const testLinks = new Map<string, TestLink>();

/** End every live test link, as if its 30 minutes had run out. */
export const expireTestLinks = (): void => {
  testLinks.clear();
};

/**
 * The gateway's Authenticate and requireSiteAdminHTTP: the session cookie with its CSRF token (or
 * a bearer token), then the site-admin role.
 */
const siteAdminOf = (
  request: Request,
): { personId: string } | { refusal: Response } => {
  const session = sessionOf(request);
  if (!session)
    return {
      refusal: sessionOfCookie(request)
        ? refuse(403, "csrf")
        : refuse(401, "unauthorized"),
    };
  const person = personById(session.personId);
  if (!person) return { refusal: refuse(401, "unauthorized") };
  if (!person.roles.includes("site-admin"))
    return { refusal: refuse(403, "site-admin role required") };
  return { personId: person.id };
};

/** The gateway's validateAdminReturnPath: only a same-origin path under /admin/. */
const adminReturnPath = (raw: unknown): string => {
  if (
    typeof raw !== "string" ||
    raw.includes("\\") ||
    raw.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(raw) ||
    !(raw.split(/[?#]/, 1)[0] ?? "").startsWith("/admin/")
  )
    return DEFAULT_RETURN_PATH;
  return raw;
};

const trimmed = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** RFC 3339 in UTC to the second, as Go's time.RFC3339 writes it. */
const rfc3339 = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** POST /admin/sso/test-link. */
const mintTestLink = async (request: Request): Promise<Response> => {
  const admin = siteAdminOf(request);
  if ("refusal" in admin) return admin.refusal;
  const body = await readJson<{
    alias: string;
    connectionId: string;
    returnPath: string;
    tenant: string;
  }>(request);
  const connectionId = trimmed(body.connectionId);
  const alias = trimmed(body.alias);
  if (!connectionId || !alias)
    return refuse(400, "connectionId and alias are required");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + TEST_LINK_MS;
  testLinks.set(token, {
    adminUserId: admin.personId,
    alias,
    connectionId,
    expiresAt,
    returnPath: adminReturnPath(body.returnPath),
    tenant: trimmed(body.tenant).toLowerCase(),
  });
  log.debug("sso test link minted", { connectionId, personId: admin.personId });
  // The link points at the mock itself, so the browser that opens it stays on the mock.
  const query = new URLSearchParams({
    connection: alias,
    mode: "test",
    testToken: token,
  });
  return json({
    expiresAt: rfc3339(expiresAt),
    url: `${new URL(request.url).origin}/auth/sso/start?${query.toString()}`,
  });
};

const EXPIRED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Test link expired</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">This IdP test link has expired</h1>
<p>The test link you followed is no longer valid. Ask the administrator
who sent it to generate a new one and share it with you.</p>
</body></html>`;

const html = (body: string, status: number) =>
  new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
    status,
  });

/** The gateway's ssoTestResultPath. */
const resultPath = (returnPath: string, passed: boolean, detail: string) => {
  let result = "test=passed";
  if (!passed) {
    result = "test=failed";
    if (detail) result += `&reason=${encodeURIComponent(detail)}`;
  }
  return returnPath + (returnPath.includes("?") ? "&" : "?") + result;
};

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");

/** JSON that's safe inside a <script>: no way to close the tag. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", String.raw`\u003c`);

/**
 * The gateway's result page: post the result to the admin page that opened the test in a popup,
 * then close it; with no opener, go to the return path with the result on it.
 *
 * The target origin is the mock's own, as the gateway's is its own (the admin app shares it in a
 * deployment). In development the admin app runs on another origin, so the browser drops the
 * message and the page's listener would refuse it anyway (it accepts only its own origin); the
 * popup closing is what finishes the flow there, since the admin page polls for that and
 * reloads the organisation.
 */
const resultPage = (
  origin: string,
  returnPath: string,
  passed: boolean,
  detail: string,
) => {
  const fallback = resultPath(returnPath, passed, detail);
  return html(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Connection test</title>
<noscript><meta http-equiv="refresh" content="0; url=${escapeHtml(fallback)}"></noscript>
<script>
(function () {
  var msg = ${scriptJson({ detail, success: passed, type: "idp-test-result" })};
  var origin = ${scriptJson(origin)};
  var fallback = ${scriptJson(fallback)};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, origin);
      window.close();
      return;
    }
  } catch (e) {}
  window.location.replace(fallback);
})();
</script></head>
<body>You can close this window.</body></html>`,
    200,
  );
};

/** GET /auth/sso/start with a test token; without one it's a sign-in (startLogin). */
const startTest = (request: Request): Response | undefined => {
  const url = new URL(request.url);
  const token = url.searchParams.get("testToken");
  if (!token) return undefined;
  const link = testLinks.get(token);
  if (!link || link.expiresAt <= Date.now()) {
    testLinks.delete(token);
    log.debug("sso test link expired or unknown");
    return html(EXPIRED_HTML, 410);
  }
  const org = stewardData().organizations.find(
    (o) => o.connectionId === link.connectionId,
  );
  if (!org)
    return resultPage(url.origin, link.returnPath, false, "record_failed");
  const passed = stewardData().idpTestOutcome === "pass";
  org.testPassed = passed;
  log.debug("sso test recorded", {
    connectionId: link.connectionId,
    passed,
    personId: link.adminUserId,
  });
  return resultPage(
    url.origin,
    link.returnPath,
    passed,
    passed ? "" : FAILED_DETAIL,
  );
};

/** The connection alias discovery names while SSO is on; the start ignores it. */
const MOCK_CONNECTION = "mock-sso";

/** Who an SSO sign-in signs in when the identifier names nobody the mock can sign in. */
const DEFAULT_SSO_USERNAME = "erin";

/** Whether SSO is offered: the sign-in-methods control. */
export const ssoAvailable = (): boolean => stewardData().signInMethods.sso;

/** POST /auth/discover {identifier}: SSO for anyone while it's on, local otherwise. */
const discover = async (request: Request): Promise<Response> => {
  const { identifier } = await readJson<{ identifier: string }>(request);
  if (typeof identifier !== "string" || !identifier)
    return refuse(400, "invalid_request");
  return json(
    ssoAvailable()
      ? {
          allowLocal: true,
          connectionAlias: MOCK_CONNECTION,
          idpInitiatedSsoUrl: "",
          method: "sso",
        }
      : {
          allowLocal: false,
          connectionAlias: "",
          idpInitiatedSsoUrl: "",
          method: "local",
        },
  );
};

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { headers: { ...headers, location }, status: 302 });

/**
 * GET /auth/sso/start without a test link: a pass-through sign-in. The person the identifier
 * names (email or username), or Erin, gets a session and goes to /home, or, with a second factor,
 * to /login?pendingMfa=<id>&mfaFactors=<kinds>, as the gateway's callback sends them.
 */
const startLogin = (url: URL): Response => {
  const named = findPerson(url.searchParams.get("identifier") ?? "");
  const person =
    named && !named.disabled ? named : findPerson(DEFAULT_SSO_USERNAME);
  if (!person) return redirect("/login?error=sso");
  const factors = factorsOf(person);
  if (factors.length > 0) {
    const resume = new URLSearchParams({
      mfaFactors: factors.join(","),
      pendingMfa: park(person, "challenge"),
    });
    return redirect(`/login?${resume.toString()}`);
  }
  const session = newSession(person);
  log.debug("sso sign-in passed through", { personId: person.id });
  return redirect("/home", {
    "set-cookie": cookie(session.id, SESSION_SECONDS),
  });
};

/** Invented, and not a real certificate: the base64 of a sentence. */
const INVENTED_CERTIFICATE = `-----BEGIN CERTIFICATE-----\n${Buffer.from(
  "Steward mock IdP signing certificate for idp.example.org, invented for the mock gateway.",
)
  .toString("base64")
  .replaceAll(/(.{64})/g, "$1\n")
  .trim()}\n-----END CERTIFICATE-----\n`;

const INVENTED_METADATA = {
  displayName: "Example IdP",
  entityId: "https://idp.example.org/saml/metadata",
  signingCertificate: INVENTED_CERTIFICATE,
  ssoUrl: "https://idp.example.org/saml/sso",
};

/** The gateway's idpValidateFetchURL, without the fetch. */
const urlRefusal = (raw: unknown): Response | undefined => {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return refuse(400, "Missing url — provide a URL");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return refuse(400, "Invalid URL — could not parse it");
  }
  if (parsed.protocol !== "https:")
    return refuse(400, "Only https URLs are allowed");
  if (!parsed.hostname) return refuse(400, "Invalid URL — missing host");
  return undefined;
};

/** POST /admin/idp/fetch-cert and /admin/idp/import-metadata: {url}. */
const fromUrl =
  (answer: () => Record<string, string>) =>
  async (request: Request): Promise<Response> => {
    const admin = siteAdminOf(request);
    if ("refusal" in admin) return admin.refusal;
    const { url } = await readJson<{ url: string }>(request);
    return urlRefusal(url) ?? json(answer());
  };

/** POST /admin/idp/parse-metadata: {metadata}. */
const parseMetadata = async (request: Request): Promise<Response> => {
  const admin = siteAdminOf(request);
  if ("refusal" in admin) return admin.refusal;
  const { metadata } = await readJson<{ metadata: string }>(request);
  if (typeof metadata !== "string" || !metadata.trim())
    return refuse(400, "Missing metadata — upload a SAML metadata XML file");
  return json(INVENTED_METADATA);
};

const POST_ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "/admin/idp/fetch-cert": fromUrl(() => ({
    certificatePem: INVENTED_CERTIFICATE,
  })),
  "/admin/idp/import-metadata": fromUrl(() => INVENTED_METADATA),
  "/admin/idp/parse-metadata": parseMetadata,
  "/admin/sso/test-link": mintTestLink,
  "/auth/discover": discover,
};

/** The SSO routes, or undefined for a path they don't serve. */
export const ssoRoutes = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  const post = POST_ROUTES[path];
  if (post && request.method === "POST") return post(request);
  if (path === "/auth/sso/start" && request.method === "GET")
    return startTest(request) ?? startLogin(new URL(request.url));
  return undefined;
};
