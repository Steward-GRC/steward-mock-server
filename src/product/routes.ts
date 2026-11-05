// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's own HTTP routes: steward-gateway's sign-in (internal/bff) and first-run bootstrap
// (internal/setup). They run before the core's /auth and /setup, so Steward answers the
// gateway's shapes while src/core stays the template's file for file.
//
// Any non-empty password works except WRONG_PASSWORD, and any six digits except WRONG_CODE, so
// clients can show their failure screens on purpose. A native client may ask for a bearer token
// ("token": true), a mock extra for the phone apps, standing for the same kind of session.

import { sessionOfCookie, sessionOfToken, WRONG_PASSWORD } from "#core/auth.ts";
import { json, newId, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import { settings } from "#core/product.ts";
import { mockState, type Person, personById } from "#core/state.ts";
import { passkeyOwner, requestOptions } from "#product/passkeys.ts";
import { globalSettingsNow } from "#product/resolvers/admin.ts";
import {
  cookie,
  drop,
  factorsOf,
  findPerson,
  goodCode,
  hasPasskey,
  mustEnrol,
  park,
  pendingOf,
  startSession,
  wrongCode,
} from "#product/sign-in-state.ts";
import { signInRoutes } from "#product/sign-in.ts";
import { ssoRoutes } from "#product/sso.ts";

/**
 * The token first-run setup asks for (the gateway's SETUP_TOKEN), from MOCK_SETUP_TOKEN.
 */
export const SETUP_TOKEN = process.env.MOCK_SETUP_TOKEN || "mock-setup-token";

const log = createLogger("steward-auth");

const bearerOf = (request: Request): null | string => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
};

const login = async (request: Request) => {
  const { password, token, username } = await readJson<{
    password: string;
    token: boolean;
    username: string;
  }>(request);
  if (!username?.trim()) return refuse(400, "invalid_request");
  const person = findPerson(username);
  if (!person || !password || password === WRONG_PASSWORD || person.disabled)
    return refuse(401, "invalid_credentials");
  if (factorsOf(person).length > 0)
    return json({
      factors: factorsOf(person),
      mfaRequired: true,
      pendingId: park(person, "challenge"),
    });
  if (mustEnrol(person))
    return json({
      enrollmentRequired: true,
      mfaRequired: true,
      pendingId: park(person, "enrol"),
    });
  return startSession(person, token === true);
};

/** Whether a passkey assertion came from this person's passkey. */
const ownPasskey = (person: Person, credentialJson: string) =>
  passkeyOwner(credentialJson)?.id === person.id;

const verify = async (request: Request) => {
  const { code, credentialJson, kind, pendingId, token } = await readJson<{
    code: string;
    credentialJson: string;
    kind: string;
    pendingId: string;
    token: boolean;
  }>(request);
  if (!pendingId || !kind || !["email", "passkey", "totp"].includes(kind))
    return refuse(400, "invalid_request");
  if (kind === "passkey" ? !credentialJson : !code)
    return refuse(400, "invalid_request");
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  const offered =
    found.pending.purpose === "challenge" &&
    factorsOf(found.person).includes(kind);
  const verified =
    kind === "passkey"
      ? found.pending.webauthnBegun === true &&
        ownPasskey(found.person, credentialJson ?? "")
      : goodCode(code);
  if (!offered || !verified) return wrongCode(found.pendingId, found.pending);
  drop(found.pendingId);
  return startSession(found.person, token === true);
};

/**
 * POST /auth/mfa/webauthn/begin {pendingId}: a passkey challenge for a parked sign-in's second
 * factor, for the person's own passkey. Identity refuses a person with none, which the gateway
 * answers 400.
 */
const webauthnBegin = async (request: Request) => {
  const { pendingId } = await readJson<{ pendingId: string }>(request);
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  if (!hasPasskey(found.person)) return refuse(400, "invalid_request");
  found.pending.webauthnBegun = true;
  return json({
    optionsJson: JSON.stringify(requestOptions(request, found.person)),
  });
};

const sendEmailCode = async (request: Request) => {
  const { pendingId } = await readJson<{ pendingId: string }>(request);
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  log.info("email code sent (any six digits but the wrong code work)", {
    pendingId,
  });
  return json({ ok: true });
};

