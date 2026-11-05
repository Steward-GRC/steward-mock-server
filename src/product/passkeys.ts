// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's passkeys. There's no authenticator behind the mock, so it never checks a signature:
// the challenge it hands out is valid WebAuthn options, and the answer is taken as the passkey
// whose credential id it carries, the way steward-gateway's own tests stand in a fake Kratos and
// identity for the ceremony. A person keeps several passkeys, oldest first, as identity's
// webauthn_credentials does. A seeded person with `passkey: true` starts with one, whose id is
// the base64url of "mock-passkey:<username>"; a registration adds one under the id its
// authenticator gave it.
//
// The relying-party id is identity's WEBAUTHN_RP_ID: the host of MOCK_PUBLIC_URL when it's set,
// else the host the request came on. A GraphQL resolver doesn't see its request, so a session
// remembers the host its sign-in came on (the host its cookie belongs to); a session with no
// request behind it (a control's sign-in) gets identity's default, localhost.

import { randomBytes } from "node:crypto";

import type { Passkey, StewardPerson } from "#product/data/people.ts";

import { mockState, type Person } from "#core/state.ts";

/** go-webauthn's default ceremony timeout, in milliseconds. */
const TIMEOUT_MS = 300_000;

/** identity's WEBAUTHN_RP_ID default. */
const DEFAULT_RP_ID = "localhost";

/** The id of a person's seeded passkey: base64url of "mock-passkey:<username>". */
export const passkeyCredentialId = (username: string): string =>
  Buffer.from(`mock-passkey:${username}`).toString("base64url");

const rfc3339 = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A person's passkeys, oldest first. The seeded one is made on first read from the seed's
 * `passkey`, `passkeyCreatedAt` and `passkeyLabel`: a platform authenticator never used yet.
 */
export const passkeysOf = (person: Person): Passkey[] => {
  const steward = person as Partial<StewardPerson>;
  if (steward.passkey !== true) return [];
  if (!steward.passkeys?.length)
    steward.passkeys = [
      {
        createdAt: steward.passkeyCreatedAt ?? rfc3339(Date.now()),
        id: passkeyCredentialId(person.username),
        label: steward.passkeyLabel || null,
        lastUsedAt: null,
        transports: ["internal", "hybrid"],
      },
    ];
  return steward.passkeys;
};

/** Replace a person's passkeys; with none left, the person has no passkey factor. */
export const setPasskeys = (person: Person, passkeys: Passkey[]): void => {
  const steward = person as Partial<StewardPerson>;
  steward.passkeys = passkeys;
  steward.passkey = passkeys.length > 0;
};

/** Add a registered passkey, dated now. */
export const addPasskey = (
  person: Person,
  passkey: Omit<Passkey, "createdAt" | "lastUsedAt">,
): void => {
  setPasskeys(person, [
    ...passkeysOf(person),
    { ...passkey, createdAt: rfc3339(Date.now()), lastUsedAt: null },
  ]);
};

/** The relying-party id: MOCK_PUBLIC_URL's host, else the request's, else identity's default. */
export const rpId = (requestHost?: string): string => {
  const configured = process.env.MOCK_PUBLIC_URL;
  if (configured)
    try {
      return new URL(configured).hostname;
    } catch {
      // An unusable setting falls through to the request's host.
    }
  return requestHost || DEFAULT_RP_ID;
};

/** The host each session's sign-in request came on, by session id. */
const sessionHosts = new Map<string, string>();

export const rememberHost = (sessionId: string, request: Request): void => {
  sessionHosts.set(sessionId, new URL(request.url).hostname);
};

/** The relying-party id for a GraphQL call on a session. */
export const rpIdForSession = (sessionId: string | undefined): string =>
  rpId(sessionId ? sessionHosts.get(sessionId) : undefined);

/**
 * WebAuthn request options as identity (go-webauthn) and Kratos send them: a fresh challenge
 * for the relying party. With a person, it asks for their passkeys only; without one, any
 * passkey for the relying party will do (a passkey sign-in).
 */
export const requestOptions = (request: Request, person?: Person) => {
  const allowed = person ? passkeysOf(person) : [];
  return {
    publicKey: {
      ...(person
        ? {
            allowCredentials: allowed.map(({ id }) => ({
              id,
              type: "public-key",
            })),
          }
        : {}),
      challenge: randomBytes(32).toString("base64url"),
      rpId: rpId(new URL(request.url).hostname),
      timeout: TIMEOUT_MS,
      userVerification: "preferred",
    },
  };
};

/** The credential ids a WebAuthn answer carries (`id` and `rawId`), or none when it isn't one. */
export const credentialIds = (credentialJson: string): string[] => {
  let credential: unknown;
  try {
    credential = JSON.parse(credentialJson);
  } catch {
    return [];
  }
  if (typeof credential !== "object" || credential === null) return [];
  const { id, rawId } = credential as { id?: unknown; rawId?: unknown };
  return [
    ...new Set([id, rawId].filter((v): v is string => typeof v === "string")),
  ].filter(Boolean);
};

const owned = (credentialJson: string) => {
  const ids = new Set(credentialIds(credentialJson));
  for (const person of mockState.data.people) {
    const passkey = passkeysOf(person).find((p) => ids.has(p.id));
    if (passkey) return { passkey, person };
  }
  return;
};

/** The person whose passkey signed an assertion, if anyone's did. */
export const passkeyOwner = (credentialJson: string): Person | undefined =>
  owned(credentialJson)?.person;

/** Stamp the passkey an accepted assertion used, as identity's sign-count update does. */
export const stampUse = (credentialJson: string): void => {
  const found = owned(credentialJson);
  if (found) found.passkey.lastUsedAt = rfc3339(Date.now());
};
