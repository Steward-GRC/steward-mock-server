// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Siblings have a stored order (steward-core#39, steward-gateway#89): a new category and a moved
// one go last, reorderCategories sets the order of one parent's children from a list that holds
// every child exactly once, and categoryChildren and categoryTree list siblings in that order.

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

const as = (user: string) => signInAs(base, `user-${user}`);

const REORDER = `mutation ($parentId: ID, $orderedIds: [ID!]!) {
  reorderCategories(parentId: $parentId, orderedIds: $orderedIds) { id order parentId }
}`;
const CHILDREN = `query ($parentId: ID) {
  categoryChildren(parentId: $parentId) { id order }
}`;
const TREE = `query ($rootId: ID) {
  categoryTree(rootId: $rootId) { id order parentId }
}`;
const CREATE = `mutation ($name: String!, $slug: String!, $parentId: ID) {
  createCategory(name: $name, slug: $slug, parentId: $parentId) { id order }
}`;
const MOVE = `mutation ($categoryId: ID!, $newParentId: ID) {
  moveCategory(categoryId: $categoryId, newParentId: $newParentId) { id order parentId }
}`;
const DELETE = `mutation ($id: ID!) { deleteCategory(id: $id) }`;

interface Row {
  id: string;
  order: number;
  parentId?: null | string;
}

// The seed: Finance holds Expenses then Purchasing; People holds Leave then Conduct.
const FINANCE = "category-finance";
const EXPENSES = "category-expenses";
const PURCHASING = "category-purchasing";
const PEOPLE = "category-people";

const admin = () => as("alice");

const children = async (parentId: null | string) => {
  const answer = await ask(await admin(), CHILDREN, { parentId });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.categoryChildren as Row[];
};
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("the seed", () => {
  it("lists the roots in order, counting from zero", async () => {
    const roots = await children(null);
    assert.ok(roots.length > 1);
    assert.deepEqual(
      roots.map((r) => r.order),
      roots.map((_, index) => index),
    );
    assert.equal(roots[0]?.id, FINANCE);
  });

  it("counts each parent's children from zero on their own", async () => {
    assert.deepEqual(await children(FINANCE), [
      { id: EXPENSES, order: 0 },
      { id: PURCHASING, order: 1 },
    ]);
    assert.equal((await children(PEOPLE))[0]?.order, 0);
  });

  it("lists categoryTree depth first with each parent's children in order", async () => {
    const answer = await ask(await admin(), TREE);
    const tree = answer.data.categoryTree as Row[];
    const at = (id: string) => tree.findIndex((r) => r.id === id);
    assert.equal(tree[0]?.id, FINANCE);
    assert.equal(at(EXPENSES), at(FINANCE) + 1);
    assert.equal(at(PURCHASING), at(EXPENSES) + 1);
    assert.equal(at(PEOPLE), at(PURCHASING) + 1);
  });
});

