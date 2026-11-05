// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// searchPolicies, ahead of steward-gateway (schema-pending.graphql), through /query as the sample
// people: published text matches, the reader's read rules hold, an obfuscated viewer matches on
// title and number only, drafts and retired policies never match, and the hits page.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { EXPENSE_CLAIMS_NUMBER } from "#product/data/policies.ts";
import {
  query,
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

const SEARCH = `query SearchPolicies(
  $query: String!
  $documentType: DocumentType
  $first: Int
  $after: String
) {
  searchPolicies(
    query: $query
    documentType: $documentType
    first: $first
    after: $after
  ) {
    hits {
      policy {
        id
        number
        title
        viewerCan {
          contentObfuscated
        }
      }
      rank
      snippet {
        text
        matches {
          start
          length
        }
      }
    }
    nextPageToken
  }
}`;

interface Hit {
  policy: {
    id: string;
    number: string;
    title: string;
    viewerCan: { contentObfuscated: boolean };
  };
  rank: number;
  snippet: null | Snippet;
}

interface Page {
  hits: Hit[];
  nextPageToken: string;
}

interface Snippet {
  matches: { length: number; start: number }[];
  text: string;
}

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

const search = async (
  signed: Signed,
  variables: Record<string, unknown>,
): Promise<Page> => {
  const { body } = await query(base, SEARCH, signed, variables);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data?.searchPolicies as Page;
};

const titles = (page: Page) => page.hits.map((hit) => hit.policy.title);

/** The words the snippet marks as matches. */
const marked = (hit: Hit) =>
  (hit.snippet?.matches ?? []).map(({ length, start }) =>
    hit.snippet?.text.slice(start, start + length),
  );

const paragraph = (text: string) =>
  JSON.stringify({
    root: {
      children: [{ children: [{ text, type: "text" }], type: "paragraph" }],
      type: "root",
    },
  });

/** A new policy, published by the author with one paragraph of text. */
const publish = async (author: Signed, title: string, text: string) => {
  const created = (
    await call(base, author, "CreatePolicy", {
      documentType: "POLICY",
      homeCategoryId: "category-expenses",
      sensitivity: "STANDARD",
      title,
    })
  ).data.createPolicy as { id: string };
  await call(base, author, "SaveDraft", {
    contentJson: paragraph(text),
    policyId: created.id,
  });
  await call(base, author, "PublishDraft", { policyId: created.id });
  return created.id;
};

describe("searchPolicies", () => {
  it("finds a policy by a word only in its published text, with a marked snippet", async () => {
    const reader = await signIn(base, "erin");
    const page = await search(reader, { query: "INCURRED" });
    assert.deepEqual(titles(page), ["Expense Claims Policy"]);
    const [hit] = page.hits;
    assert.ok(hit);
    assert.equal(hit.policy.number, EXPENSE_CLAIMS_NUMBER);
    assert.ok(hit.rank > 0);
    assert.doesNotMatch(hit.snippet?.text ?? "", /<|>/);
    assert.deepEqual(marked(hit), ["incurred"]);
    assert.equal(page.nextPageToken, "");
  });

  it("finds a policy by its title and number, with no snippet when the text doesn't match", async () => {
    const reader = await signIn(base, "erin");
    const byTitle = await search(reader, { query: "procedure" });
    assert.deepEqual(titles(byTitle), ["Lost Device Procedure"]);
    assert.equal(byTitle.hits[0]?.snippet, null);
    const byNumber = await search(reader, { query: EXPENSE_CLAIMS_NUMBER });
    assert.deepEqual(titles(byNumber), ["Expense Claims Policy"]);
  });

  it("leaves out a policy the reader can't read", async () => {
    const reader = await signIn(base, "erin");
    assert.deepEqual(titles(await search(reader, { query: "archive" })), []);
    assert.deepEqual(
      titles(await search(reader, { query: "administrator" })),
      [],
    );
    const author = await signIn(base, "bob");
    assert.deepEqual(titles(await search(author, { query: "administrator" })), [
      "Archive Access Policy",
    ]);
  });

  it("matches an obfuscated viewer on title and number only, with no snippet", async () => {
    const admin = await signIn(base, "alice");
    const byTitle = await search(admin, { query: "archive" });
    assert.deepEqual(titles(byTitle), ["Archive Access Policy"]);
    assert.equal(byTitle.hits[0]?.policy.viewerCan.contentObfuscated, true);
    assert.equal(byTitle.hits[0]?.snippet, null);
    assert.deepEqual(
      titles(await search(admin, { query: "POL-RECORDS-000002" })),
      ["Archive Access Policy"],
    );
    assert.deepEqual(
      titles(await search(admin, { query: "administrator" })),
      [],
    );
    assert.deepEqual(
      titles(await search(admin, { query: "archive quarter" })),
      [],
    );
  });

  it("never matches a draft, a superseded version or a retired policy", async () => {
    const author = await signIn(base, "bob");
    assert.deepEqual(titles(await search(author, { query: "restricted" })), []);
    assert.deepEqual(titles(await search(author, { query: "dollars" })), []);
    assert.deepEqual(titles(await search(author, { query: "carry" })), []);
    assert.deepEqual(titles(await search(author, { query: "annual" })), []);

    const web = await signInAs(base, "user-bob");
    await call(base, web, "SaveDraft", {
      contentJson: paragraph("Zeppelin travel is never reimbursed."),
      policyId: "policy-1",
    });
    assert.deepEqual(titles(await search(author, { query: "zeppelin" })), []);
  });

  it("ranks title hits above text hits, then more matches first", async () => {
    const web = await signInAs(base, "user-bob");
    await publish(web, "Travel Booking", "Claims go through the portal.");
    await publish(web, "Hotel Stays", "Claims and more claims, as claims go.");
    const reader = await signIn(base, "erin");
    const page = await search(reader, { query: "claims" });
    assert.deepEqual(titles(page), [
      "Expense Claims Policy",
      "Hotel Stays",
      "Travel Booking",
    ]);
    const ranks = page.hits.map((hit) => hit.rank);
    assert.deepEqual(
      ranks,
      ranks.toSorted((a, b) => b - a),
    );
    assert.deepEqual(marked(page.hits[1] as Hit), [
      "Claims",
      "claims",
      "claims",
    ]);
  });

  it("cuts a long passage to a window around the match, offsets still on the word", async () => {
    const web = await signInAs(base, "user-bob");
    const filler = "Staff book travel early and keep every receipt. ".repeat(8);
    await publish(
      web,
      "Long Travel",
      `${filler}Ferries need approval. ${filler}`,
    );
    const reader = await signIn(base, "erin");
    const [hit] = (await search(reader, { query: "ferries" })).hits;
    assert.ok(hit?.snippet);
    assert.ok(hit.snippet.text.length <= 170, hit.snippet.text);
    assert.match(hit.snippet.text, /^….*…$/);
    assert.deepEqual(marked(hit), ["Ferries"]);
  });

  it("filters by document type", async () => {
    const reader = await signIn(base, "erin");
    assert.deepEqual(
      titles(await search(reader, { documentType: "POLICY", query: "the" })),
      [
        "Expense Claims Policy",
        "Desk Booking Policy",
        "Visitor Sign-in Policy",
      ],
    );
    assert.deepEqual(
      titles(await search(reader, { documentType: "PROCEDURE", query: "the" })),
      ["Lost Device Procedure"],
    );
  });

  it("pages with first and after", async () => {
    const web = await signInAs(base, "user-bob");
    for (const title of ["Portal One", "Portal Two", "Portal Three"])
      await publish(web, title, "Book through the portal.");
    const reader = await signIn(base, "erin");
    const all = titles(await search(reader, { query: "portal" }));
    assert.equal(all.length, 3);

    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 3; pages++) {
      const page = await search(reader, { after, first: 2, query: "portal" });
      seen.push(...titles(page));
      if (page.nextPageToken === "") break;
      after = page.nextPageToken;
    }
    assert.deepEqual(seen, all);
    const first = await search(reader, { first: 2, query: "portal" });
    assert.equal(first.hits.length, 2);
    assert.notEqual(first.nextPageToken, "");
  });

  it("refuses a page token it didn't hand out", async () => {
    const reader = await signIn(base, "erin");
    const { body } = await query(base, SEARCH, reader, {
      after: "not-a-token",
      query: "claims",
    });
    assert.equal(body.errors?.[0]?.extensions.code, "InvalidArgument");
  });
});