const enrolBegin = async (request: Request) => {
  const { pendingId } = await readJson<{ pendingId: string }>(request);
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  if (found.pending.purpose !== "enrol") return refuse(400, "invalid_request");
  const name = settings().name;
  const label = encodeURIComponent(`${name}:${found.person.email}`);
  return json({
    otpauthUri: `otpauth://totp/${label}?issuer=${encodeURIComponent(name)}&secret=MOCKMOCKMOCKMOCK`,
    secret: "MOCK************",
  });
};

const enrolConfirm = async (request: Request) => {
  const { code, pendingId, token } = await readJson<{
    code: string;
    pendingId: string;
    token: boolean;
  }>(request);
  if (!code) return refuse(400, "invalid_request");
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  if (found.pending.purpose !== "enrol") return refuse(400, "invalid_request");
  if (!goodCode(code)) return wrongCode(found.pendingId, found.pending);
  drop(found.pendingId);
  Object.assign(found.person, { enrolSecondFactor: false, secondFactor: true });
  log.debug("second factor enrolled", { personId: found.person.id });
  return startSession(found.person, token === true);
};

const session = (request: Request) => {
  const found = sessionOfToken(bearerOf(request)) ?? sessionOfCookie(request);
  const person = found ? personById(found.personId) : undefined;
  if (!found || !person) return json({ authenticated: false });
  return json({
    authenticated: true,
    csrfToken: found.csrf,
    email: person.email,
  });
};

const logout = (request: Request) => {
  const found = sessionOfToken(bearerOf(request)) ?? sessionOfCookie(request);
  if (found) {
    mockState.sessions.delete(found.id);
    for (const [key, sid] of mockState.tokens)
      if (sid === found.id) mockState.tokens.delete(key);
  }
  return json({ status: "logged_out" }, 200, { "set-cookie": cookie("", 0) });
};

/**
 * POST /setup/bootstrap, as steward-gateway's internal/setup answers it: the setup token, then
 * the first site admin. It signs nobody in; the new admin signs in like anyone else.
 */
const bootstrap = async (request: Request) => {
  const { email, name, password, setupToken, username } = await readJson<{
    email: string;
    name: string;
    password: string;
    setupToken: string;
    username: string;
  }>(request);
  if (setupToken !== SETUP_TOKEN) return refuse(403, "invalid setup token");
  if (!mockState.needsSetup) return refuse(409, "already set up");
  if (!username?.trim() || !email?.trim() || !password)
    return refuse(400, "username, email, and password are required");
  const admin: Person = {
    email: email.trim().toLowerCase(),
    id: newId("user"),
    name: name?.trim() || username.trim(),
    roles: ["site-admin"],
    secondFactor: false,
    username: username.trim().toLowerCase(),
  };
  mockState.data.people.push(admin);
  mockState.needsSetup = false;
  return json({ userId: admin.id });
};

/** GET /maintenance: the gateway's public maintenance state, for clients before sign-in. */
const maintenanceStatus = () => {
  const { enabled, message } = globalSettingsNow().maintenance;
  return json({ enabled, message: enabled ? message : "" });
};

const POST_ROUTES: Record<
  string,
  (request: Request) => Promise<Response> | Response
> = {
  "/auth/login": login,
  "/auth/logout": logout,
  "/auth/mfa/enroll/totp/begin": enrolBegin,
  "/auth/mfa/enroll/totp/confirm": enrolConfirm,
  "/auth/mfa/otp/send": sendEmailCode,
  "/auth/mfa/verify": verify,
  "/auth/mfa/webauthn/begin": webauthnBegin,
  "/setup/bootstrap": bootstrap,
};

/** Steward's routes, or undefined for a path they don't serve (the core answers those). */
export const stewardRoutes = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  const post = POST_ROUTES[path];
  if (post && request.method === "POST") return post(request);
  if (path === "/auth/session" && request.method === "GET")
    return session(request);
  if (path === "/maintenance" && request.method === "GET")
    return maintenanceStatus();
  return signInRoutes(request, path) ?? ssoRoutes(request, path);
};
