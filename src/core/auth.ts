// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The gateway's sign-in routes under /auth, as steward-gateway's internal/bff answers them. A
// browser gets the session cookie and a CSRF token it sends back in X-CSRF-Token on every call
// that needs a session. A native client may ask for a bearer token instead ("token": true), a
// mock extra for the phone apps, standing for the same kind of session.
//
// Any non-empty password works except WRONG_PASSWORD, and any six digits except WRONG_CODE, so
// clients can show their failure screens on purpose.
//
// Steward diverges from the template here (TEMPLATE.md step 7): the second factor is
// /auth/mfa/verify with a kind, a person may have to enrol a TOTP factor first, there is an
// email-code send, and a pending sign-in gives up after five wrong codes.

import { cookieOf, json, newId, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import {
  mockState,
  type Pending,
  type Person,
  personById,
  type Session,
} from "#core/state.ts";
import { product } from "#product/product.ts";

export const WRONG_PASSWORD = "wrong-password";
export const WRONG_CODE = "000000";

/** How long a session lasts, in seconds: the gateway's default SESSION_TTL of 168h. */
const SESSION_SECONDS = 604_800;

/** Wrong codes a pending sign-in takes before the gateway drops it. */
const MAX_ATTEMPTS = 5;

/** The factors a person with a second factor is offered, in the gateway's order. */
const FACTORS = ["totp", "email"] as const;

const log = createLogger("auth");

/** The gateway's cookie with COOKIE_INSECURE=true: no Secure, so it works over plain http. */
const cookie = (sid: string, maxAge: number) =>
  `${product.sessionCookie}=${sid}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Lax`;

const bearerOf = (request: Request): null | string => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
};

/** The session behind a bearer token. */
export const sessionOfToken = (
  token: null | string | undefined,
): null | Session => {
  const sid = token ? mockState.tokens.get(token) : undefined;
  return sid ? (mockState.sessions.get(sid) ?? null) : null;
};

/** The session behind the request's cookie alone, with no CSRF check (safe reads, websockets). */
export const sessionOfCookie = (request: Request): null | Session => {
  const sid = cookieOf(request.headers.get("cookie"), product.sessionCookie);
  return sid ? (mockState.sessions.get(sid) ?? null) : null;
};

/**
 * The session behind a call: a bearer token, or a cookie whose CSRF token came back in
 * X-CSRF-Token. A cookie without it is no session, which is how the gateway stops a page on
 * another site from calling it with the person's cookie.
 */
export const sessionOf = (request: Request): null | Session => {
  const bearer = bearerOf(request);
  if (bearer) return sessionOfToken(bearer);
  const session = sessionOfCookie(request);
  if (!session) return null;
  return request.headers.get("x-csrf-token") === session.csrf ? session : null;
};

/**
 * Why a call that needs a session has none, the gateway's way: a live cookie session whose CSRF
 * token is missing or wrong is 403 {"error":"csrf"}; anything else is 401 {"error":"unauthorized"}.
 */
export const refuseWithoutSession = (request: Request): Response =>
  !bearerOf(request) && sessionOfCookie(request)
    ? refuse(403, "csrf")
    : refuse(401, "unauthorized");

/** Start a session the way the gateway does, with a bearer token for a native client. */
export const issueSession = (person: Person, token = false): Response => {
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

const park = (person: Person, purpose: Pending["purpose"]): string => {
  const pendingId = newId("pending");
  mockState.pending.set(pendingId, {
    attempts: 0,
    personId: person.id,
    purpose,
  });
  log.debug("sign-in pending", { pendingId, personId: person.id, purpose });
  return pendingId;
};

/** The pending sign-in behind an id and its person, or the gateway's refusal. */
const pendingOf = (
  pendingId: string | undefined,
): { pending: Pending; person: Person } | { refusal: Response } => {
  if (!pendingId) return { refusal: refuse(400, "invalid_request") };
  const pending = mockState.pending.get(pendingId);
  const person = pending ? personById(pending.personId) : undefined;
  if (!pending || !person) return { refusal: refuse(401, "invalid_pending") };
  return { pending, person };
};

/** Count a wrong code; the fifth drops the pending sign-in. */
const wrongCode = (pendingId: string, pending: Pending): Response => {
  pending.attempts += 1;
  if (pending.attempts >= MAX_ATTEMPTS) mockState.pending.delete(pendingId);
  return refuse(401, "invalid_code");
};

interface LoginBody {
  password: string;
  token: boolean;
  username: string;
}

const login = async (request: Request) => {
  const { password, token, username } = await readJson<LoginBody>(request);
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
  if (person.enrolSecondFactor)
    return json({
      enrollmentRequired: true,
      mfaRequired: true,
      pendingId: park(person, "enrol"),
    });
  return issueSession(person, token === true);
};

interface VerifyBody {
  code: string;
  kind: string;
  pendingId: string;
  token: boolean;
}

const verify = async (request: Request) => {
  const { code, kind, pendingId, token } = await readJson<VerifyBody>(request);
  if (!kind || !["email", "passkey", "totp"].includes(kind))
    return refuse(400, "invalid_request");
  if (kind !== "passkey" && !code) return refuse(400, "invalid_request");
  const found = pendingOf(pendingId);
  if ("refusal" in found) return found.refusal;
  const { pending, person } = found;
  const offered =
    pending.purpose === "challenge" &&
    (FACTORS as readonly string[]).includes(kind);
  if (!offered || !goodCode(code))
    return wrongCode(pendingId as string, pending);
  mockState.pending.delete(pendingId as string);
  return issueSession(person, token === true);
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
  const label = encodeURIComponent(`${product.name}:${found.person.email}`);
  return json({
    otpauthUri: `otpauth://totp/${label}?issuer=${encodeURIComponent(product.name)}&secret=MOCKMOCKMOCKMOCK`,
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
  const { pending, person } = found;
  if (pending.purpose !== "enrol") return refuse(400, "invalid_request");
  if (!goodCode(code)) return wrongCode(pendingId as string, pending);
  mockState.pending.delete(pendingId as string);
  Object.assign(person, { enrolSecondFactor: false, secondFactor: true });
  log.debug("second factor enrolled", { personId: person.id });
  return issueSession(person, token === true);
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
};

/** The /auth routes, or undefined when the path isn't one of them. */
export const answerAuth = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  const post = POST_ROUTES[path];
  if (post && request.method === "POST") return post(request);
  if (path === "/auth/session" && request.method === "GET")
    return session(request);
  if (path.startsWith("/auth/")) return refuse(404, "not_found");
  return undefined;
};
