// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// First-run setup under /setup: a new install has nobody to sign in as, so the clients ask
// whether setup is needed and create the first admin. The controls page's "Start as a new
// install" turns it back on.

import { json, newId, readJson, refuse } from "#core/http.ts";
import { mockState, type Person } from "#core/state.ts";

/**
 * The token the gateway's first-run setup asks for (SETUP_TOKEN there). The mock's comes from
 * MOCK_SETUP_TOKEN, and the controls page shows it.
 */
export const SETUP_TOKEN = process.env.MOCK_SETUP_TOKEN || "mock-setup-token";

interface SetupBody {
  email: string;
  name: string;
  password: string;
  setupToken: string;
  username: string;
}

/**
 * POST /setup/bootstrap, as steward-gateway's internal/setup answers it: the setup token, then
 * the first site admin. It signs nobody in; the new admin signs in like anyone else.
 */
const bootstrap = async (request: Request) => {
  const { email, name, password, setupToken, username } =
    await readJson<SetupBody>(request);
  if (setupToken !== SETUP_TOKEN) return refuse(403, "invalid setup token");
  if (!mockState.needsSetup) return refuse(409, "already set up");
  if (!username?.trim() || !email?.trim() || !password) {
    return refuse(400, "username, email, and password are required");
  }
  const admin: Person = {
    email: email.trim().toLowerCase(),
    id: newId("user"),
    name: name?.trim() || username.trim(),
    roles: ["site-admin"],
    secondFactor: false,
    username: username.trim().toLowerCase(),
  };
  mockState.data.people.push(admin);
  mockState.needsSetup = false;
  return json({ userId: admin.id });
};

export const answerSetup = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  if (path === "/setup/state" && request.method === "GET") {
    return json({ needsSetup: mockState.needsSetup });
  }
  if (path === "/setup/bootstrap" && request.method === "POST")
    return bootstrap(request);
  if (path.startsWith("/setup/")) return refuse(404, "not_found");
  return undefined;
};
