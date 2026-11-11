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
import { call, signInAs } from "#product/web-client.ts";

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
      "jobs_unavailable",
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

const SUBMIT_INPUT = {
  input: {
    policyId: "policy-2",
    sections: [{ content: "Work use only.", key: "purpose", title: "Purpose" }],
    versionId: "version-3",
  },
};

const SECTION = { content: "Work use only.", key: "purpose", title: "Purpose" };

const OTHER_SUBMITS: Record<string, unknown> = {
  SubmitDraftGeneration: {
    brief: "x",
    sections: [{ key: "purpose", order: 0, title: "Purpose" }],
  },
  SubmitPolicyRevision: {
    instruction: "x",
    policyId: "policy-2",
    sections: [{ ...SECTION, order: 0 }],
    versionId: "version-3",
  },
};

const submit = () => call(base, bob, "SubmitPolicyReview", SUBMIT_INPUT);

describe("jobs_unavailable, ai without a Kubernetes API", () => {
  it("submits refuse as the gateway's generic fault, aiHealth names the reason", async () => {
    await control(base, {
      kind: "ai-provider",
      providerReason: "jobs_unavailable",
    });
    assert.deepEqual(await health(), {
      available: false,
      providerReason: "jobs_unavailable",
      reason: "provider_unavailable",
    });
    assert.equal((await submit()).refused, "INTERNAL");
  });

  it("submits work again once it clears", async () => {
    await control(base, {
      kind: "ai-provider",
      providerReason: "jobs_unavailable",
    });
    await control(base, { kind: "ai-provider", providerReason: null });
    const answer = await submit();
    assert.equal(answer.refused, undefined);
    assert.match(
      (answer.data.submitPolicyReview as { jobId: string }).jobId,
      /^ai-job-\d+$/,
    );
  });

  it("leaves the other provider outages' submits alone", async () => {
    await control(base, { kind: "ai-provider", providerReason: "auth_failed" });
    assert.equal((await submit()).refused, undefined);
  });
});

describe("limit_reached, the monthly or daily AI limit", () => {
  it("aiHealth is unavailable with the reason and no providerReason", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    assert.deepEqual(await health(), {
      available: false,
      providerReason: null,
      reason: "limit_reached",
    });
  });

  it("every submit refuses with FailedPrecondition", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    assert.equal((await submit()).refused, "FailedPrecondition");
    for (const [name, input] of Object.entries(OTHER_SUBMITS)) {
      const answer = await call(base, bob, name, { input });
      assert.equal(answer.refused, "FailedPrecondition", name);
    }
    // steward-web has no operation for the standalone enrichment submit, so it goes raw
    const { body } = await query(
      base,
      `mutation($input: SubmitEnrichmentSuggestionsInput!) { submitEnrichmentSuggestions(input: $input) { jobId } }`,
      bob,
      { input: { policyId: "policy-2", sections: [SECTION] } },
    );
    assert.equal(body.errors?.[0]?.extensions.code, "FailedPrecondition");
  });

  it("checks the category scope first, as the submits do", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    const erin = await signInAs(base, "user-erin");
    const answer = await call(base, erin, "SubmitDraftGeneration", {
      input: {
        brief: "x",
        categoryId: "category-1",
        sections: [{ key: "purpose", order: 0, title: "Purpose" }],
      },
    });
    assert.equal(answer.refused, "PermissionDenied");
  });

  it("clears: aiHealth is available and submits work", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    await control(base, { kind: "ai-limit", reached: false });
    assert.deepEqual(await health(), {
      available: true,
      providerReason: null,
      reason: null,
    });
    assert.equal((await submit()).refused, undefined);
  });

  it("yields to a provider outage, which is the more basic failure", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    await control(base, { kind: "ai-provider", providerReason: "auth_failed" });
    assert.deepEqual(await health(), {
      available: false,
      providerReason: "auth_failed",
      reason: "provider_unavailable",
    });
  });

  it("yields to the ai service being unreachable", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    await control(base, { kind: "ai-simulation", on: false });
    assert.equal((await health()).reason, "ai_service_unavailable");
  });

  it("is a start-fresh reset", async () => {
    await control(base, { kind: "ai-limit", reached: true });
    startFresh();
    bob = await signInAs(base, "user-bob");
    assert.equal((await health()).available, true);
  });
});

describe("aiConfig and aiRetrievalConfig with the simulation on (#167)", () => {
  const CONFIG = `{ aiConfig { enabled provider model baseUrl region deployment credentialSet credentialLast4 topK dataNotice { currentVersion acceptedVersion acceptedBy acceptedAt } } aiRetrievalConfig { topK } }`;

  it("a site admin gets a schema-valid default config", async () => {
    const alice = await signInAs(base, "user-alice");
    const { body } = await query(base, CONFIG, alice);
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const config = body.data?.aiConfig as Record<string, unknown>;
    assert.equal(config.provider, null);
    assert.equal(config.credentialSet, false);
    assert.equal(config.credentialLast4, "");
    assert.equal(typeof config.enabled, "boolean");
    assert.equal(typeof config.topK, "number");
    const notice = config.dataNotice as Record<string, unknown>;
    assert.notEqual(notice.currentVersion, "");
    assert.equal(notice.acceptedVersion, "");
    assert.equal(
      (body.data?.aiRetrievalConfig as { topK: number }).topK,
      config.topK,
    );
  });

  it("a non-admin keeps the permission refusal", async () => {
    const { body } = await query(base, CONFIG, bob);
    assert.equal(body.errors?.[0]?.extensions.code, "PermissionDenied");
  });

  it("with the simulation off it still answers INTERNAL", async () => {
    const alice = await signInAs(base, "user-alice");
    await control(base, { kind: "ai-simulation", on: false });
    const { body } = await query(base, CONFIG, alice);
    assert.equal(body.errors?.[0]?.extensions.code, "INTERNAL");
  });
});
