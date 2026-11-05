// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// First-run onboarding, as steward-gateway's completeOnboarding and identity answer it: a person
// the controls mark as still owing it reads needsOnboarding on me, and completeOnboarding takes
// the accepted terms and the details they confirmed, then clears it.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  control,
  post,
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});

const USER = "userId username name firstName lastName email needsOnboarding";

const me = async (signed: Signed) =>
  (await query(base, `query { me { ${USER} } }`, signed)).body.data
    ?.me as Record<string, unknown>;

const complete = async (signed: Signed, variables: Record<string, unknown>) =>
  query(
    base,
    `mutation ($acceptTerms: Boolean!, $username: String, $firstName: String, $lastName: String, $email: String) {
      completeOnboarding(acceptTerms: $acceptTerms, username: $username, firstName: $firstName, lastName: $lastName, email: $email) { ${USER} }
    }`,
    signed,
    variables,
  );

const owe = (personId: string) =>
  control(base, { kind: "needs-onboarding", personId });

describe("needsOnboarding", () => {
  it("is false for the sample people", async () => {
    assert.equal(
      (await me(await signInAs(base, "user-erin"))).needsOnboarding,
      false,
    );
  });

  it("is true for someone the controls mark, until a reset", async () => {
    const erin = await signInAs(base, "user-erin");
    await owe("user-erin");
    assert.equal((await me(erin)).needsOnboarding, true);
    await control(base, { kind: "reset" });
    assert.equal((await me(erin)).needsOnboarding, false);
  });

  it("can be cleared from the controls, and refuses someone unknown", async () => {
    const erin = await signInAs(base, "user-erin");
    await owe("user-erin");
    await control(base, {
      kind: "needs-onboarding",
      needsOnboarding: false,
      personId: "user-erin",
    });
    assert.equal((await me(erin)).needsOnboarding, false);
    const answer = await post(base, "/_mock/controls", {
      kind: "needs-onboarding",
      personId: "user-nobody",
    });
    assert.equal(answer.status, 404);
  });
});

describe("completeOnboarding", () => {
  it("needs the terms accepted", async () => {
    const erin = await signInAs(base, "user-erin");
    await owe("user-erin");
    const { body } = await complete(erin, { acceptTerms: false });
    assert.equal(body.errors?.[0]?.extensions.code, "InvalidArgument");
    assert.equal((await me(erin)).needsOnboarding, true);
  });

  it("takes the confirmed details, derives the name, and clears it", async () => {
    const erin = await signInAs(base, "user-erin");
    await owe("user-erin");
    const { body } = await complete(erin, {
      acceptTerms: true,
      email: "erin.reader@example.org",
      firstName: " Erin ",
      lastName: "Reader-Smith",
      username: "erin.reader",
    });
    assert.deepEqual(body.data?.completeOnboarding, {
      email: "erin.reader@example.org",
      firstName: "Erin",
      lastName: "Reader-Smith",
      name: "Erin Reader-Smith",
      needsOnboarding: false,
      userId: "user-erin",
      username: "erin.reader",
    });
    assert.equal((await me(erin)).needsOnboarding, false);
    assert.equal(
      stewardData().audit.at(-1)?.action,
      "user.onboarding.completed",
    );
  });

  it("leaves what wasn't sent, and an empty email, as they were", async () => {
    const erin = await signInAs(base, "user-erin");
    const { body } = await complete(erin, { acceptTerms: true, email: "" });
    const user = body.data?.completeOnboarding as Record<string, unknown>;
    assert.equal(user.email, "erin@example.org");
    assert.equal(user.name, "Erin Reader");
    assert.equal(user.username, "erin");
  });

  it("refuses an empty or taken username", async () => {
    const erin = await signInAs(base, "user-erin");
    await owe("user-erin");
    let { body } = await complete(erin, { acceptTerms: true, username: " " });
    assert.equal(body.errors?.[0]?.extensions.code, "InvalidArgument");
    ({ body } = await complete(erin, { acceptTerms: true, username: "bob" }));
    assert.equal(body.errors?.[0]?.extensions.code, "AlreadyExists");
    assert.equal((await me(erin)).needsOnboarding, true);
  });

  it("needs someone signed in", async () => {
    const answer = await post(base, "/query", {
      query: "mutation { completeOnboarding(acceptTerms: true) { userId } }",
    });
    assert.equal(answer.status, 401);
  });
});
