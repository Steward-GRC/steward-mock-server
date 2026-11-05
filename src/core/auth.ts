// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The gateway's sign-in routes under /auth. A browser gets a session cookie and a CSRF token it
// sends back in X-CSRF-Token; a native client asks for a bearer token instead ("token": true),
// because a phone has no cookie jar the gateway can rely on. Both stand for the same kind of
// session, so a person signed in on the web and on a phone sees the same data.
//
// A person signs in with exactly the password set for them, in the seed or on /_mock, and a
// change there counts from the next sign-in. Any six digits work as the second factor except
// WRONG_CODE, so clients can show that failure screen on purpose. Every refusal carries a
// `message` a client can show as it is.

import { cookieOf, json, newId, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import { settings } from "#core/product.ts";
import {
  mockState,
  type Person,
  personById,
  type Session,
} from "#core/state.ts";

export const WRONG_CODE = "000000";

/** How long a cookie session lasts, in seconds. */
const SESSION_SECONDS = 1800;

const log = createLogger("auth");

const cookie = (sid: string, maxAge: number) =>
  `${settings().sessionCookie}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}`;

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
  const sid = cookieOf(request.headers.get("cookie"), settings().sessionCookie);
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

/** Start a session the way the gateway does, with a bearer token for a native client. */
export const issueSession = (person: Person, token = false): Response => {
  const session: Session = {
    csrf: newId("csrf"),
    id: newId("sid"),
    personId: person.id,
    startedAt: Date.now(),
  };
  mockState.sessions.set(session.id, session);
  const body: Record<string, unknown> = {
    csrfToken: session.csrf,
    personId: person.id,
  };
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

/**
 * The person a username and password sign in, or the gateway's refusal. The core's /auth/login
 * uses it, and a product whose sign-in is its own route calls it for the same check.
 */
export const checkCredentials = (
  username: string,
  password: string,
): Person | Response => {
  const person = findPerson(username);
  if (!person?.password || password !== person.password)
    return refuse(
      401,
      "invalid_credentials",
      "The username or password is wrong.",
    );
  if (person.disabled)
    return refuse(403, "account_disabled", "This account is disabled.");
  return person;
};

interface LoginBody {
  password: string;
  token: boolean;
  username: string;
}

const login = async (request: Request) => {
  const { password, token, username } = await readJson<LoginBody>(request);
  if (!username || !password)
    return refuse(400, "invalid_request", "Enter a username and a password.");
  const person = checkCredentials(username, password);
  if (person instanceof Response) return person;
  if (!person.secondFactor) return issueSession(person, token === true);
  const pendingId = newId("pending");
  mockState.pending.set(pendingId, person.id);
  return json({ factors: ["totp"], mfaRequired: true, pendingId });
};

interface VerifyBody {
  code: string;
  pendingId: string;
  token: boolean;
}

const verify = async (request: Request) => {
  const { code, pendingId, token } = await readJson<VerifyBody>(request);
  const personId = pendingId ? mockState.pending.get(pendingId) : undefined;
  const person = personId ? personById(personId) : undefined;
  if (!pendingId || !person)
    return refuse(
      401,
      "invalid_pending",
      "That sign-in has expired. Start again.",
    );
  if (!goodCode(code))
    return refuse(401, "invalid_code", "That code isn't right.");
  mockState.pending.delete(pendingId);
  return issueSession(person, token === true);
};

const session = (request: Request) => {
  const found = sessionOfToken(bearerOf(request)) ?? sessionOfCookie(request);
  if (!found) return json({ authenticated: false });
  return json({
    authenticated: true,
    csrfToken: found.csrf,
    personId: found.personId,
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

/** The /auth routes, or undefined when the path isn't one of them. */
export const answerAuth = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  const post = request.method === "POST";
  if (path === "/auth/login" && post) return login(request);
  if (path === "/auth/verify" && post) return verify(request);
  if (path === "/auth/logout" && post) return logout(request);
  if (path === "/auth/session" && request.method === "GET")
    return session(request);
  if (path.startsWith("/auth/")) return refuse(404, "not_found");
  return undefined;
};
