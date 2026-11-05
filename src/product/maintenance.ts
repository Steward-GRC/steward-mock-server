// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// How Steward's gateway answers while maintenance is on (internal/maintenance gate.go). The gate
// is GraphQL middleware, so the scope is "graphql": every other route (/auth, /setup, the SSO
// admin routes, GET /maintenance, assets) and every websocket stays open, and /readyz stays
// ready. Each GraphQL operation, over HTTP or on the websocket, runs when its root fields are all
// on the gateway's whitelist (globalSettings, me and introspection), so the lockdown can render
// and learn the caller's role, or when the caller is a site admin, so the admin console stays open
// to them and they can lift maintenance there. Anything else answers the gateway's MAINTENANCE
// error.

import type { ProductMaintenance } from "#core/product.ts";

import { json } from "#core/http.ts";
import { maintenanceAnswer } from "#core/maintenance.ts";
import { settings } from "#core/product.ts";
import { personById } from "#core/state.ts";
import { globalSettingsNow } from "#product/resolvers/admin.ts";

/** The gateway's whitelist, beside __typename, which the core always lets through. */
const WHITELIST = ["globalSettings", "me", "__schema", "__type"];

export const stewardMaintenance: ProductMaintenance = {
  /** The gateway's site-admin bypass: everyone else keeps the whitelist. */
  allow: (_request, session) =>
    !!session &&
    (personById(session.personId)?.roles.includes("site-admin") ?? false),
  /** A refused GraphQL operation over HTTP: the gateway's error, with HTTP 200. */
  answer: (_request, path, window) =>
    path === settings().graphqlPath
      ? json({
          errors: [
            {
              extensions: {
                code: "MAINTENANCE",
                message: globalSettingsNow().maintenance.message,
              },
              message: "the system is in maintenance mode",
            },
          ],
        })
      : maintenanceAnswer(window),
  fields: WHITELIST,
  scope: "graphql",
};
