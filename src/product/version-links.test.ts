// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What a policy version links to from the libraries (bug log 227): definitions, related items,
// references and contacts. The library items are not versioned; the LINKS are stored with the
// policy version, can only change while that version is editable (a draft counts), are approved
// with it and carry over to a new draft. Definitions are unique by title and listed alphabetically,
// related items carry a relationship type with an inverse, and references and contacts keep the
// order the author gave them.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
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
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const as = async (user: string) => signInAs(base, `user-${user}`);

// POL-EXPENSES-000002: published version-2 with links; no open draft until bob saves one.
const POLICY = "policy-1";
const PUBLISHED = "version-2";
// policy-7 (PRC-CONDUCT-000001) was never published; policy-1 links to it.
const TARGET_POLICY = "policy-7";
const TARGET_VERSION = "version-8";

const SHOW = `fragment L on PolicyVersionLinks {
  policyVersionId editable
  definitions { id term }
  related { policyId number title type label direction }
  references { id label }
  contacts { id label }
}`;
const LINKS = `${SHOW} query ($id: ID!) { policyVersionLinks(policyVersionId: $id) { ...L } }`;
const SET_REFERENCES = `${SHOW} mutation ($id: ID!, $ids: [ID!]!) {
  setVersionReferences(policyVersionId: $id, referenceIds: $ids) { ...L }
}`;
const SET_CONTACTS = `${SHOW} mutation ($id: ID!, $ids: [ID!]!) {
  setVersionContacts(policyVersionId: $id, contactBlockIds: $ids) { ...L }
}`;
const SET_DEFINITIONS = `${SHOW} mutation ($id: ID!, $ids: [ID!]!) {
  setVersionDefinitions(policyVersionId: $id, definitionIds: $ids) { ...L }
}`;
const SET_RELATED = `${SHOW} mutation ($id: ID!, $links: [RelatedLinkInput!]!) {
  setVersionRelated(policyVersionId: $id, links: $links) { ...L }
}`;
const SAVE_DRAFT = `mutation ($policyId: ID!) {
  saveDraft(policyId: $policyId, contentJson: "{}") { id status }
}`;

interface Links {
  contacts: { id: string; label: string }[];
  definitions: { id: string; term: string }[];
  editable: boolean;
  policyVersionId: string;
  references: { id: string; label: string }[];
  related: {
    direction: string;
    label: string;
    number: string;
    policyId: string;
    title: string;
    type: string;
  }[];
}

const linksOf = async (user: string, id: string): Promise<Links> => {
  const answer = await ask(await as(user), LINKS, { id });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.policyVersionLinks as Links;
};

/** Bob saves a draft of the policy, which copies the published version's links. */
const newDraft = async (): Promise<string> => {
  const answer = await ask(await as("bob"), SAVE_DRAFT, { policyId: POLICY });
  assert.equal(answer.code, undefined, answer.message);
  return (answer.data.saveDraft as { id: string }).id;
};

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("the links belong to the policy version", () => {
  it("reads the seeded links of the published version", async () => {
    const links = await linksOf("bob", PUBLISHED);
    assert.deepEqual(ids(links.references), ["reference-1", "reference-4"]);
    assert.deepEqual(ids(links.contacts), [
      "contact-block-3",
      "contact-block-1",
    ]);
    assert.deepEqual(ids(links.definitions), ["definition-4"]);
    assert.deepEqual(
      links.related.map((r) => [r.policyId, r.type, r.direction]),
      [[TARGET_POLICY, "RELATED_TO", "OUTGOING"]],
    );
    assert.equal(links.editable, false);
  });

  it("lets a reader see the links of a published version", async () => {
    const links = await linksOf("erin", PUBLISHED);
    assert.deepEqual(ids(links.references), ["reference-1", "reference-4"]);
  });

  it("keeps a change in the draft out of the published version until it is published", async () => {
    const draft = await newDraft();
    const set = await ask(await as("bob"), SET_REFERENCES, {
      id: draft,
      ids: ["reference-2"],
    });
    assert.equal(set.code, undefined, set.message);
    assert.deepEqual(ids((await linksOf("bob", draft)).references), [
      "reference-2",
    ]);
    assert.deepEqual(ids((await linksOf("bob", PUBLISHED)).references), [
      "reference-1",
      "reference-4",
    ]);
    const publish = await ask(
      await as("bob"),
      `mutation ($policyId: ID!) { publishDraft(policyId: $policyId) { id } }`,
      { policyId: POLICY },
    );
    assert.equal(publish.code, undefined, publish.message);
    assert.deepEqual(ids((await linksOf("erin", draft)).references), [
      "reference-2",
    ]);
    // the version it replaced is left as it was approved
    assert.deepEqual(ids((await linksOf("bob", PUBLISHED)).references), [
      "reference-1",
      "reference-4",
    ]);
  });
});

