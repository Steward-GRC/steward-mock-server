// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's whole state, in this process's memory. Every client (a staff app, an admin console,
// a phone) talks to the same state, so a change one makes is what the others read. It resets when
// the server restarts, from the controls page, and between tests.

import { publish, SESSIONS_ENDED } from "#core/events.ts";
import { type ProductData, seed } from "#product/data.ts";

/** The fail-next control's armed failure, spent on the next GraphQL call. */
export interface Failure {
  /** "graphql" answers a GraphQL error at 200; "http" answers the status with no body. */
  mode: "graphql" | "http";
  status: number;
}

/** A password check waiting for its second factor, or for one to be enrolled. */
export interface Pending {
  /** Wrong codes so far; the gateway gives up on the fifth. */
  attempts: number;
  personId: string;
  purpose: "challenge" | "enrol";
}

/** Someone who can sign in. The product's seed data lists them. */
export interface Person {
  /** Can't sign in: the gateway answers invalid_credentials, as it does for a disabled user. */
  disabled?: boolean;
  email: string;
  /**
   * Has no second factor yet but must enrol one before signing in: the gateway answers the
   * password with enrollmentRequired, and enrolling turns secondFactor on.
   */
  enrolSecondFactor?: boolean;
  id: string;
  name: string;
  roles: string[];
  /** Asks for a six-digit code after the password. */
  secondFactor: boolean;
  username: string;
}

export interface Session {
  /** A browser sends this back in X-CSRF-Token on every unsafe call. */
  csrf: string;
  id: string;
  personId: string;
  startedAt: number;
}

const startedAt = new Date().toISOString();

export const mockState = {
  /** The product's invented data: people and everything its schema serves. */
  data: seed() as ProductData,
  failNext: null as Failure | null,
  /** When Start fresh last ran. */
  freshAt: null as null | string,
  /** A new install: the clients walk first-run setup until /setup/bootstrap. */
  needsSetup: process.env.MOCK_FRESH_INSTALL === "1",
  /** Password checks waiting for their second factor, by pending id. */
  pending: new Map<string, Pending>(),
  sessions: new Map<string, Session>(),
  startedAt,
  /** A native client's bearer tokens, each standing for a session. */
  tokens: new Map<string, string>(),
};

export const personById = (id: string): Person | undefined =>
  mockState.data.people.find((p) => p.id === id);

/** Put the invented data back. Whoever is signed in stays signed in. */
export const resetData = (): void => {
  mockState.data = seed();
  mockState.failNext = null;
};

/** End sessions (all of them, or one person's), and tell open connections. */
export const endSessions = (personId?: string): void => {
  for (const [sid, session] of mockState.sessions) {
    if (personId && session.personId !== personId) continue;
    mockState.sessions.delete(sid);
    for (const [token, owner] of mockState.tokens)
      if (owner === sid) mockState.tokens.delete(token);
  }
  publish(SESSIONS_ENDED, { personId: personId ?? null });
};

/** Back to first boot: the seed data, nobody signed in, and first-run setup when asked. */
export const startFresh = (firstRun = false): void => {
  resetData();
  mockState.pending.clear();
  endSessions();
  mockState.needsSetup = firstRun;
  mockState.freshAt = new Date().toISOString();
};