describe("reorderCategories", () => {
  it("sets the order of one parent's children and returns them in it", async () => {
    const answer = await ask(await admin(), REORDER, {
      orderedIds: [PURCHASING, EXPENSES],
      parentId: FINANCE,
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(answer.data.reorderCategories, [
      { id: PURCHASING, order: 0, parentId: FINANCE },
      { id: EXPENSES, order: 1, parentId: FINANCE },
    ]);
    assert.deepEqual(await children(FINANCE), [
      { id: PURCHASING, order: 0 },
      { id: EXPENSES, order: 1 },
    ]);
  });

  it("reorders the top level when the parent is null", async () => {
    const before = ids(await children(null));
    const flipped = before.toReversed();
    const answer = await ask(await admin(), REORDER, {
      orderedIds: flipped,
      parentId: null,
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(ids(answer.data.reorderCategories as Row[]), flipped);
    assert.deepEqual(ids(await children(null)), flipped);
  });

  it("leaves the other parents alone", async () => {
    const people = await children(PEOPLE);
    await ask(await admin(), REORDER, {
      orderedIds: [PURCHASING, EXPENSES],
      parentId: FINANCE,
    });
    assert.deepEqual(await children(PEOPLE), people);
  });

  it("is followed by categoryTree, wherever the list started", async () => {
    await ask(await admin(), REORDER, {
      orderedIds: [PURCHASING, EXPENSES],
      parentId: FINANCE,
    });
    const whole = await ask(await admin(), TREE);
    const wholeIds = ids(whole.data.categoryTree as Row[]);
    assert.ok(wholeIds.indexOf(PURCHASING) < wholeIds.indexOf(EXPENSES));
    const part = await ask(await admin(), TREE, { rootId: FINANCE });
    assert.deepEqual(ids(part.data.categoryTree as Row[]), [
      FINANCE,
      PURCHASING,
      EXPENSES,
    ]);
  });

  it("accepts an empty list for a parent with no children", async () => {
    const answer = await ask(await admin(), REORDER, {
      orderedIds: [],
      parentId: EXPENSES,
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(answer.data.reorderCategories, []);
  });

  it("is for a site admin", async () => {
    const answer = await ask(await as("bob"), REORDER, {
      orderedIds: [PURCHASING, EXPENSES],
      parentId: FINANCE,
    });
    assert.equal(answer.code, "PermissionDenied");
    assert.deepEqual(ids(await children(FINANCE)), [EXPENSES, PURCHASING]);
  });
});

const refused = async (
  parentId: null | string,
  orderedIds: string[],
  code: string,
) => {
  const before = await children(FINANCE);
  const answer = await ask(await admin(), REORDER, { orderedIds, parentId });
  assert.equal(answer.code, code, answer.message);
  // nothing changes
  assert.deepEqual(await children(FINANCE), before);
};

describe("a reorder that does not list every child exactly once", () => {
  it("is refused when a child is missing", () =>
    refused(FINANCE, [EXPENSES], "InvalidArgument"));
  it("is refused when a child is listed twice", () =>
    refused(FINANCE, [EXPENSES, EXPENSES], "InvalidArgument"));
  it("is refused when the list names a category under another parent", () =>
    refused(FINANCE, [EXPENSES, PEOPLE], "InvalidArgument"));
  it("is refused when the list names a category that does not exist", () =>
    refused(FINANCE, [EXPENSES, "category-nope"], "InvalidArgument"));
  it("is refused when the list has a child too many", () =>
    refused(FINANCE, [EXPENSES, PURCHASING, PEOPLE], "InvalidArgument"));
  it("is refused when the list is empty but the parent has children", () =>
    refused(FINANCE, [], "InvalidArgument"));
  it("is refused with NotFound when the parent does not exist", () =>
    refused("category-nope", [EXPENSES], "NotFound"));
});

describe("a new category and a moved one", () => {
  it("puts a new category last among its siblings", async () => {
    const made = await ask(await admin(), CREATE, {
      name: "Audit",
      parentId: FINANCE,
      slug: "audit",
    });
    assert.equal(made.code, undefined, made.message);
    assert.equal((made.data.createCategory as Row).order, 2);
    const roots = await children(null);
    const root = await ask(await admin(), CREATE, {
      name: "Zeta",
      slug: "zeta",
    });
    assert.equal((root.data.createCategory as Row).order, roots.length);
  });

  it("starts the first child of a parent at zero", async () => {
    const made = await ask(await admin(), CREATE, {
      name: "Deep",
      parentId: EXPENSES,
      slug: "deep",
    });
    assert.equal((made.data.createCategory as Row).order, 0);
  });

  it("puts a moved category last under its new parent", async () => {
    const moved = await ask(await admin(), MOVE, {
      categoryId: "category-leave",
      newParentId: FINANCE,
    });
    assert.equal(moved.code, undefined, moved.message);
    assert.deepEqual(moved.data.moveCategory, {
      id: "category-leave",
      order: 2,
      parentId: FINANCE,
    });
    assert.deepEqual(ids(await children(FINANCE)), [
      EXPENSES,
      PURCHASING,
      "category-leave",
    ]);
  });

  it("puts a category promoted to the top level last among the roots", async () => {
    const roots = await children(null);
    const moved = await ask(await admin(), MOVE, {
      categoryId: EXPENSES,
      newParentId: null,
    });
    assert.equal((moved.data.moveCategory as Row).order, roots.length);
  });

  it("puts a category moved under the parent it already has last", async () => {
    const moved = await ask(await admin(), MOVE, {
      categoryId: EXPENSES,
      newParentId: FINANCE,
    });
    assert.equal(moved.code, undefined, moved.message);
    assert.deepEqual(await children(FINANCE), [
      { id: PURCHASING, order: 1 },
      { id: EXPENSES, order: 2 },
    ]);
  });

  it("leaves a gap behind and goes on from the highest order", async () => {
    const make = async (slug: string) => {
      const made = await ask(await admin(), CREATE, {
        name: slug,
        parentId: FINANCE,
        slug,
      });
      assert.equal(made.code, undefined, made.message);
      return made.data.createCategory as Row;
    };
    const first = await make("first");
    const second = await make("second");
    assert.deepEqual([first.order, second.order], [2, 3]);
    const gone = await ask(await admin(), DELETE, { id: first.id });
    assert.equal(gone.code, undefined, gone.message);
    // only the relative order counts, so the gap stays
    assert.deepEqual(await children(FINANCE), [
      { id: EXPENSES, order: 0 },
      { id: PURCHASING, order: 1 },
      { id: second.id, order: 3 },
    ]);
    assert.equal((await make("third")).order, 4);
  });
});
