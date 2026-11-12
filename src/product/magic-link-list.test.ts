// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-delivery's ListMagicLinks and RemoveMagicLink as the gateway relays them (steward-gateway#71):
// the registry of issued links for site admins, newest first with paging, and removing a link that
// is revoked or expired.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { fingerprint } from "#product/delivery.ts";
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

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string; field?: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    field: error?.extensions.field,
    message: error?.message,
  };
};

const alice = () => signInAs(base, "user-alice");
const erin = () => signInAs(base, "user-erin");

const MAGIC = `mutation ($id: ID!, $sensitive: Boolean!) {
  createMagicLink(policyVersionId: $id, sensitive: $sensitive) { token }
}`;
const REVOKE = `mutation ($token: String!) { revokeMagicLink(token: $token) }`;
const REMOVE = `mutation ($token: String!) { removeMagicLink(token: $token) }`;
const LIST = `query ($ids: [ID!], $size: Int, $page: String) {
  magicLinks(policyVersionIds: $ids, pageSize: $size, pageToken: $page) {
    nextPageToken
    links {
      token fingerprint policyVersionId createdByUserId sensitive status
      createdAt expiresAt revokedAt revokedByUserId
    }
  }
}`;

interface Page {
  links: Row[];
  nextPageToken: null | string;
}
interface Row {
  createdAt: string;
  createdByUserId: string;
  expiresAt: string;
  fingerprint: string;
  policyVersionId: string;
  revokedAt: null | string;
  revokedByUserId: null | string;
  sensitive: boolean;
  status: string;
  token: string;
}

const list = async (variables: Record<string, unknown> = {}) =>
  (await ask(await alice(), LIST, variables)).data.magicLinks as Page;

/** Issues a link as the reader and backdates it, so the order and the age are known. */
const issue = async (
  versionId: string,
  ageMinutes: number,
  sensitive = false,
) => {
  const { token } = (
    await ask(await erin(), MAGIC, { id: "version-11", sensitive })
  ).data.createMagicLink as { token: string };
  const link = stewardData().magicLinks[token];
  assert.ok(link);
  link.policyVersionId = versionId;
  link.createdAt = Date.now() - ageMinutes * 60_000;
  return token;
};