describe("only while a version is editable", () => {
  it("refuses a published version and a superseded one", async () => {
    for (const id of [PUBLISHED, "version-10"]) {
      const answer = await ask(await as("bob"), SET_REFERENCES, {
        id,
        ids: [],
      });
      assert.equal(answer.code, "FailedPrecondition", id);
    }
  });

  it("accepts a draft, a version in review and a withdrawn one", async () => {
    const draft = await newDraft();
    const version = stewardData().versions.find((v) => v.id === draft)!;
    for (const status of ["DRAFT", "IN_REVIEW", "WITHDRAWN"]) {
      version.status = status;
      const answer = await ask(await as("bob"), SET_REFERENCES, {
        id: draft,
        ids: ["reference-3"],
      });
      assert.equal(answer.code, undefined, `${status}: ${answer.message}`);
      assert.equal(
        (answer.data.setVersionReferences as Links).editable,
        true,
        status,
      );
    }
  });

  it("refuses a rejected version, which is final", async () => {
    const answer = await ask(await as("alice"), SET_REFERENCES, {
      id: TARGET_VERSION,
      ids: [],
    });
    assert.equal(answer.code, "FailedPrecondition");
  });

  it("refuses someone who may not edit the policy", async () => {
    const draft = await newDraft();
    const answer = await ask(await as("erin"), SET_REFERENCES, {
      id: draft,
      ids: [],
    });
    assert.notEqual(answer.code, undefined);
    assert.deepEqual(ids((await linksOf("bob", draft)).references), [
      "reference-1",
      "reference-4",
    ]);
  });

  it("does not make a draft by itself: linking needs the draft to exist", async () => {
    const before = stewardData().versions.length;
    await ask(await as("bob"), SET_REFERENCES, { id: PUBLISHED, ids: [] });
    assert.equal(stewardData().versions.length, before);
  });
});

describe("carrying the links over to a new draft", () => {
  it("copies the published version's links", async () => {
    const draft = await newDraft();
    const links = await linksOf("bob", draft);
    assert.deepEqual(ids(links.references), ["reference-1", "reference-4"]);
    assert.deepEqual(ids(links.contacts), [
      "contact-block-3",
      "contact-block-1",
    ]);
    assert.deepEqual(ids(links.definitions), ["definition-4"]);
    assert.deepEqual(
      links.related.map((r) => [r.policyId, r.type]),
      [[TARGET_POLICY, "RELATED_TO"]],
    );
    assert.equal(links.editable, true);
  });

  it("copies from the rejected version when the next save follows a rejection", async () => {
    const draft = await newDraft();
    await ask(await as("bob"), SET_REFERENCES, {
      id: draft,
      ids: ["reference-3"],
    });
    stewardData().versions.find((v) => v.id === draft)!.status = "REJECTED";
    const next = await newDraft();
    assert.notEqual(next, draft);
    assert.deepEqual(ids((await linksOf("bob", next)).references), [
      "reference-3",
    ]);
  });

  it("copies rather than shares: changing the new draft leaves the old version alone", async () => {
    const draft = await newDraft();
    await ask(await as("bob"), SET_CONTACTS, { id: draft, ids: [] });
    assert.deepEqual(ids((await linksOf("bob", PUBLISHED)).contacts), [
      "contact-block-3",
      "contact-block-1",
    ]);
  });
});

describe("references and contacts keep the order the author gave", () => {
  it("returns them in the stored order, not the library's", async () => {
    const draft = await newDraft();
    const references = await ask(await as("bob"), SET_REFERENCES, {
      id: draft,
      ids: ["reference-4", "reference-2", "reference-1"],
    });
    assert.deepEqual(
      ids((references.data.setVersionReferences as Links).references),
      ["reference-4", "reference-2", "reference-1"],
    );
    await ask(await as("bob"), SET_CONTACTS, {
      id: draft,
      ids: ["contact-block-3", "contact-block-2", "contact-block-1"],
    });
    const links = await linksOf("erin", PUBLISHED);
    // the published version's own order, from the seed
    assert.deepEqual(ids(links.contacts), [
      "contact-block-3",
      "contact-block-1",
    ]);
    assert.deepEqual(ids((await linksOf("bob", draft)).contacts), [
      "contact-block-3",
      "contact-block-2",
      "contact-block-1",
    ]);
  });

  it("answers the older per-policy queries in that order too", async () => {
    const answer = await ask(
      await as("erin"),
      `query ($policyId: ID!) {
        policyReferences(policyId: $policyId) { id }
        policyContactBlocks(policyId: $policyId) { id }
      }`,
      { policyId: POLICY },
    );
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(ids(answer.data.policyReferences as { id: string }[]), [
      "reference-1",
      "reference-4",
    ]);
    assert.deepEqual(ids(answer.data.policyContactBlocks as { id: string }[]), [
      "contact-block-3",
      "contact-block-1",
    ]);
  });

  it("names each reference only once", async () => {
    const draft = await newDraft();
    const answer = await ask(await as("bob"), SET_REFERENCES, {
      id: draft,
      ids: ["reference-1", "reference-1"],
    });
    assert.equal(answer.code, "InvalidArgument");
  });

  it("refuses an item that is not in the library", async () => {
    const draft = await newDraft();
    const answer = await ask(await as("bob"), SET_REFERENCES, {
      id: draft,
      ids: ["reference-nope"],
    });
    assert.equal(answer.code, "NotFound");
  });
});

