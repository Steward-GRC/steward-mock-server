// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The probes clients call before signing in. They never fail, whatever the controls armed, so a
// client's "server unreachable" screen only shows when the mock really is down.

import { json } from "#core/http.ts";
import { product } from "#product/product.ts";

const PROBES = new Set(["/healthz", "/livez", "/readyz"]);

export const answerHealth = (
  request: Request,
  path: string,
): Response | undefined => {
  if (request.method !== "GET" || !PROBES.has(path)) return undefined;
  return json({ status: "ok" }, 200, {
    [product.versionHeader]: product.version,
  });
};
