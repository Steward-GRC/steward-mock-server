// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's passkeys. There's no authenticator behind the mock, so it never checks a signature:
// the challenge it hands out is valid WebAuthn request options, and the answer is taken as the
// passkey whose credential id it carries, the way steward-gateway's own tests stand in a fake
// Kratos and identity for the ceremony. A person with `passkey: true` has one passkey, whose id
// is the base64url of "mock-passkey:<username>".

import { randomBytes } from "node:crypto";

import { mockState, type Person } from "#core/state.ts";
import { hasPasskey } from "#product/sign-in-state.ts";

/** go-webauthn's default ceremony timeout, in milliseconds. */
const TIMEOUT_MS = 300_000;

/** The id of a person's mock passkey: base64url of "mock-passkey:<username>". */
export const passkeyCredentialId = (username: string): string =>
  Buffer.from(`mock-passkey:${username}`).toString("base64url");

/**
 * WebAuthn request options as identity (go-webauthn) and Kratos send them: a fresh challenge
 * for the host the caller reached the mock on. With a person, it asks for their passkey only;
 * without one, any passkey for the host will do (a passkey sign-in).
 */
export const requestOptions = (request: Request, person?: Person) => ({
  publicKey: {
    ...(person
      ? {
          allowCredentials: [
            { id: passkeyCredentialId(person.username), type: "public-key" },
          ],
        }
      : {}),
    challenge: randomBytes(32).toString("base64url"),
    rpId: new URL(request.url).hostname,
    timeout: TIMEOUT_MS,
    userVerification: "preferred",
  },
});

/** The person whose passkey signed an assertion (its `id` or `rawId`), if anyone's did. */
export const passkeyOwner = (credentialJson: string): Person | undefined => {
  let credential: unknown;
  try {
    credential = JSON.parse(credentialJson);
  } catch {
    return undefined;
  }
  if (typeof credential !== "object" || credential === null) return undefined;
  const { id, rawId } = credential as { id?: unknown; rawId?: unknown };
  const ids = new Set([id, rawId].filter((v) => typeof v === "string"));
  return mockState.data.people.find(
    (p) => hasPasskey(p) && ids.has(passkeyCredentialId(p.username)),
  );
};