describe("magicLinks", () => {
  it("lists the issued links newest first, with every field", async () => {
    const oldest = await issue("version-11", 30);
    const newest = await issue("version-11", 10, true);
    const middle = await issue("version-11", 20);
    const page = await list();
    assert.deepEqual(
      page.links.map((l) => l.token),
      [newest, middle, oldest],
    );
    assert.equal(page.nextPageToken, null);
    const first = page.links[0];
    assert.equal(first?.fingerprint, fingerprint(newest));
    assert.equal(first?.policyVersionId, "version-11");
    assert.equal(first?.createdByUserId, "user-erin");
    assert.equal(first?.sensitive, true);
    assert.equal(first?.status, "active");
    assert.match(first?.createdAt ?? "", /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(first?.expiresAt ?? "", /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal(first?.revokedAt, null);
    assert.equal(first?.revokedByUserId, null);
  });

  it("pages by pageSize and token, defaulting to 50", async () => {
    const tokens: string[] = [];
    for (let index = 0; index < 5; index++)
      tokens.push(await issue("version-11", 50 - index));
    const newestFirst = tokens.toReversed();
    const one = await list({ size: 2 });
    assert.deepEqual(
      one.links.map((l) => l.token),
      newestFirst.slice(0, 2),
    );
    assert.ok(one.nextPageToken);
    const two = await list({ page: one.nextPageToken, size: 2 });
    assert.deepEqual(
      two.links.map((l) => l.token),
      newestFirst.slice(2, 4),
    );
    const three = await list({ page: two.nextPageToken, size: 2 });
    assert.deepEqual(
      three.links.map((l) => l.token),
      newestFirst.slice(4),
    );
    assert.equal(three.nextPageToken, null);
    assert.equal((await list()).links.length, 5);
  });

  it("filters by policy version ids", async () => {
    const a = await issue("version-11", 10);
    await issue("version-4", 20);
    const only = await list({ ids: ["version-11"] });
    assert.deepEqual(
      only.links.map((l) => l.token),
      [a],
    );
    assert.equal(
      (await list({ ids: ["version-4", "version-11"] })).links.length,
      2,
    );
    assert.equal((await list({ ids: ["version-none"] })).links.length, 0);
  });

  it("reports active, revoked and expired, revoked winning over expired", async () => {
    const live = await issue("version-11", 10);
    const revoked = await issue("version-11", 20);
    const expired = await issue("version-11", 30);
    const both = await issue("version-11", 40);
    await ask(await alice(), REVOKE, { token: revoked });
    await ask(await alice(), REVOKE, { token: both });
    const links = stewardData().magicLinks;
    const past = Date.now() - 60_000;
    const expiredLink = links[expired];
    const bothLink = links[both];
    assert.ok(expiredLink && bothLink);
    expiredLink.expiresAt = past;
    bothLink.expiresAt = past;
    const byToken = new Map(
      (await list()).links.map((l) => [l.token, l] as const),
    );
    assert.equal(byToken.get(live)?.status, "active");
    assert.equal(byToken.get(revoked)?.status, "revoked");
    assert.equal(byToken.get(expired)?.status, "expired");
    assert.equal(byToken.get(both)?.status, "revoked");
    const row = byToken.get(revoked);
    assert.match(row?.revokedAt ?? "", /Z$/);
    assert.equal(row?.revokedByUserId, "user-alice");
  });

  it("refuses a non-admin", async () => {
    assert.equal((await ask(await erin(), LIST)).code, "PermissionDenied");
  });

  it("refuses a page token it did not issue, naming the field", async () => {
    await issue("version-11", 10);
    for (const page of ["nope", "-1", "1.5"]) {
      const refused = await ask(await alice(), LIST, { page });
      assert.equal(refused.code, "INVALID_REQUEST", page);
      assert.equal(refused.field, "page_token", page);
    }
  });

  it("refuses a page size outside 1 to 200", async () => {
    for (const size of [0, 201]) {
      const refused = await ask(await alice(), LIST, { size });
      assert.equal(refused.code, "INVALID_REQUEST", String(size));
      assert.equal(refused.field, "page_size", String(size));
    }
    assert.equal(
      (await ask(await alice(), LIST, { size: 200 })).code,
      undefined,
    );
  });
});

describe("removeMagicLink", () => {
  it("removes a revoked link", async () => {
    const token = await issue("version-11", 10);
    await ask(await alice(), REVOKE, { token });
    assert.deepEqual((await ask(await alice(), REMOVE, { token })).data, {
      removeMagicLink: true,
    });
    assert.equal((await list()).links.length, 0);
  });

  it("removes an expired link", async () => {
    const token = await issue("version-11", 10);
    const link = stewardData().magicLinks[token];
    assert.ok(link);
    link.expiresAt = Date.now() - 1000;
    assert.equal(
      (await ask(await alice(), REMOVE, { token })).data.removeMagicLink,
      true,
    );
    assert.equal((await list()).links.length, 0);
  });

  it("refuses an active link with MAGIC_LINK_ACTIVE and keeps it", async () => {
    const token = await issue("version-11", 10);
    const refused = await ask(await alice(), REMOVE, { token });
    assert.equal(refused.code, "MAGIC_LINK_ACTIVE");
    assert.equal((await list()).links.length, 1);
  });

  it("answers MAGIC_LINK_NOT_FOUND for an unknown token, and INVALID_REQUEST for an empty one", async () => {
    assert.equal(
      (await ask(await alice(), REMOVE, { token: "f".repeat(64) })).code,
      "MAGIC_LINK_NOT_FOUND",
    );
    const empty = await ask(await alice(), REMOVE, { token: "" });
    assert.equal(empty.code, "INVALID_REQUEST");
    assert.equal(empty.message, "token is required.");
  });

  it("refuses a non-admin", async () => {
    assert.equal(
      (await ask(await erin(), REMOVE, { token: "x" })).code,
      "PermissionDenied",
    );
  });
});