const input = (term: string) => ({
  categoryId: "category-information",
  definition: "A meaning.",
  term,
});

describe("definitions", () => {
  const CREATE = `mutation ($input: DefinitionEntryInput!) {
    createDefinition(input: $input) { id term }
  }`;
  const UPDATE = `mutation ($id: ID!, $input: DefinitionEntryInput!) {
    updateDefinition(id: $id, input: $input) { id term }
  }`;
  it("are unique by title, ignoring case and surrounding spaces", async () => {
    const alice = await as("alice");
    for (const term of ["RTO", "rto", "  Rto "]) {
      const answer = await ask(alice, CREATE, { input: input(term) });
      assert.equal(answer.code, "AlreadyExists", term);
    }
    const fresh = await ask(alice, CREATE, { input: input("MTTR") });
    assert.equal(fresh.code, undefined, fresh.message);
  });

  it("are unique across categories, as the title is the key", async () => {
    const answer = await ask(await as("alice"), CREATE, {
      input: { ...input("Business expense"), categoryId: "category-records" },
    });
    assert.equal(answer.code, "AlreadyExists");
  });

  it("refuse a rename onto another title and allow keeping their own", async () => {
    const alice = await as("alice");
    const clash = await ask(alice, UPDATE, {
      id: "definition-2",
      input: input("RTO"),
    });
    assert.equal(clash.code, "AlreadyExists");
    const same = await ask(alice, UPDATE, {
      id: "definition-2",
      input: { ...input("RPO"), definition: "Reworded." },
    });
    assert.equal(same.code, undefined, same.message);
  });

  it("refuse an empty title", async () => {
    const answer = await ask(await as("alice"), CREATE, { input: input("  ") });
    assert.equal(answer.code, "InvalidArgument");
  });

  it("are listed alphabetically, a new one taking its own place", async () => {
    const alice = await as("alice");
    await ask(alice, CREATE, { input: input("add") });
    await ask(alice, CREATE, { input: input("bob") });
    await ask(alice, CREATE, { input: input("a") });
    const answer = await ask(
      alice,
      `query { definitions(includeArchived: true) { term } }`,
    );
    const terms = (answer.data.definitions as { term: string }[]).map(
      (d) => d.term,
    );
    assert.deepEqual(
      terms,
      terms.toSorted((a, b) =>
        a.localeCompare(b, "en", { sensitivity: "base" }),
      ),
    );
    assert.ok(terms.indexOf("a") < terms.indexOf("add"));
    assert.ok(terms.indexOf("add") < terms.indexOf("bob"));
  });

  it("are listed alphabetically on a version, whatever order they were linked", async () => {
    const draft = await newDraft();
    const answer = await ask(await as("bob"), SET_DEFINITIONS, {
      id: draft,
      ids: ["definition-4", "definition-2", "definition-1"],
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(
      (answer.data.setVersionDefinitions as Links).definitions.map(
        (d) => d.term,
      ),
      ["Business expense", "RPO", "RTO"],
    );
    const older = await ask(
      await as("erin"),
      `query ($policyId: ID!) { policyDefinitionEntries(policyId: $policyId) { term } }`,
      { policyId: POLICY },
    );
    assert.deepEqual(
      (older.data.policyDefinitionEntries as { term: string }[]).map(
        (d) => d.term,
      ),
      ["Business expense"],
    );
  });
});

describe("related items and their relationship types", () => {
  it("offers a fixed list, each type with its inverse", async () => {
    const answer = await ask(
      await as("bob"),
      `query { relationshipTypes { id label inverseId inverseLabel } }`,
    );
    assert.equal(answer.code, undefined, answer.message);
    const types = answer.data.relationshipTypes as {
      id: string;
      inverseId: string;
      inverseLabel: string;
      label: string;
    }[];
    const byId = new Map(types.map((t) => [t.id, t]));
    const related = byId.get("RELATED_TO");
    assert.equal(related?.label, "is related to");
    assert.equal(related?.inverseId, "RELATED_BY");
    assert.equal(related?.inverseLabel, "is related by");
    for (const type of types) {
      const inverse = byId.get(type.inverseId);
      assert.ok(inverse, `${type.id} has an inverse`);
      assert.equal(inverse.inverseId, type.id, `${type.id} round trip`);
      assert.equal(inverse.label, type.inverseLabel);
    }
  });

  it("reads from both sides: the target shows the link under the inverse type", async () => {
    const links = await linksOf("alice", TARGET_VERSION);
    assert.deepEqual(
      links.related.map((r) => [r.policyId, r.type, r.label, r.direction]),
      [[POLICY, "RELATED_BY", "is related by", "INCOMING"]],
    );
  });

  it("stores the type chosen for each link", async () => {
    const draft = await newDraft();
    const answer = await ask(await as("bob"), SET_RELATED, {
      id: draft,
      links: [
        { policyId: TARGET_POLICY, type: "SUPERSEDES" },
        { policyId: "policy-2", type: "RELATED_TO" },
      ],
    });
    assert.equal(answer.code, undefined, answer.message);
    const links = (answer.data.setVersionRelated as Links).related;
    assert.deepEqual(
      links.map((r) => [r.policyId, r.type, r.label, r.direction]),
      [
        [TARGET_POLICY, "SUPERSEDES", "supersedes", "OUTGOING"],
        ["policy-2", "RELATED_TO", "is related to", "OUTGOING"],
      ],
    );
  });

  it("shows a link added in a draft on the other side only once that draft is published", async () => {
    const draft = await newDraft();
    await ask(await as("bob"), SET_RELATED, {
      id: draft,
      links: [{ policyId: TARGET_POLICY, type: "SUPERSEDES" }],
    });
    const before = await linksOf("alice", TARGET_VERSION);
    assert.deepEqual(
      before.related.map((r) => r.type),
      ["RELATED_BY"],
    );
    await ask(
      await as("bob"),
      `mutation ($policyId: ID!) { publishDraft(policyId: $policyId) { id } }`,
      { policyId: POLICY },
    );
    const after = await linksOf("alice", TARGET_VERSION);
    assert.deepEqual(
      after.related.map((r) => [r.type, r.label]),
      [["SUPERSEDED_BY", "is superseded by"]],
    );
  });

  it("refuses an unknown type, a link to itself and a repeated link", async () => {
    const draft = await newDraft();
    const bob = await as("bob");
    const unknown = await ask(bob, SET_RELATED, {
      id: draft,
      links: [{ policyId: TARGET_POLICY, type: "LOVES" }],
    });
    assert.equal(unknown.code, "InvalidArgument");
    const itself = await ask(bob, SET_RELATED, {
      id: draft,
      links: [{ policyId: POLICY, type: "RELATED_TO" }],
    });
    assert.equal(itself.code, "InvalidArgument");
    const twice = await ask(bob, SET_RELATED, {
      id: draft,
      links: [
        { policyId: TARGET_POLICY, type: "RELATED_TO" },
        { policyId: TARGET_POLICY, type: "RELATED_TO" },
      ],
    });
    assert.equal(twice.code, "InvalidArgument");
  });

  it("refuses a policy that does not exist", async () => {
    const draft = await newDraft();
    const answer = await ask(await as("bob"), SET_RELATED, {
      id: draft,
      links: [{ policyId: "policy-does-not-exist", type: "RELATED_TO" }],
    });
    assert.equal(answer.code, "NotFound");
  });

  it("keeps answering the older relatedPolicies query for the published version", async () => {
    const answer = await ask(
      await as("alice"),
      `query ($policyId: ID!) { relatedPolicies(policyId: $policyId) { policyId number title } }`,
      { policyId: POLICY },
    );
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(answer.data.relatedPolicies, [
      {
        number: "PRC-CONDUCT-000001",
        policyId: TARGET_POLICY,
        title: "Gifts and Hospitality Procedure",
      },
    ]);
  });
});

describe("the library stays unversioned", () => {
  it("shows an edit to a library item on every version that links it", async () => {
    const draft = await newDraft();
    await ask(
      await as("alice"),
      `mutation { updateReference(id: "reference-1", input: { label: "Renamed", kind: STANDARD }) { id } }`,
    );
    for (const id of [PUBLISHED, draft]) {
      const links = await linksOf("bob", id);
      assert.equal(
        links.references.find((r) => r.id === "reference-1")?.label,
        "Renamed",
        id,
      );
    }
  });

  it("counts a policy once however many of its versions link an item", async () => {
    await newDraft();
    const answer = await ask(
      await as("alice"),
      `query { references { id usedByCount } }`,
    );
    const used = (
      answer.data.references as { id: string; usedByCount: number }[]
    ).find((r) => r.id === "reference-1");
    assert.equal(used?.usedByCount, 1);
  });
});
