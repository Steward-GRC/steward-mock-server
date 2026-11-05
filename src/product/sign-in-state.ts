// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What the gateway's sign-in routes share (internal/bff): the session they end in, the sign-in
// parked for a second factor, and the factors a person has. The password, SSO and passkey
// routes all finish through here.

import type { StewardPerson } from "#product/data/people.ts";

import { WRONG_CODE } from "#core/auth.ts";
import { json, newId, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import { settings } from "#core/product.ts";
import {
  mockState,
  type Person,
  personById,
  type Session,
} from "#core/state.ts";
import { rememberHost } from "#product/passkeys.ts";

/** How long a session lasts, in seconds: the gateway's default SESSION_TTL of 168h. */
export const SESSION_SECONDS = 604_800;

/** Wrong codes a pending sign-in takes before the gateway drops it. */
const MAX_ATTEMPTS = 5;

const log = createLogger("steward-auth");

export interface PendingSignIn {
  attempts: number;
  purpose: "challenge" | "enrol";
  /** A passkey challenge was handed out for it (the gateway's WebauthnSessionID). */
  webauthnBegun?: boolean;
}

/**
 * What a pending sign-in is for and how many wrong codes it has taken. The core's
 * mockState.pending (id to person) says whether it still exists, so a reset or a fresh start
 * that clears it ends these too.
 */
const pendingSignIns = new Map<string, PendingSignIn>();

/** The gateway's cookie with COOKIE_INSECURE=true: no Secure, so it works over plain http. */
export const cookie = (sid: string, maxAge: number) =>
  `${settings().sessionCookie}=${sid}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Lax`;

/** A new session for a person: its id, and the CSRF token that goes with it. */
export const newSession = (person: Person): Session => {
  const session: Session = {
    csrf: newId("csrf"),
    id: newId("sid"),
    personId: person.id,
    startedAt: Date.now(),
  };
  mockState.sessions.set(session.id, session);
  log.debug("session started", { personId: person.id });
  return session;
};

/** The gateway's issueSession: the cookie, and the CSRF token (and a bearer token if asked). */
export const startSession = (
  person: Person,
  token = false,
  request?: Request,
): Response => {
  const session = newSession(person);
  if (request) rememberHost(session.id, request);
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
  return json(body, 200, { "set-cookie": cookie(session.id, SESSION_SECONDS) });
};

/** A person by username or email. */
export const findPerson = (username: string) => {
  const wanted = username.trim().toLowerCase();
  return mockState.data.people.find(
    (p) => p.username === wanted || p.email === wanted,
  );
};

export const goodCode = (code: string | undefined) =>
  !!code && /^\d{6}$/.test(code) && code !== WRONG_CODE;

export const mustEnrol = (person: Person) =>
  (person as Partial<StewardPerson>).enrolSecondFactor === true;

export const hasPasskey = (person: Person) =>
  (person as Partial<StewardPerson>).passkey === true;

/** The factors a person has, in the gateway's order (identity's ListUserFactors). */
export const factorsOf = (person: Person): string[] => [
  ...(person.secondFactor ? ["totp", "email"] : []),
  ...(hasPasskey(person) ? ["passkey"] : []),
];

export const park = (
  person: Person,
  purpose: PendingSignIn["purpose"],
): string => {
  const pendingId = newId("pending");
  mockState.pending.set(pendingId, person.id);
  pendingSignIns.set(pendingId, { attempts: 0, purpose });
  log.debug("sign-in pending", { pendingId, personId: person.id, purpose });
  return pendingId;
};

export const drop = (pendingId: string) => {
  mockState.pending.delete(pendingId);
  pendingSignIns.delete(pendingId);
};

/** The pending sign-in behind an id and its person, or the gateway's refusal. */
export const pendingOf = (
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
export const wrongCode = (
  pendingId: string,
  pending: PendingSignIn,
): Response => {
  pending.attempts += 1;
  if (pending.attempts >= MAX_ATTEMPTS) drop(pendingId);
  return refuse(401, "invalid_code");
};
