// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Moving several documents at once (steward-web's bug log #87; proposed in steward-gateway#82 and
// steward-core#35): a dry run that says what each would get, then an all-or-nothing move.

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

const PREVIEW = `query ($policyIds: [ID!]!, $homeCategoryId: ID!) {
  previewMovePolicies(policyIds: $policyIds, homeCategoryId: $homeCategoryId) {
    items { policyId title number newNumber refusal }
  }
}`;
const MOVE = `mutation ($policyIds: [ID!]!, $homeCategoryId: ID!) {
  movePolicies(policyIds: $policyIds, homeCategoryId: $homeCategoryId) {
    moved { policyId title number newNumber refusal }
  }
}`;

const inExpenses = () =>
  stewardData().policies.filter(
    (p) => p.homeCategoryId === "category-expenses",
  );

describe("previewMovePolicies", () => {
  it("says what each document would get and changes nothing", async () => {
    const ids = inExpenses().map((p) => p.id);
    const before = inExpenses().map((p) => p.number);
    const answer = await ask(await alice(), PREVIEW, {
      homeCategoryId: "category-finance",
      policyIds: ids,
    });
    const items = (
      answer.data.previewMovePolicies as {
        items: {
          newNumber: null | string;
          number: string;
          refusal: null | string;
        }[];
      }
    ).items;
    assert.equal(items.length, ids.length);
    for (const item of items) {
      assert.match(item.newNumber ?? "", /^POL-FINANCE-\d{6}$/);
      assert.equal(item.refusal, null);
    }
    assert.deepEqual(
      inExpenses().map((p) => p.number),
      before,
    );
  });

  it("gives a refusal, not a number, to a document the target does not hold", async () => {
    const answer = await ask(await alice(), PREVIEW, {
      homeCategoryId: "category-conduct",
      policyIds: inExpenses().map((p) => p.id),
    });
    const [first] = (
      answer.data.previewMovePolicies as {
        items: { newNumber: null | string; refusal: null | string }[];
      }
    ).items;
    assert.equal(first?.newNumber, null);
    assert.match(first?.refusal ?? "", /CATEGORY_REFUSES_TYPE/);
  });
});

describe("movePolicies", () => {
  it("moves them all, renumbering in the target's sequence, with an audit entry each and one for the batch", async () => {
    const ids = inExpenses().map((p) => p.id);
    const auditBefore = stewardData().audit.length;
    const answer = await ask(await alice(), MOVE, {
      homeCategoryId: "category-finance",
      policyIds: ids,
    });
    const moved = (
      answer.data.movePolicies as { moved: { newNumber: string }[] }
    ).moved;
    assert.equal(moved.length, ids.length);
    assert.deepEqual(new Set(moved.map((m) => m.newNumber)).size, ids.length);
    assert.equal(inExpenses().length, 0);
    const written = stewardData()
      .audit.slice(auditBefore)
      .map((entry) => entry.action);
    assert.equal(
      written.filter((a) => a === "policy.moved").length,
      ids.length,
    );
    assert.equal(written.at(-1), "policy.bulk_moved");
  });

  it("refuses the whole batch when one document would be refused, and moves nothing", async () => {
    const ids = inExpenses().map((p) => p.id);
    const answer = await ask(await alice(), MOVE, {
      homeCategoryId: "category-conduct",
      policyIds: ids,
    });
    assert.equal(answer.code, "FailedPrecondition");
    assert.match(answer.message ?? "", /CATEGORY_REFUSES_TYPE/);
    assert.equal(inExpenses().length, ids.length);
  });

  it("refuses an empty batch and an unknown target", async () => {
    const asAlice = await alice();
    const empty = await ask(asAlice, MOVE, {
      homeCategoryId: "category-finance",
      policyIds: [],
    });
    assert.equal(empty.code, "InvalidArgument");
    const unknown = await ask(asAlice, MOVE, {
      homeCategoryId: "nowhere",
      policyIds: inExpenses().map((p) => p.id),
    });
    assert.equal(unknown.code, "NotFound");
  });

  it("is for a site admin only", async () => {
    const bob = await signInAs(base, "user-bob");
    const answer = await ask(bob, MOVE, {
      homeCategoryId: "category-finance",
      policyIds: inExpenses().map((p) => p.id),
    });
    assert.equal(answer.code, "PermissionDenied");
  });
});
