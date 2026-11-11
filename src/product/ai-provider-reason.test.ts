// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// aiHealth.providerReason, as steward-gateway serves it (steward-gateway#110): when the ai service
// answers but its model provider fails, reason is provider_unavailable and providerReason is ai's own
// code (auth_failed, provider_error or not_configured). Every other state leaves it null. The
// `ai-provider` control switches the outage on and off; the field is not on the pinned gateway
// schema yet, so it is read here with a query of its own.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  control,
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let bob: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  bob = await signInAs(base, "user-bob");
});

const HEALTH = `{ aiHealth { available reason providerReason } }`;

const health = async () => {
  const { body } = await query(base, HEALTH, bob);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data?.aiHealth as {
    available: boolean;
    providerReason: null | string;
    reason: null | string;
  };
};

describe("aiHealth.providerReason", () => {
  it("is null while the ai service is healthy", async () => {
    assert.deepEqual(await health(), {
      available: true,
      providerReason: null,
      reason: null,
    });
  });

  it("carries ai's reason when the provider is failing", async () => {
    for (const providerReason of [
      "auth_failed",
      "provider_error",
      "not_configured",
    ]) {
      await control(base, { kind: "ai-provider", providerReason });
      assert.deepEqual(
        await health(),
        { available: false, providerReason, reason: "provider_unavailable" },
        providerReason,
      );
    }
  });

  it("is null, not empty, for an outage ai gave no reason for", async () => {
    await control(base, { kind: "ai-provider", providerReason: "" });
    assert.deepEqual(await health(), {
      available: false,
      providerReason: null,
      reason: "provider_unavailable",
    });
  });

  it("is null while the ai service is unreachable, whatever the provider", async () => {
    await control(base, { kind: "ai-provider", providerReason: "auth_failed" });
    await control(base, { kind: "ai-simulation", on: false });
    assert.deepEqual(await health(), {
      available: false,
      providerReason: null,
      reason: "ai_service_unavailable",
    });
  });

  it("is null again once the provider recovers", async () => {
    await control(base, { kind: "ai-provider", providerReason: "auth_failed" });
    await control(base, { kind: "ai-provider", providerReason: null });
    assert.deepEqual(await health(), {
      available: true,
      providerReason: null,
      reason: null,
    });
  });

  it("is refused as an unknown reason by the control", async () => {
    const answer = await control(base, {
      kind: "ai-provider",
      providerReason: "on_fire",
    });
    assert.equal(answer.error, "unknown_provider_reason");
    assert.equal((await health()).available, true);
  });
});
