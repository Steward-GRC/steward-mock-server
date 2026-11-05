// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The probes clients call before signing in. /livez and /healthz never fail, whatever the controls
// armed, so a client's "server unreachable" screen only shows when the mock really is down.
// /readyz says not ready while maintenance closes the gateway, as a gateway in front of a stopped
// service does; a product whose maintenance gates only GraphQL stays ready.

import { json } from "#core/http.ts";
import {
  maintenance,
  maintenanceClosesGateway,
  maintenanceOn,
  retryAfter,
} from "#core/maintenance.ts";
import { settings } from "#core/product.ts";

const PROBES = new Set(["/healthz", "/livez", "/readyz"]);

export const answerHealth = (
  request: Request,
  path: string,
): Response | undefined => {
  if (request.method !== "GET" || !PROBES.has(path)) return undefined;
  const version = { [settings().versionHeader]: settings().version };
  // Not ready while maintenance is on; the process itself is still alive.
  if (path === "/readyz" && maintenanceOn() && maintenanceClosesGateway()) {
    return json({ status: "maintenance" }, 503, {
      ...version,
      "retry-after": String(retryAfter(maintenance())),
    });
  }
  return json({ status: "ok" }, 200, version);
};
