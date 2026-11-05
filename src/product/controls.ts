// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's own buttons on the /_mock page and kinds for POST /_mock/controls, beside the core's
// (reset, fresh, fail-next, expire-session, sign-in). They arrive with the behaviour they drive.

import type { Action, ProductControl } from "#core/controls.ts";

import { mockState } from "#core/state.ts";

export const productActions: ({ run: ProductControl } & Action)[] = [];

/** The counts the controls page shows under Data. */
export const productSummary = (): Record<string, number> => ({
  people: mockState.data.people.length,
});
