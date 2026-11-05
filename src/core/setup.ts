/*
MIT License

Copyright (c) 2026 Shane

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/
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
