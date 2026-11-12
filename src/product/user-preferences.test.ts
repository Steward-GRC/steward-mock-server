// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A site admin sets another person's language, as steward-gateway's updateUserPreferences does
// (steward-gateway#183): the tag is validated like updateMyProfile's, an omitted locale stays as
// it was, a blank one clears it, and a malformed one is PROFILE_LOCALE_INVALID.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
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

const SET = `mutation ($userId: ID!, $locale: String) {
  updateUserPreferences(userId: $userId, locale: $locale) { userId locale name }
}`;
const WHO = `query { users(pageSize: 50) { users { userId locale } } }`;

const set = (signed: Signed, userId: string, locale?: null | string) =>
  query(
    base,
    SET,
    signed,
    locale === undefined ? { userId } : { locale, userId },
  );

const localeOf = async (signed: Signed, id: string) => {
  const { body } = await query(base, WHO, signed);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  const page = body.data as {
    users: { users: { locale: string; userId: string }[] };
  };
  return page.users.users.find((u) => u.userId === id)?.locale;
};

describe("updateUserPreferences", () => {
  it("sets another person's language, canonicalized", async () => {
    const admin = await signInAs(base, "user-alice");
    const { body } = await set(admin, "user-erin", " fr-ca ");
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const user = (body.data as { updateUserPreferences: { locale: string } })
      .updateUserPreferences;
    assert.equal(user.locale, "fr-CA");
    assert.equal(await localeOf(admin, "user-erin"), "fr-CA");
  });

  it("accepts a script and a region tag", async () => {
    const admin = await signInAs(base, "user-alice");
    await set(admin, "user-erin", "zh-hant-tw");
    assert.equal(await localeOf(admin, "user-erin"), "zh-Hant-TW");
    await set(admin, "user-erin", "es-419");
    assert.equal(await localeOf(admin, "user-erin"), "es-419");
  });

  it("leaves the language alone when the locale is omitted", async () => {
    const admin = await signInAs(base, "user-alice");
    await set(admin, "user-erin", "de");
    const { body } = await set(admin, "user-erin");
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    assert.equal(await localeOf(admin, "user-erin"), "de");
  });

  it("clears the language when the locale is blank", async () => {
    const admin = await signInAs(base, "user-alice");
    await set(admin, "user-erin", "de");
    const { body } = await set(admin, "user-erin", " ".repeat(3));
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    assert.equal(await localeOf(admin, "user-erin"), "");
  });

  it("refuses a malformed tag as PROFILE_LOCALE_INVALID and writes nothing", async () => {
    const admin = await signInAs(base, "user-alice");
    await set(admin, "user-erin", "de");
    const { body } = await set(admin, "user-erin", "not a tag!");
    const extensions = body.errors?.[0]?.extensions as Record<string, unknown>;
    assert.equal(extensions.code, "PROFILE_LOCALE_INVALID");
    assert.equal(extensions.codeNum, 1241);
    assert.equal(extensions.kind, "business");
    assert.equal(await localeOf(admin, "user-erin"), "de");
  });

  it("refuses a person who can't manage users", async () => {
    const author = await signInAs(base, "user-bob");
    const { body } = await set(author, "user-erin", "fr");
    assert.equal(body.errors?.[0]?.extensions.code, "PermissionDenied");
    const admin = await signInAs(base, "user-alice");
    assert.notEqual(await localeOf(admin, "user-erin"), "fr");
  });

  it("answers NotFound for a user it doesn't know", async () => {
    const admin = await signInAs(base, "user-alice");
    const { body } = await set(admin, "user-nobody", "fr");
    assert.equal(body.errors?.[0]?.extensions.code, "NotFound");
  });

  it("answers NotFound for a deleted user", async () => {
    const admin = await signInAs(base, "user-alice");
    const gone = await query(
      base,
      "mutation ($id: ID!) { deleteUser(userId: $id) { __typename } }",
      admin,
      { id: "user-frank" },
    );
    assert.equal(gone.body.errors, undefined, JSON.stringify(gone.body.errors));
    const { body } = await set(admin, "user-frank", "fr");
    assert.equal(body.errors?.[0]?.extensions.code, "NotFound");
  });
});
