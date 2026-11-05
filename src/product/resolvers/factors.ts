// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The caller's own second factors on the profile pages, as steward-gateway answers them from
// identity's ReadService (internal/resolvers/factor_resolver.go, internal/handlers/mfa.go and
// webauthn.go): enrolling an authenticator app, registering, listing, naming and removing
// passkeys, and removing a factor. The gateway relays identity's InvalidArgument and NotFound,
// and turns AlreadyExists and FailedPrecondition into plain errors, which it presents as a fault.
//
// A person keeps several passkeys (src/product/passkeys.ts). There's no authenticator behind the
// mock, so a registration takes any well-formed credential and stores it under the id it
// carries; an id anyone already registered is refused, as identity's unique credential id is.
// The relying-party id is the configured public host, else the host the session signed in on.

import { randomBytes, randomUUID } from "node:crypto";

import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import {
  addPasskey,
  credentialIds,
  passkeysOf,
  rpIdForSession,
  setPasskeys,
} from "#product/passkeys.ts";
import { caller, data, record, refuse } from "#product/resolvers/shared.ts";
import { goodCode } from "#product/sign-in-state.ts";

/** identity's totpIssuer and the RP name it registers passkeys under. */
const ISSUER = "Steward";

/** identity's mfaLabelMaxLen and webauthnLabelMaxLen. */
const LABEL_MAX = 128;

/** go-webauthn's default ceremony timeout, in milliseconds. */
const TIMEOUT_MS = 300_000;

/** go-webauthn's default credential parameters: ES256, ES384, ES512, RS256..RS512, PS256..PS512, EdDSA. */
const ALGORITHMS = [-7, -35, -36, -257, -258, -259, -37, -38, -39, -8];

const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** What the gateway makes of AlreadyExists and FailedPrecondition: a plain error, a fault. */
const fault = () =>
  refuse("INTERNAL", "Something went wrong on our side. Please try again.");

const rfc3339 = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The authenticator hints a registration answer carries in response.transports. */
const transportsOf = (credential: object): string[] => {
  const { response } = credential as { response?: { transports?: unknown } };
  const given = response?.transports;
  return Array.isArray(given)
    ? given.filter((t): t is string => typeof t === "string")
    : [];
};

const userSubject = (person: StewardPerson) => ({
  id: person.id,
  kind: "user",
  label: person.name,
});

/** A pquerna/otp secret: 20 random bytes as 32 base32 characters, five bits each. */
const totpSecret = () =>
  [...randomBytes(32)].map((byte) => BASE32[byte % 32]).join("");

const pending = () => data().pendingFactors;

/** One passkey the caller holds, by credential id, or identity's NotFound. */
const ownPasskey = (
  person: StewardPerson,
  credentialId: string,
  what: string,
) => {
  const passkey = passkeysOf(person).find((p) => p.id === credentialId);
  if (!passkey) throw refuse("NOT_FOUND", what);
  return passkey;
};

