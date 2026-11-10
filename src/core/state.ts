// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's whole state, in this process's memory. Every client (a staff app, an admin console,
// a phone) talks to the same state, so a change one makes is what the others read. It resets when
// the server restarts, from the controls page, and between tests.

import { MAINTENANCE_CHANGED, publish, SESSIONS_ENDED } from "#core/events.ts";
import { onProductChange, product, type ProductData } from "#core/product.ts";

/** The fail-next control's armed failure, spent on the next GraphQL call. */
export interface Failure {
  /** "graphql" answers a GraphQL error at 200; "http" answers the status with no body. */
  mode: "graphql" | "http";
  status: number;
}

/**
 * The gateway's maintenance window: nothing planned, announced ahead, or on now. While it's on,
 * the gateway paths answer the product's maintenance refusal (src/core/maintenance.ts).
 */
export interface MaintenanceWindow {
  endsAt: null | string;
  message: null | string;
  startsAt: null | string;
  state: "active" | "announced" | "none";
}

/** Someone who can sign in. The product's seed data lists them. */
export interface Person {
  /** Can't sign in: the gateway answers account_disabled. */
  disabled?: boolean;
  email: string;
  id: string;
  name: string;
  /**
   * The only password that signs this person in, set in the seed or on /_mock; an empty one
   * means no password sign-in. The mock never hands it out: /_mock/people says hasPassword.
   */
  password: string;
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

export const noMaintenance = (): MaintenanceWindow => ({
  endsAt: null,
  message: null,
  startsAt: null,
  state: "none",
});

const startedAt = new Date().toISOString();

export const mockState = {
  /** The product's invented data: people and everything its schema serves. */
  data: { people: [] } as ProductData,
  failNext: null as Failure | null,
  /** When Start fresh last ran. */
  freshAt: null as null | string,
  /** The maintenance window every client sees. */
  maintenance: noMaintenance(),
  /** A new install: the clients walk first-run setup until /setup/complete. */
  needsSetup: process.env.MOCK_FRESH_INSTALL === "1",
  /** Password checks waiting for their second factor, by pending id. */
  pending: new Map<string, string>(),
  sessions: new Map<string, Session>(),
  startedAt,
  /** A native client's bearer tokens, each standing for a session. */
  tokens: new Map<string, string>(),
};

export const personById = (id: string): Person | undefined =>
  mockState.data.people.find((p) => p.id === id);

/** Put the invented data back. Whoever is signed in stays signed in. */
export const resetData = (): void => {
  const { installSeed, seed, startsAsInstall } = product();
  mockState.data = installSeed && startsAsInstall?.() ? installSeed() : seed();
  mockState.failNext = null;
  mockState.maintenance = noMaintenance();
  publish(MAINTENANCE_CHANGED, noMaintenance());
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
  const { installSeed, startsAsInstall } = product();
  // A new install has none of the seed's people, so it is not the seed with setup switched on.
  if (firstRun && installSeed) mockState.data = installSeed();
  mockState.pending.clear();
  endSessions();
  mockState.needsSetup =
    firstRun || (installSeed !== undefined && startsAsInstall?.() === true);
  mockState.freshAt = new Date().toISOString();
};

// A new product starts on its own seed data, with nobody signed in.
onProductChange(() => {
  startFresh(process.env.MOCK_FRESH_INSTALL === "1");
  mockState.freshAt = null;
});
