// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's own buttons on the /_mock page and kinds for POST /_mock/controls, beside the core's
// (reset, fresh, fail-next, expire-session, sign-in). They arrive with the behaviour they drive.

import type { Action, ProductControl } from "#core/controls.ts";

import { mockState } from "#core/state.ts";
import { stewardData } from "#product/data.ts";
import { expireTestLinks } from "#product/sso.ts";

export const productActions: ({ run: ProductControl } & Action)[] = [
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
  };
};
