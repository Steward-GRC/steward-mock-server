// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The people typeahead (gateway searchUsers, behind steward-web's subject search): it matches a
// person's name, email and username, ignoring case, needs two characters, caps its answer, and
// never offers a deleted account. The match mirrors identity's user search.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { data, people } from "#product/resolvers/shared.ts";
import {
  query,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";

const SEARCH = `query SearchUsers($query: String!, $limit: Int) {
  searchUsers(query: $query, limit: $limit) { id name email }
}`;

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

const search = async (text: string, limit?: number) => {
  const { body } = await query(base, SEARCH, await signIn(base, "bob"), {
    limit,
    query: text,
  });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (
    body.data as {
      searchUsers: { email: string; id: string; name: string }[];
    }
  ).searchUsers;
};
const ids = async (text: string, limit?: number) =>
  (await search(text, limit)).map((u) => u.id);

describe("searchUsers", () => {
  it("finds a person by name, not only by email", async () => {
    // "approver" is in Charlie's name and nowhere in his email or username.
    assert.deepEqual(await ids("approver"), ["user-charlie"]);
    assert.deepEqual(await ids("bob author"), ["user-bob"]);
  });

  it("finds a person by first or last name alone", async () => {
    assert.deepEqual(await ids("Heidi"), ["user-heidi"]);
    assert.deepEqual(await ids("Manager"), ["user-heidi"]);
  });

  it("finds a person by part of a name or email", async () => {
    assert.deepEqual(await ids("lic"), ["user-alice"]);
    assert.deepEqual(await ids("dave@exam"), ["user-dave"]);
  });

  it("ignores case in the query and in the name", async () => {
    assert.deepEqual(await ids("APPROVER"), ["user-charlie"]);
    assert.deepEqual(await ids("cHaRlIe aPP"), ["user-charlie"]);
  });

  it("answers an empty list when nothing matches", async () => {
    assert.deepEqual(await search("zzz-nobody"), []);
  });

  it("asks for two characters and sends nothing for fewer", async () => {
    assert.deepEqual(await search("a"), []);
    assert.deepEqual(await search("  "), []);
    assert.deepEqual(await search(" a "), []);
    assert.notEqual((await search("al")).length, 0);
  });

  it("caps the answer at the limit and at 20 without one", async () => {
    assert.equal((await search("example", 3)).length, 3);
    assert.ok((await search("example")).length <= 20);
  });

  it("puts names that start with the words before names that only contain them", async () => {
    const base = people()[0]!;
    data().people.push(
      {
        ...base,
        email: "zed@example.org",
        id: "user-zed",
        name: "Zed Quillon",
        username: "zed",
      },
      {
        ...base,
        email: "quill@example.org",
        id: "user-quill",
        name: "Quillon Zed",
        username: "qz",
      },
    );
    const found = await ids("quill");
    assert.deepEqual(found, ["user-quill", "user-zed"]);
  });

  it("still offers a disabled person and never a deleted one", async () => {
    assert.deepEqual(await ids("Disabled"), ["user-frank"]);
    people().find((p) => p.id === "user-grace")!.deletedAt =
      "2026-01-01T00:00:00Z";
    assert.deepEqual(await ids("Templates"), []);
  });
});
