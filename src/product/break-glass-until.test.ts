// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// PolicyViewerCan.breakGlassUntil, as steward-gateway reports it (steward-gateway#185): when the
// caller's own active break-glass grant on a policy ends, so the reader can say "Revealed for you
// until ..." after a reload. Null when there is no active grant on that policy for that person.

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
import { call, signInAs } from "#product/web-client.ts";

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

const SENSITIVE = "POL-RECORDS-000002";
const SENSITIVE_ID = "policy-8";

const untilOf = async (signed: Signed, number = SENSITIVE) => {
  const { body } = await query(
    base,
    `query ($number: String!) { policyByNumber(number: $number) { viewerCan { breakGlassUntil canBreakGlass } } }`,
    signed,
    { number },
  );
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  const row = (
    body.data as {
      policyByNumber: {
        viewerCan: { breakGlassUntil: null | string };
      };
    }
  ).policyByNumber;
  return row.viewerCan.breakGlassUntil;
};

describe("viewerCan.breakGlassUntil", () => {
  it("is null before the site admin breaks glass", async () => {
    const admin = await signInAs(base, "user-alice");
    assert.equal(await untilOf(admin), null);
  });

  it("is the instant the active grant ends, after a reveal", async () => {
    const admin = await signInAs(base, "user-alice");
    const reveal = await call(base, admin, "BreakGlassReveal", {
      policyId: SENSITIVE_ID,
      reason: "Incident review",
    });
    const granted = (reveal.data.breakGlassReveal as { grantedUntil: string })
      .grantedUntil;
    assert.equal(await untilOf(admin), granted);
    assert.ok(Date.parse(granted) > Date.now());
  });

  it("is null once the grant has ended", async () => {
    const admin = await signInAs(base, "user-alice");
    await call(base, admin, "BreakGlassReveal", {
      policyId: SENSITIVE_ID,
      reason: "Incident review",
    });
    for (const grant of stewardData().breakGlass) grant.until = Date.now() - 1;
    assert.equal(await untilOf(admin), null);
  });

  it("reports the latest end when the policy was revealed more than once", async () => {
    const admin = await signInAs(base, "user-alice");
    await call(base, admin, "BreakGlassReveal", {
      policyId: SENSITIVE_ID,
      reason: "First look",
    });
    const second = Date.now() + 20 * 60 * 1000;
    stewardData().breakGlass.push({
      policyNumber: SENSITIVE,
      until: second,
      userId: "user-alice",
    });
    stewardData().breakGlass.push({
      policyNumber: SENSITIVE,
      until: Date.now() + 60 * 1000,
      userId: "user-alice",
    });
    assert.equal(await untilOf(admin), new Date(second).toISOString());
  });

  it("is null for a grant on a different policy", async () => {
    const admin = await signInAs(base, "user-alice");
    stewardData().breakGlass.push({
      policyNumber: "POL-OTHER-000009",
      until: Date.now() + 60 * 1000,
      userId: "user-alice",
    });
    assert.equal(await untilOf(admin), null);
  });

  it("never reports another person's grant", async () => {
    const admin = await signInAs(base, "user-alice");
    stewardData().breakGlass.push({
      policyNumber: SENSITIVE,
      until: Date.now() + 60 * 1000,
      userId: "user-someone-else",
    });
    assert.equal(await untilOf(admin), null);
  });

  it("is null for a non-admin even with a stale grant on file", async () => {
    const author = await signInAs(base, "user-bob");
    stewardData().breakGlass.push({
      policyNumber: SENSITIVE,
      until: Date.now() + 60 * 1000,
      userId: "user-bob",
    });
    assert.equal(await untilOf(author), null);
  });
});
