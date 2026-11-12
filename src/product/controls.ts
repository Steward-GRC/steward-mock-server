// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's own buttons on the /_mock page and kinds for POST /_mock/controls, beside the core's
// (reset, fresh, fail-next, expire-session, sign-in). They arrive with the behaviour they drive.

import type { Action, ProductControl } from "#core/controls.ts";

import { refuse } from "#core/http.ts";
import { mockState, startFresh } from "#core/state.ts";
import { assetActions } from "#product/assets.ts";
import {
  parseStartState,
  type SignInMethods,
  startState,
  stewardData,
} from "#product/data.ts";
import { asSteward, type StewardPerson } from "#product/data/people.ts";
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
 * POST /_mock/controls {kind: "ack-due-days", days}: the days after publishing that an
 * acknowledgement is due (steward-obligations' ACK_DUE_DAYS); 0 turns due dates off, so every
 * dueAt is null. A reset brings back 14 (or the ACK_DUE_DAYS environment variable).
 */
const ackDueDays: ProductControl = (body) => {
  const days = body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0)
    return refuse(
      400,
      "invalid_days",
      "days is a whole number of 0 or more (0 turns due dates off).",
    );
  stewardData().ackDueDays = days;
  return { ackDueDays: days };
};

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
 * POST /_mock/controls {kind: "start-state", state: "demo" | "sample"}: which data Reset and Start
 * fresh return to, and a fresh start on it with everyone signed out.
 */
const startStateControl: ProductControl = (body) => {
  startState.value = parseStartState(body.state);
  startFresh(false);
  return { startState: startState.value };
};

/**
 * POST /_mock/controls {kind: "ai-simulation", on}: whether Ask is simulated (the default) or AI
 * answers as if the ai service were down.
 */
const aiSimulation: ProductControl = (body) => {
  stewardData().aiSimulated = body.on !== false;
  return { aiSimulated: stewardData().aiSimulated };
};

/**
 * The reasons steward-ai's GetProviderStatus gives while it is not available: a failing provider,
 * or jobs_unavailable when the service has no Kubernetes API so no job can run.
 */
const PROVIDER_REASONS = [
  "auth_failed",
  "provider_error",
  "not_configured",
  "jobs_unavailable",
];

/**
 * POST /_mock/controls {kind: "ai-provider", providerReason}: the model provider behind the ai
 * service. null brings it back; auth_failed, provider_error, not_configured or jobs_unavailable is
 * an outage with that reason (jobs_unavailable also refuses the job submits), and "" an outage ai gave no reason for. aiHealth then says provider_unavailable with
 * the reason as providerReason, while the simulation is on (with it off the service is unreachable).
 */
const aiProvider: ProductControl = (body) => {
  const reason = body.providerReason ?? null;
  if (
    reason !== null &&
    (typeof reason !== "string" ||
      (reason !== "" && !PROVIDER_REASONS.includes(reason)))
  )
    return refuse(
      400,
      "unknown_provider_reason",
      `providerReason is null, "", or one of ${PROVIDER_REASONS.join(", ")}.`,
    );
  stewardData().aiProviderOutage = reason;
  return { aiProviderOutage: reason };
};

/**
 * POST /_mock/controls {kind: "ai-limit", reached}: whether an AI usage limit holds, the
 * organisation's monthly limit or the caller's daily one (the gateway reports both the same way).
 * aiHealth then says limit_reached, with no providerReason, and the job submits are refused with
 * FailedPrecondition. A provider outage, or the ai service being down, is reported in its place.
 */
const aiLimit: ProductControl = (body) => {
  stewardData().aiLimitReached = body.reached !== false;
  return { aiLimitReached: stewardData().aiLimitReached };
};

/**
 * POST /_mock/controls {kind: "add-duplicate-person", personId}: a second account for the same
 * person, to try Merge accounts on (steward-web bug log #110). Same email, the name spelled
 * differently, and the other kind of sign-in (local or SSO), no roles. Numbered per person.
 */
const addDuplicatePerson: ProductControl = (body) => {
  const people = mockState.data.people as StewardPerson[];
  const source = people.find(
    (p) => p.id === String(body.personId ?? "user-erin"),
  );
  if (!source) throw refuse(404, "unknown_person", "No such person.");
  let n = 1;
  while (people.some((p) => p.id === `${source.id}-dup${String(n)}`)) n++;
  const [first = source.name, ...rest] = source.name.split(" ");
  const copy: StewardPerson = {
    ...asSteward(source),
    deletedAt: null,
    disabled: false,
    groups: [...(asSteward(source).groups ?? [])].filter(
      (g) => !g.startsWith("Manages "),
    ),
    id: `${source.id}-dup${String(n)}`,
    localAccount: !asSteward(source).localAccount,
    mergedIntoUserId: null,
    name: [`${first}${first.slice(-1)}`, ...rest].join(" "),
    policyOverrides: [],
    roles: [],
    secondFactor: false,
    username: `${source.username}.dup${String(n)}`,
  };
  people.push(copy);
  return { id: copy.id, name: copy.name };
};

