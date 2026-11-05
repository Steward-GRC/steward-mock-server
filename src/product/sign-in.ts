// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's sign-in helpers: the sign-in settings and the password reset by emailed code
// (internal/passwordreset), and passkey sign-in (internal/bff passkey.go). The /_mock controls
// switch each method (stewardData().signInMethods).
//
// The mock sends no mail: a reset code is any six digits but WRONG_CODE, as for every other
// emailed code, once a reset was asked for that address. The new password replaces the old one,
// so it's the only one that signs in from then on.

import { randomBytes } from "node:crypto";

import type { StewardPerson } from "#product/data/people.ts";

import { json, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import { stewardData } from "#product/data.ts";
import { passkeyOwner, requestOptions, stampUse } from "#product/passkeys.ts";
import { goodCode, startSession } from "#product/sign-in-state.ts";
import { ssoAvailable } from "#product/sso.ts";

/** How long a passkey sign-in may take between begin and finish: the gateway's TTL. */
const PASSKEY_FLOW_MS = 5 * 60_000;

const MSG_UNREADABLE =
  "That request could not be read. Reload the page and try again.";
const MSG_INVALID_CODE =
  "That code is invalid or has expired. Request a new code, then try again.";

const log = createLogger("steward-auth");

const methods = () => stewardData().signInMethods;

/** Go's ServeMux answer for a route nobody mounted. */
const notMounted = () =>
  new Response("404 page not found\n", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status: 404,
  });

/** internal/passwordreset's writeErr: {error, kind}, kind "business" below 500. */
const refuseWith = (status: number, message: string) =>
  json({ error: message, kind: status >= 500 ? "reach" : "business" }, status);

/** The body as JSON, or undefined when it isn't (the gateway's decode error). */
const bodyOf = async <T extends object>(
  request: Request,
): Promise<Partial<T> | undefined> => {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null
      ? (body as Partial<T>)
      : {};
  } catch {
    return undefined;
  }
};

/** GET /auth/config: the sign-in settings the page loads first. */
const config = () =>
  json({
    defaultLoginMethod: methods().defaultLoginMethod,
    // identity's emailed sign-in code (/auth/login-otp/*), which the mock doesn't serve.
    login2faEnabled: false,
    passkeyEnabled: methods().passkey,
    reportProblemUrl: "",
    ssoAvailable: ssoAvailable(),
  });

/** POST /auth/password-reset/request {email}: the same answer whether or not it exists. */
const requestReset = async (request: Request) => {
  const body = await bodyOf<{ email: string }>(request);
  if (!body) return refuseWith(400, MSG_UNREADABLE);
  if (typeof body.email !== "string" || !body.email)
    return refuseWith(400, "Enter your email address.");
  const email = body.email.trim().toLowerCase();
  const resets = stewardData().passwordResets;
  if (!resets.includes(email)) resets.push(email);
  log.info("password reset code sent (any six digits but the wrong code work)");
  return json({ ok: true });
};

/**
 * POST /auth/password-reset/confirm {email, code, newPassword}. identity answers a person with
 * no local password, an unknown address or a bad code alike.
 */
const confirmReset = async (request: Request) => {
  const body = await bodyOf<{
    code: string;
    email: string;
    newPassword: string;
  }>(request);
  if (!body) return refuseWith(400, MSG_UNREADABLE);
  const { code, email, newPassword } = body;
  if (!email || !code || !newPassword)
    return refuseWith(400, "Code and new password are required.");
  const wanted = email.trim().toLowerCase();
  const person = stewardData().people.find((p) => p.email === wanted) as
    | StewardPerson
    | undefined;
  const resets = stewardData().passwordResets;
  if (!person?.localAccount || !resets.includes(wanted) || !goodCode(code))
    return refuseWith(400, MSG_INVALID_CODE);
  stewardData().passwordResets = resets.filter((sent) => sent !== wanted);
  // The new password is the one that signs in from now on, as on /_mock.
  person.password = newPassword;
  log.debug("password reset", { personId: person.id });
  return json({ ok: true });
};

/** Passkey sign-ins between begin and finish, by their one-shot ticket. */
const passkeyFlows = new Map<string, number>();

/** POST /auth/passkey/login/begin: {flowId, optionsJson} for any passkey on this host. */
const passkeyBegin = (request: Request) => {
  if (!methods().passkey) return refuse(404, "passkey_unavailable");
  const flowId = randomBytes(32).toString("base64url");
  passkeyFlows.set(flowId, Date.now() + PASSKEY_FLOW_MS);
  return json({
    flowId,
    optionsJson: JSON.stringify(requestOptions(request)),
  });
};

/**
 * POST /auth/passkey/login/finish {flowId, credentialJson}: the passkey's person gets a session,
 * with no second factor. Every refusal answers like a wrong password.
 */
const passkeyFinish = async (request: Request) => {
  const { credentialJson, flowId } = await readJson<{
    credentialJson: string;
    flowId: string;
  }>(request);
  if (
    typeof flowId !== "string" ||
    !flowId ||
    typeof credentialJson !== "string" ||
    !credentialJson
  )
    return refuse(400, "invalid_request");
  if (!methods().passkey) return refuse(404, "passkey_unavailable");
  const expiresAt = passkeyFlows.get(flowId);
  passkeyFlows.delete(flowId);
  if (!expiresAt || expiresAt <= Date.now())
    return refuse(400, "invalid_request");
  const person = passkeyOwner(credentialJson);
  if (!person || person.disabled) return refuse(401, "invalid_credentials");
  stampUse(credentialJson);
  return startSession(person, false, request);
};

/** The reset package's routes, answered as unmounted while password reset is off. */
const RESET_ROUTES: Record<
  string,
  { method: string; run: (request: Request) => Promise<Response> | Response }
> = {
  "/auth/config": { method: "GET", run: config },
  "/auth/password-reset/confirm": { method: "POST", run: confirmReset },
  "/auth/password-reset/request": { method: "POST", run: requestReset },
};

const PASSKEY_ROUTES: Record<
  string,
  (request: Request) => Promise<Response> | Response
> = {
  "/auth/passkey/login/begin": passkeyBegin,
  "/auth/passkey/login/finish": passkeyFinish,
};

/** The sign-in helpers, or undefined for a path they don't serve. */
export const signInRoutes = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  const reset = RESET_ROUTES[path];
  if (reset && request.method === reset.method)
    return methods().passwordReset ? reset.run(request) : notMounted();
  const passkey = PASSKEY_ROUTES[path];
  if (passkey && request.method === "POST") return passkey(request);
  return undefined;
};
