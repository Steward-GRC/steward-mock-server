// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// How Steward's gateway answers while maintenance is on (internal/maintenance gate.go). Only
// GraphQL is gated: an operation whose root fields are all on the gateway's whitelist
// (globalSettings, me and introspection) runs, so the lockdown can render and learn the caller's
// role, and anything else answers the gateway's MAINTENANCE error. The gateway's other routes
// (/auth, /setup, the SSO admin routes and GET /maintenance) keep answering. New websockets and
// anything else get the core's 503.
//
// The gateway also lets a site admin run every operation during maintenance. The core decides
// GraphQL before the product sees the caller, so that needs a hook the template doesn't have
// yet; until it does, a site admin gets the same whitelist as everyone else.

import type { ProductMaintenance } from "#core/product.ts";

import { answerAuth } from "#core/auth.ts";
import { json, refuse } from "#core/http.ts";
import { maintenanceAnswer } from "#core/maintenance.ts";
import { settings } from "#core/product.ts";
import { answerSetup } from "#core/setup.ts";
import { globalSettingsNow } from "#product/resolvers/admin.ts";
import { stewardRoutes } from "#product/routes.ts";

/** The gateway's whitelist, beside __typename, which the core always lets through. */
const WHITELIST = ["globalSettings", "me", "__schema", "__type"];

/** The gateway routes that aren't gated: everything here but GraphQL and websockets. */
const UNGATED = ["/auth/", "/setup/", "/admin/"];

const ungated = (request: Request, path: string) =>
  !request.headers.has("upgrade") &&
  (path === "/maintenance" ||
    UNGATED.some((prefix) => path.startsWith(prefix)));

/** What those routes answer, the same as when maintenance is off. */
const passThrough = async (request: Request, path: string) =>
  (await stewardRoutes(request, path)) ??
  (await answerAuth(request, path)) ??
  (await answerSetup(request, path)) ??
  refuse(501, "not_mocked");

export const stewardMaintenance: ProductMaintenance = {
  answer: (request, path, window) => {
    if (ungated(request, path))
      // The core awaits this answer for an HTTP request; the websocket upgrade, which doesn't,
      // never gets here.
      return passThrough(request, path) as unknown as Response;
    if (path === settings().graphqlPath && !request.headers.has("upgrade"))
      return json({
        errors: [
          {
            extensions: {
              code: "MAINTENANCE",
              message: globalSettingsNow().maintenance.message,
            },
            message: "the system is in maintenance mode",
          },
        ],
      });
    return maintenanceAnswer(window);
  },
  fields: WHITELIST,
};
