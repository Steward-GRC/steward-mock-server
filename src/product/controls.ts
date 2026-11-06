// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's own buttons on the /_mock page and kinds for POST /_mock/controls, beside the core's
// (reset, fresh, fail-next, expire-session, sign-in). They arrive with the behaviour they drive.

import type { Action, ProductControl } from "#core/controls.ts";

import { refuse } from "#core/http.ts";
import { mockState } from "#core/state.ts";
import { type SignInMethods, stewardData } from "#product/data.ts";
import { expireTestLinks } from "#product/sso.ts";

/**
 * POST /_mock/controls {kind: "sign-in-methods"} with any of sso, passkey and passwordReset
 * (true or false) and defaultLoginMethod ("local" or "sso"): what /auth/config offers, and
 * whether the routes behind it answer.
 */
const switchMethods: ProductControl = (body) => {
  const methods: SignInMethods = stewardData().signInMethods;
  for (const key of ["passkey", "passwordReset", "sso"] as const)
    if (typeof body[key] === "boolean") methods[key] = body[key];
  if (body.defaultLoginMethod === "local" || body.defaultLoginMethod === "sso")
    methods.defaultLoginMethod = body.defaultLoginMethod;
  return methods;
};

/** One button per switch, both ways. */
const methodButton = (
  label: string,
  body: Record<string, unknown>,
  hint: string,
): { run: ProductControl } & Action => ({
  body,
  hint,
  kind: "sign-in-methods",
  label,
  run: switchMethods,
  section: "Sign-in methods",
});

const signInMethodActions = [
  methodButton(
    "SSO off",
    { sso: false },
    "/auth/config says ssoAvailable false and discovery answers local for everyone.",
  ),
  methodButton(
    "SSO on",
    { sso: true },
    "Discovery sends everyone to SSO, and /auth/sso/start signs them straight in.",
  ),
  methodButton(
    "Passkeys off",
    { passkey: false },
    "passkeyEnabled false, and passkey sign-in answers 404 passkey_unavailable.",
  ),
  methodButton(
    "Passkeys on",
    { passkey: true },
    "The passkey button, and Charlie's passkey signs in.",
  ),
  methodButton(
    "Password reset off",
    { passwordReset: false },
    "Answers like a gateway without the reset package: /auth/config and the reset routes 404, so the page offers the password only.",
  ),
  methodButton(
    "Password reset on",
    { passwordReset: true },
    "Reset codes are any six digits but 000000.",
  ),
  methodButton(
    "SSO first",
    { defaultLoginMethod: "sso" },
    "defaultLoginMethod is sso.",
  ),
  methodButton(
    "Password first",
    { defaultLoginMethod: "local" },
    "defaultLoginMethod is local.",
  ),
];

/**
 * POST /_mock/controls {kind: "needs-onboarding", personId, needsOnboarding?}: whether that person
 * still owes first-run onboarding (true unless the body says false), so the welcome page shows.
 */
const needsOnboarding: ProductControl = (body) => {
  const person = stewardData().people.find((p) => p.id === body.personId);
  if (!person) return refuse(404, "unknown_person");
  Object.assign(person, { needsOnboarding: body.needsOnboarding !== false });
  return {
    needsOnboarding: body.needsOnboarding !== false,
    personId: person.id,
  };
};

/**
 * POST /_mock/controls {kind: "ai-simulation", on}: whether Ask is simulated (the default) or AI
 * answers as if the ai service were down.
 */
const aiSimulation: ProductControl = (body) => {
  stewardData().aiSimulated = body.on !== false;
  return { aiSimulated: stewardData().aiSimulated };
};

export const productActions: ({ run: ProductControl } & Action)[] = [
  ...signInMethodActions,
  {
    body: { on: true },
    hint: "Ask answers from the policies the person may read, with citations; aiHealth says available.",
    kind: "ai-simulation",
    label: "Simulated AI on",
    run: aiSimulation,
    section: "AI",
  },
  {
    body: { on: false },
    hint: "AI answers as if the ai service were down: Ask shows its unavailable card.",
    kind: "ai-simulation",
    label: "Simulated AI off",
    run: aiSimulation,
    section: "AI",
  },
  {
    body: { personId: "user-erin" },
    hint: "Erin's next page is the welcome (G10) until she completes onboarding.",
    kind: "needs-onboarding",
    label: "Erin owes onboarding",
    run: needsOnboarding,
    section: "Onboarding",
  },
  {
    body: { outcome: "pass" },
    hint: "Opening an IdP test link passes the test, so the organisation can be activated.",
    kind: "idp-test-outcome",
    label: "IdP tests pass",
    run: (body) => {
      stewardData().idpTestOutcome = body.outcome === "fail" ? "fail" : "pass";
    },
    section: "Single sign-on",
  },
  {
    body: { outcome: "fail" },
    hint: "Opening an IdP test link fails the test, and activation stays refused.",
    kind: "idp-test-outcome",
    label: "IdP tests fail",
    run: (body) => {
      stewardData().idpTestOutcome = body.outcome === "fail" ? "fail" : "pass";
    },
    section: "Single sign-on",
  },
  {
    hint: "Every IdP test link minted so far answers 410, as after its 30 minutes.",
    kind: "expire-test-links",
    label: "Expire the IdP test links",
    run: () => {
      expireTestLinks();
    },
    section: "Single sign-on",
  },
];

/** The counts the controls page shows as tiles, and how the next IdP test ends. */
export const productSummary = (): Record<string, unknown> => {
  const data = stewardData();
  return {
    cases: data.reportCases.length,
    idpTestOutcome: data.idpTestOutcome,
    "open runs": data.runs.filter(
      (run) => run.status === "APPROVAL_STATUS_IN_REVIEW",
    ).length,
    people: mockState.data.people.length,
    policies: data.policies.length,
    "sign-in":
      Object.entries(data.signInMethods)
        .filter(([key, on]) => key !== "defaultLoginMethod" && on === true)
        .map(([key]) => key)
        .join(", ") || "password only",
  };
};
