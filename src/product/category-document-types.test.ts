// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What a category holds (steward-web's bug log #87; proposed in steward-gateway#80 and
// steward-core#34): both, policies only, procedures only, or none (a container). Creating a draft
// and moving a document respect it, and narrowing it is refused while documents would be stranded.

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

const alice = () => signInAs(base, "user-alice");

const SET = `mutation ($id: ID!, $documentTypes: CategoryDocumentTypes!) {
  setCategoryDocumentTypes(id: $id, documentTypes: $documentTypes) { id documentTypes }
}`;
const COUNTS = `query ($categoryId: ID!) {
  categoryDocumentCounts(categoryId: $categoryId) { policies procedures }
}`;
const CREATE = `mutation ($homeCategoryId: ID!, $documentType: DocumentType) {
  createPolicy(homeCategoryId: $homeCategoryId, documentType: $documentType, sensitivity: STANDARD, title: "A document") { id homeCategoryId documentType }
}`;
const MOVE = `mutation ($policyId: ID!, $homeCategoryId: ID!) {
  movePolicy(policyId: $policyId, homeCategoryId: $homeCategoryId) { id homeCategoryId }
}`;

describe("the seeded categories", () => {
  it("has one category of each kind and the rest holding both", async () => {
    const kinds = new Map(
      stewardData().categories.map((c) => [c.id, c.documentTypes]),
    );
    assert.equal(kinds.get("category-expenses"), "POLICIES");
    assert.equal(kinds.get("category-conduct"), "PROCEDURES");
    assert.equal(kinds.get("category-workplace"), "NONE");
    assert.equal(kinds.get("category-finance"), "BOTH");
  });

  it("reads through the gateway's category fields", async () => {
    const answer = await ask(
      await alice(),
      `{ category(id: "category-workplace") { documentTypes } }`,
    );
    assert.deepEqual(answer.data.category, { documentTypes: "NONE" });
  });

  it("holds no document its category would refuse", () => {
    const { categories, policies } = stewardData();
    const kinds = new Map(categories.map((c) => [c.id, c.documentTypes]));
    for (const policy of policies) {
      const kind = kinds.get(policy.homeCategoryId);
      const accepted =
        kind === "BOTH" ||
        (kind === "POLICIES" && policy.documentType === "POLICY") ||
        (kind === "PROCEDURES" && policy.documentType === "PROCEDURE");
      assert.ok(
        accepted,
        `${policy.id} sits in ${policy.homeCategoryId} (${String(kind)})`,
      );
    }
  });
});

describe("creating and moving respect a category's kind", () => {
  it("refuses a procedure in a policies-only category and a policy in a procedures-only one", async () => {
    const asAlice = await alice();
    const procedure = await ask(asAlice, CREATE, {
      documentType: "PROCEDURE",
      homeCategoryId: "category-expenses",
    });
    assert.equal(procedure.code, "FailedPrecondition");
    assert.match(procedure.message ?? "", /CATEGORY_REFUSES_TYPE/);
    const policy = await ask(asAlice, CREATE, {
      documentType: "POLICY",
      homeCategoryId: "category-conduct",
    });
    assert.match(policy.message ?? "", /CATEGORY_REFUSES_TYPE/);
  });

  it("refuses any document in a container and says to pick a child category", async () => {
    const answer = await ask(await alice(), CREATE, {
      documentType: "POLICY",
      homeCategoryId: "category-workplace",
    });
    assert.match(answer.message ?? "", /CATEGORY_REFUSES_TYPE/);
    assert.match(answer.message ?? "", /child category/);
  });

  it("accepts a document of the kind the category holds", async () => {
    const answer = await ask(await alice(), CREATE, {
      documentType: "POLICY",
      homeCategoryId: "category-expenses",
    });
    assert.equal(answer.code, undefined);
  });

  it("refuses to move a document into a category that does not hold its type", async () => {
    const { policies } = stewardData();
    const policy = policies.find((p) => p.documentType === "POLICY")!;
    const answer = await ask(await alice(), MOVE, {
      homeCategoryId: "category-conduct",
      policyId: policy.id,
    });
    assert.match(answer.message ?? "", /CATEGORY_REFUSES_TYPE/);
  });
});

describe("setCategoryDocumentTypes", () => {
  it("counts the policies and procedures a category holds", async () => {
    const answer = await ask(await alice(), COUNTS, {
      categoryId: "category-expenses",
    });
    const counts = answer.data.categoryDocumentCounts as {
      policies: number;
      procedures: number;
    };
    assert.ok(counts.policies > 0);
    assert.equal(counts.procedures, 0);
  });

  it("refuses to narrow while documents would be stranded, with the count", async () => {
    const asAlice = await alice();
    const counts = (
      await ask(asAlice, COUNTS, { categoryId: "category-expenses" })
    ).data.categoryDocumentCounts as { policies: number };
    const answer = await ask(asAlice, SET, {
      documentTypes: "PROCEDURES",
      id: "category-expenses",
    });
    assert.equal(answer.code, "FailedPrecondition");
    assert.match(answer.message ?? "", /CATEGORY_HOLDS_DOCUMENTS/);
    assert.match(
      answer.message ?? "",
      new RegExp(`\\(${String(counts.policies)}\\)`),
    );
    assert.equal(
      stewardData().categories.find((c) => c.id === "category-expenses")
        ?.documentTypes,
      "POLICIES",
    );
  });

  it("narrows an empty category and widens any category", async () => {
    const asAlice = await alice();
    const narrowed = await ask(asAlice, SET, {
      documentTypes: "NONE",
      id: "category-purchasing",
    });
    assert.deepEqual(narrowed.data.setCategoryDocumentTypes, {
      documentTypes: "NONE",
      id: "category-purchasing",
    });
    const widened = await ask(asAlice, SET, {
      documentTypes: "BOTH",
      id: "category-workplace",
    });
    assert.equal(
      (widened.data.setCategoryDocumentTypes as { documentTypes: string })
        .documentTypes,
      "BOTH",
    );
  });

  it("is for a site admin only", async () => {
    const bob = await signInAs(base, "user-bob");
    const answer = await ask(bob, SET, {
      documentTypes: "BOTH",
      id: "category-workplace",
    });
    assert.equal(answer.code, "PermissionDenied");
  });
});