export const productActions: ({ run: ProductControl } & Action)[] = [
  {
    body: { providerReason: null },
    hint: "The model provider works: aiHealth has no providerReason.",
    kind: "ai-provider",
    label: "AI provider healthy",
    run: aiProvider,
    section: "AI",
  },
  {
    body: { providerReason: "auth_failed" },
    hint: "The provider refuses its credential: aiHealth says provider_unavailable, providerReason auth_failed.",
    kind: "ai-provider",
    label: "AI provider: auth failed",
    run: aiProvider,
    section: "AI",
  },
  {
    body: { providerReason: "provider_error" },
    hint: "The provider call fails: aiHealth says provider_unavailable, providerReason provider_error.",
    kind: "ai-provider",
    label: "AI provider: error",
    run: aiProvider,
    section: "AI",
  },
  {
    body: { providerReason: "not_configured" },
    hint: "No provider is set up: aiHealth says provider_unavailable, providerReason not_configured.",
    kind: "ai-provider",
    label: "AI provider: not configured",
    run: aiProvider,
    section: "AI",
  },
  {
    body: { providerReason: "" },
    hint: "An outage ai gave no reason for: provider_unavailable with a null providerReason.",
    kind: "ai-provider",
    label: "AI provider: no reason",
    run: aiProvider,
    section: "AI",
  },
  {
    body: { personId: "user-erin" },
    hint: "Adds a second account for Erin (same email, name spelled differently, the other kind of sign-in) to try Merge accounts on.",
    kind: "add-duplicate-person",
    label: "Add a duplicate of Erin",
    run: addDuplicatePerson,
    section: "Merge accounts",
  },
  {
    body: { personId: "user-bob" },
    hint: "Adds a second account for Bob to try Merge accounts on.",
    kind: "add-duplicate-person",
    label: "Add a duplicate of Bob",
    run: addDuplicatePerson,
    section: "Merge accounts",
  },
  ...signInMethodActions,
  ...assetActions,
  {
    body: { state: "demo" },
    hint: "A brand-new install: the people, categories, templates, workflows and groups, and no documents. Reset and Start fresh return here. Everyone is signed out.",
    kind: "start-state",
    label: "Demo start state",
    run: startStateControl,
    section: "Start over",
  },
  {
    body: { state: "docs" },
    hint: "A data set designed for the user guide's screenshots: Example Organisation, the eight people, thirteen documents in the states the guide shows. Fixed ids and numbers. Reset and Start fresh return here. Everyone is signed out.",
    kind: "start-state",
    label: "Docs start state",
    run: startStateControl,
    section: "Start over",
  },
  {
    body: { state: "install" },
    hint: "A brand-new install: the basic setup and nobody to sign in as. First-run setup (the token is MOCK_SETUP_TOKEN, mock-setup-token by default) makes the first admin. Reset and Start fresh return to setup.",
    kind: "start-state",
    label: "New install start state",
    run: startStateControl,
    section: "Start over",
  },
  {
    body: { state: "sample" },
    hint: "The sample data, with its documents. Reset and Start fresh return here. Everyone is signed out.",
    kind: "start-state",
    label: "Sample data start state",
    run: startStateControl,
    section: "Start over",
  },
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
    body: { providerReason: "jobs_unavailable" },
    hint: "ai has no Kubernetes API: aiHealth says provider_unavailable, providerReason jobs_unavailable, and the job submits fail.",
    kind: "ai-provider",
    label: "AI provider: jobs unavailable",
    run: aiProvider,
    section: "AI",
  },
  {
    body: { days: 14 },
    hint: "Acknowledgements are due 14 days after publishing (the default): dueAt on myObligations, the roster's pending people and the overdue list.",
    kind: "ack-due-days",
    label: "Due after 14 days",
    run: ackDueDays,
    section: "Acknowledgements",
  },
  {
    body: { days: 0 },
    hint: "No due dates: every dueAt is null.",
    kind: "ack-due-days",
    label: "Due dates off",
    run: ackDueDays,
    section: "Acknowledgements",
  },
  {
    body: { reached: true },
    hint: "The monthly or daily AI limit is reached: aiHealth says limit_reached and the job submits are refused.",
    kind: "ai-limit",
    label: "AI limit reached",
    run: aiLimit,
    section: "AI",
  },
  {
    body: { reached: false },
    hint: "No AI limit holds: aiHealth and the submits work again.",
    kind: "ai-limit",
    label: "AI limit clear",
    run: aiLimit,
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
