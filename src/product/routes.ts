// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's own HTTP routes: steward-gateway's sign-in (internal/bff) and first-run bootstrap
// (internal/setup). They run before the core's /auth and /setup, so Steward answers the
// gateway's shapes while src/core stays the template's file for file.
//
// Any non-empty password works except WRONG_PASSWORD, and any six digits except WRONG_CODE, so
// clients can show their failure screens on purpose. A native client may ask for a bearer token
// ("token": true), a mock extra for the phone apps, standing for the same kind of session.

import type { StewardPerson } from "#product/data/people.ts";

import {
  sessionOfCookie,
  sessionOfToken,
  WRONG_CODE,
  WRONG_PASSWORD,
} from "#core/auth.ts";
import { json, newId, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import { settings } from "#core/product.ts";
import {
  mockState,
  type Person,
  personById,
  type Session,
} from "#core/state.ts";

/** How long a session lasts, in seconds: the gateway's default SESSION_TTL of 168h. */
const SESSION_SECONDS = 604_800;

/** Wrong codes a pending sign-in takes before the gateway drops it. */
const MAX_ATTEMPTS = 5;

/** The factors a person with a second factor is offered, in the gateway's order. */
const FACTORS = ["totp", "email"] as const;

/**
 * The token first-run setup asks for (the gateway's SETUP_TOKEN), from MOCK_SETUP_TOKEN.
 */
export const SETUP_TOKEN = process.env.MOCK_SETUP_TOKEN || "mock-setup-token";

const log = createLogger("steward-auth");

interface PendingSignIn {
  attempts: number;
  purpose: "challenge" | "enrol";
}

/**
 * What a pending sign-in is for and how many wrong codes it has taken. The core's
 * mockState.pending (id to person) says whether it still exists, so a reset or a fresh start
 * that clears it ends these too.
 */
const pendingSignIns = new Map<string, PendingSignIn>();

/** The gateway's cookie with COOKIE_INSECURE=true: no Secure, so it works over plain http. */
const cookie = (sid: string, maxAge: number) =>
  `${settings().sessionCookie}=${sid}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Lax`;

const bearerOf = (request: Request): null | string => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
};

const startSession = (person: Person, token = false): Response => {
  const session: Session = {
    csrf: newId("csrf"),
    id: newId("sid"),
    personId: person.id,
    startedAt: Date.now(),
  };
  mockState.sessions.set(session.id, session);
  const body: Record<string, unknown> = { csrfToken: session.csrf };
  if (token) {
    const accessToken = newId("token");
    mockState.tokens.set(accessToken, session.id);
    Object.assign(body, {
      accessToken,
      expiresIn: SESSION_SECONDS,
      tokenType: "Bearer",
    });
  }
  log.debug("session started", { native: token, personId: person.id });
  return json(body, 200, { "set-cookie": cookie(session.id, SESSION_SECONDS) });
};

const findPerson = (username: string) => {
  const wanted = username.trim().toLowerCase();
  return mockState.data.people.find(
    (p) => p.username === wanted || p.email === wanted,
  );
};

const goodCode = (code: string | undefined) =>
  !!code && /^\d{6}$/.test(code) && code !== WRONG_CODE;

const park = (person: Person, purpose: PendingSignIn["purpose"]): string => {
  const pendingId = newId("pending");
  mockState.pending.set(pendingId, person.id);
  pendingSignIns.set(pendingId, { attempts: 0, purpose });
  log.debug("sign-in pending", { pendingId, personId: person.id, purpose });
  return pendingId;
};

const drop = (pendingId: string) => {
  mockState.pending.delete(pendingId);
  pendingSignIns.delete(pendingId);
};

/** The pending sign-in behind an id and its person, or the gateway's refusal. */
const pendingOf = (
  pendingId: string | undefined,
):
  | { pending: PendingSignIn; pendingId: string; person: Person }
  | { refusal: Response } => {
  if (!pendingId) return { refusal: refuse(400, "invalid_request") };
  const personId = mockState.pending.get(pendingId);
  const pending = pendingSignIns.get(pendingId);
  const person = personId ? personById(personId) : undefined;
  if (!pending || !person) return { refusal: refuse(401, "invalid_pending") };
  return { pending, pendingId, person };
};

/** Count a wrong code; the fifth drops the pending sign-in. */
const wrongCode = (pendingId: string, pending: PendingSignIn): Response => {
  pending.attempts += 1;
  if (pending.attempts >= MAX_ATTEMPTS) drop(pendingId);
  return refuse(401, "invalid_code");
};

const mustEnrol = (person: Person) =>
  (person as Partial<StewardPerson>).enrolSecondFactor === true;

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
  if (person.secondFactor)
    return json({
      factors: FACTORS,
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

const verify = async (request: Request) => {
  const { code, kind, pendingId, token } = await readJson<{
    code: string;
    kind: string;
    pendingId: string;
    token: boolean;
  }>(request);
  if (!kind || !["email", "passkey", "totp"].includes(kind))
    return refuse(400, "invalid_request");
  if (kind !== "passkey" && !code) return refuse(400, "invalid_request");
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  const offered =
    found.pending.purpose === "challenge" &&
    (FACTORS as readonly string[]).includes(kind);
  if (!offered || !goodCode(code))
    return wrongCode(found.pendingId, found.pending);
  drop(found.pendingId);
  return startSession(found.person, token === true);
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
  return undefined;
};
