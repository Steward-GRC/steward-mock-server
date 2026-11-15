// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// myAcknowledgments (steward-gateway#56): the signed-in person's own acknowledgements, named by
// their policy, newest first. limit missing, zero or negative is the default of 10, and at most
// 100 come back. Nobody sees another person's; nothing acknowledged is [].

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  post,
  query,
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

interface Recent {
  ackedAt: string;
  number: string;
  policyId: string;
  policyVersionId: string;
  title: string;
  versionNo: number;
}

const FIELDS = "policyId number title versionNo policyVersionId ackedAt";

const mine = async (user: string, limit?: null | number): Promise<Recent[]> => {
  const signed = await signInAs(base, `user-${user}`);
  const text =
    limit === undefined
      ? `{ myAcknowledgments { ${FIELDS} } }`
      : `query($limit: Int) { myAcknowledgments(limit: $limit) { ${FIELDS} } }`;
  const { body } = await query(base, text, signed, { limit });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as { myAcknowledgments: Recent[] }).myAcknowledgments;
};

/** Erin's two seeded acknowledgements, as the card names them. */
const DESK_BOOKING = {
  ackedAt: "2026-10-03T09:00:00Z",
  number: "POL-FACILITIES-000001",
  policyId: "policy-9",
  policyVersionId: "version-11",
  title: "Desk Booking Policy",
  versionNo: 1,
};

/** Give Erin `count` more acknowledgements, one hour apart, newest last. */
const piledUp = (count: number) => {
  const acks = stewardData().acknowledgements;
  for (let index = 0; index < count; index += 1) {
    acks.push({
      ackedAt: new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + index * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      policyVersionId: "version-12",
      userId: "user-erin",
    });
  }
};

describe("myAcknowledgments", () => {
  it("lists the caller's acknowledgements newest first, each named by its policy", async () => {
    const answer = await mine("erin");
    assert.equal(answer.length, 2);
    assert.deepEqual(answer[0], DESK_BOOKING);
    assert.equal(answer[1]?.policyVersionId, "version-5");
    assert.equal(answer[1]?.policyId, "policy-4");
    assert.equal(answer[1]?.versionNo, 1);
    assert.equal(answer[1]?.ackedAt, "2026-05-03T10:00:00Z");
  });

  it("puts a new acknowledgement first", async () => {
    stewardData().acknowledgements.push({
      ackedAt: "2026-11-01T08:00:00Z",
      policyVersionId: "version-12",
      userId: "user-erin",
    });
    const answer = await mine("erin");
    assert.deepEqual(
      answer.map((a) => a.policyVersionId),
      ["version-12", "version-11", "version-5"],
    );
  });

  it("answers only the signed-in person's, never another's", async () => {
    const bob = await mine("bob");
    assert.deepEqual(
      bob.map((a) => a.policyVersionId),
      ["version-2"],
    );
    assert.ok(!bob.some((a) => a.policyVersionId === "version-11"));
  });

  it("answers [] for someone who has acknowledged nothing", async () => {
    stewardData().acknowledgements = stewardData().acknowledgements.filter(
      (a) => a.userId !== "user-erin",
    );
    assert.deepEqual(await mine("erin"), []);
  });

  it("honours a limit", async () => {
    const answer = await mine("erin", 1);
    assert.deepEqual(answer, [DESK_BOOKING]);
  });

  it("answers the default 10 when limit is missing, null, zero or negative", async () => {
    piledUp(15);
    assert.equal((await mine("erin")).length, 10);
    assert.equal((await mine("erin", null)).length, 10);
    assert.equal((await mine("erin", 0)).length, 10);
    assert.equal((await mine("erin", -3)).length, 10);
  });

  it("caps limit at 100", async () => {
    piledUp(120);
    assert.equal((await mine("erin", 100)).length, 100);
    assert.equal((await mine("erin", 5000)).length, 100);
    assert.equal((await mine("erin", 101)).length, 100);
  });

  it("orders a long list newest first", async () => {
    piledUp(12);
    const stamps = (await mine("erin", 12)).map((a) => a.ackedAt);
    assert.deepEqual(stamps, stamps.toSorted().toReversed());
  });

  it("needs someone signed in", async () => {
    const answer = await post(base, "/query", {
      query: "query { myAcknowledgments { policyId } }",
    });
    assert.equal(answer.status, 401);
  });
});
