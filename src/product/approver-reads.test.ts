// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// An approver can always read the version they are asked to approve, even a draft they can't edit.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { startForTests, startFresh } from "#product/test-client.ts";
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

describe("an approver reading the version under review", () => {
  it("reads the draft of a run they hold a seat on, and sees its id on the policy", async () => {
    // run-1 is Travel Booking's version-4 in review; Charlie holds a seat, and can't edit it.
    const charlie = await signInAs(base, "user-charlie");
    const version = await call(base, charlie, "PolicyVersion", {
      id: "version-4",
    });
    assert.equal(version.refused, undefined);
    const policy = await call(base, charlie, "PolicyByNumber", {
      number: "PRC-TRAVEL-000003",
    });
    assert.equal(
      (policy.data.policyByNumber as { currentDraftVersionId: null | string })
        .currentDraftVersionId,
      "version-4",
    );
  });

  it("still hides that draft from a reader with no seat", async () => {
    const erin = await signInAs(base, "user-erin");
    const version = await call(base, erin, "PolicyVersion", {
      id: "version-4",
    });
    assert.equal(version.refused, "NotFound");
  });
});