export const factorResolvers: Resolvers = {
  Mutation: {
    /** identity's EnrollTotpBegin: a fresh secret, pending until a code proves it. */
    enrollTotpBegin: (_root, _given, context: Context) => {
      const person = caller(context);
      if (person.secondFactor) throw fault();
      const { totp } = pending();
      if (!totp.includes(person.id)) totp.push(person.id);
      const secret = totpSecret();
      const account = person.email || person.username || person.id;
      const query = new URLSearchParams({
        algorithm: "SHA1",
        digits: "6",
        issuer: ISSUER,
        period: "30",
        secret,
      });
      return {
        otpauthUri: `otpauth://totp/${ISSUER}:${encodeURI(account)}?${query.toString()}`,
        secretMasked: `••••${secret.slice(-4)}`,
      };
    },
    /** identity's EnrollTotpConfirm: any six digits but WRONG_CODE prove the pending secret. */
    enrollTotpConfirm: (_root, given: { code: string }, context: Context) => {
      const person = caller(context);
      if (!given.code) throw refuse("BAD_USER_INPUT", "code required");
      const { totp } = pending();
      if (!totp.includes(person.id)) throw fault();
      if (!goodCode(given.code)) throw refuse("BAD_USER_INPUT", "invalid code");
      totp.splice(totp.indexOf(person.id), 1);
      person.secondFactor = true;
      person.totpEnrolledAt = rfc3339(Date.now());
      person.totpLabel = null;
      record("user.mfa_factor_enrolled", person, userSubject(person));
      return true;
    },
    /** identity's RemoveFactor: the authenticator app (pending or not), or every passkey. */
    removeFactor: (_root, given: { kind: string }, context: Context) => {
      const person = caller(context);
      switch (given.kind) {
        case "email": {
          throw fault();
        }
        case "passkey": {
          if (passkeysOf(person).length === 0)
            throw refuse("NOT_FOUND", "no passkeys to remove");
          setPasskeys(person, []);
          break;
        }
        case "totp": {
          const { totp } = pending();
          const begun = totp.includes(person.id);
          if (!person.secondFactor && !begun)
            throw refuse("NOT_FOUND", "no totp enrollment to remove");
          if (begun) totp.splice(totp.indexOf(person.id), 1);
          person.secondFactor = false;
          person.totpEnrolledAt = undefined;
          person.totpLabel = null;
          break;
        }
        default: {
          throw refuse("BAD_USER_INPUT", `unknown factor kind "${given.kind}"`);
        }
      }
      record("user.mfa_factor_removed", person, userSubject(person));
      return true;
    },
    /** identity's RemoveWebauthnCredential: one passkey by its credential id. */
    removeWebauthnCredential: (
      _root,
      given: { credentialId: string },
      context: Context,
    ) => {
      const person = caller(context);
      if (!given.credentialId)
        throw refuse("BAD_USER_INPUT", "credential_id required");
      ownPasskey(person, given.credentialId, "no such credential");
      setPasskeys(
        person,
        passkeysOf(person).filter((p) => p.id !== given.credentialId),
      );
      record("user.mfa_factor_removed", person, userSubject(person));
      return true;
    },
    /** identity's RenameMFAMethod: "totp" or a passkey's credential id; "" clears the label. */
    renameMfaMethod: (
      _root,
      given: { label: string; methodId: string },
      context: Context,
    ) => {
      const person = caller(context);
      if (!given.methodId) throw refuse("BAD_USER_INPUT", "method_id required");
      if (given.label.length > LABEL_MAX)
        throw refuse(
          "BAD_USER_INPUT",
          `label too long (max ${String(LABEL_MAX)} characters)`,
        );
      if (given.methodId === "email") throw fault();
      if (given.methodId === "totp") {
        if (!person.secondFactor && !pending().totp.includes(person.id))
          throw refuse("NOT_FOUND", "no totp enrollment to rename");
        person.totpLabel = given.label || null;
      } else {
        ownPasskey(person, given.methodId, "no such passkey to rename").label =
          given.label || null;
      }
      record("user.mfa_factor_relabeled", person, userSubject(person));
      return true;
    },
    /** identity's WebauthnRegisterBegin: go-webauthn's creation options and a single-use session. */
    webauthnRegisterBegin: (_root, _given, context: Context) => {
      const person = caller(context);
      const sessionId = randomUUID();
      pending().webauthn[sessionId] = person.id;
      const name = person.email || person.username || person.id;
      const publicKey = {
        challenge: randomBytes(32).toString("base64url"),
        pubKeyCredParams: ALGORITHMS.map((alg) => ({
          alg,
          type: "public-key",
        })),
        rp: { id: rpIdForSession(context.session?.id), name: ISSUER },
        timeout: TIMEOUT_MS,
        user: {
          displayName: person.name || name,
          id: Buffer.from(person.id).toString("base64url"),
          name,
        },
        ...(passkeysOf(person).length > 0
          ? {
              excludeCredentials: passkeysOf(person).map(({ id }) => ({
                id,
                type: "public-key",
              })),
            }
          : {}),
        authenticatorSelection: { userVerification: "preferred" },
      };
      return { optionsJson: JSON.stringify({ publicKey }), sessionId };
    },
    /** identity's WebauthnRegisterFinish: the session is spent either way. */
    webauthnRegisterFinish: (
      _root,
      given: {
        credentialJson: string;
        label?: null | string;
        sessionId: string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      if (!given.credentialJson)
        throw refuse("BAD_USER_INPUT", "credential_json required");
      if (!given.sessionId)
        throw refuse("BAD_USER_INPUT", "session_id required");
      if (!UUID.test(given.sessionId))
        throw refuse(
          "BAD_USER_INPUT",
          given.sessionId.length === 36
            ? "invalid session_id: invalid UUID format"
            : `invalid session_id: invalid UUID length: ${String(given.sessionId.length)}`,
        );
      const sessions = pending().webauthn;
      if (sessions[given.sessionId] !== person.id)
        throw refuse(
          "NOT_FOUND",
          "no pending register ceremony for this session (expired, used, or unknown) — begin again",
        );
      delete sessions[given.sessionId];
      let credential: unknown;
      try {
        credential = JSON.parse(given.credentialJson);
      } catch {
        credential = undefined;
      }
      const [id] = credentialIds(given.credentialJson);
      if (typeof credential !== "object" || credential === null || !id)
        throw refuse("BAD_USER_INPUT", "malformed webauthn credential");
      const taken = data().people.some((p) =>
        passkeysOf(p).some((passkey) => passkey.id === id),
      );
      if (taken) throw fault();
      addPasskey(person, {
        id,
        label: (given.label ?? "").trim().slice(0, LABEL_MAX) || null,
        transports: transportsOf(credential),
      });
      record("user.mfa_factor_enrolled", person, userSubject(person));
      return true;
    },
  },
  Query: {
    /** identity's ListWebauthnCredentials: the caller's passkeys, oldest first. */
    myWebauthnCredentials: (_root, _given, context: Context) =>
      passkeysOf(caller(context)),
  },
};
