// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// First-run setup under /setup: a new install has nobody to sign in as, so the clients ask
// whether setup is needed and create the first admin. The controls page's "Start as a new
// install" turns it back on.

import { issueSession } from "#core/auth.ts";
import { json, newId, readJson, refuse } from "#core/http.ts";
import { mockState, type Person } from "#core/state.ts";

interface SetupBody {
  email: string;
  name: string;
  password: string;
  username: string;
}

const complete = async (request: Request) => {
  if (!mockState.needsSetup) return refuse(409, "setup_done");
  const { email, name, password, username } =
    await readJson<SetupBody>(request);
  if (!name?.trim() || !username?.trim() || !email?.trim() || !password) {
    return refuse(400, "invalid_request");
  }
  const admin: Person = {
    email: email.trim().toLowerCase(),
    id: newId("person"),
    name: name.trim(),
    password,
    roles: ["ADMIN", "STAFF"],
    secondFactor: false,
    username: username.trim().toLowerCase(),
  };
  mockState.data.people.push(admin);
  mockState.needsSetup = false;
  return issueSession(admin);
};

export const answerSetup = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  if (path === "/setup/state" && request.method === "GET") {
    return json({ needsSetup: mockState.needsSetup });
  }
  if (path === "/setup/complete" && request.method === "POST")
    return complete(request);
  if (path.startsWith("/setup/")) return refuse(404, "not_found");
  return undefined;
};
