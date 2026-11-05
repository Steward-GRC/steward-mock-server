// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What each sample person may see and do, as steward-gateway decides it, driven through
// steward-web's own operations: one state for every client, the read model per role, the
// refusals, settings that come back, and AI answering as the gateway does while it's down.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { EXPENSE_CLAIMS_NUMBER } from "#product/data/policies.ts";
import { query, startForTests, startFresh } from "#product/test-client.ts";
import { call, documentOf, signInAs } from "#product/web-client.ts";

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

const as = (personId: string) => signInAs(base, personId);

type Row = {
  currentDraftVersionId: null | string;
  number: string;
  title: string;
  viewerCan: Record<string, boolean>;
} & Record<string, unknown>;

const titles = (rows: unknown) =>
  (rows as Row[]).map((row) => row.title).toSorted();

describe("one state for every client", () => {
  it("shows a template the admin deleted as gone to the author", async () => {
    const admin = await as("user-alice");
    const author = await as("user-bob");
    const before = await call(base, author, "Templates");
    assert.ok(titles(before.data.templates).length > 0);
    assert.ok(
      (before.data.templates as { id: string }[]).some(
        (t) => t.id === "template-3",
      ),
    );
    const deleted = await call(base, admin, "DeleteTemplate", {
      id: "template-3",
    });
    assert.equal(deleted.refused, undefined);
    const afterwards = await call(base, author, "Templates");
    assert.ok(
      !(afterwards.data.templates as { id: string }[]).some(
        (t) => t.id === "template-3",
      ),
    );
  });
});

describe("the policy read model", () => {
  it("lets a reader see published, non-sensitive policies only", async () => {
    const reader = await as("user-erin");
    const usage = await call(base, reader, "Policies", {
      categoryId: "category-usage",
    });
    // Privileged Access is published but SENSITIVE; Acceptable Use is a sensitive draft.
    assert.deepEqual(titles(usage.data.policies), []);
    const finance = await call(base, reader, "Policies", {
      categoryId: "category-reimbursement",
    });
    assert.deepEqual(titles(finance.data.policies), ["Expense Claims"]);
    const row = (finance.data.policies as Row[])[0];
    assert.equal(row?.viewerCan.edit, false);
    assert.equal(row?.viewerCan.read, true);
    const sensitive = await call(base, reader, "PolicyByNumber", {
      number: "POL-USAGE-000002",
    });
    assert.equal(sensitive.refused, "NotFound");
  });

  it("hides a draft from everyone who can't edit it", async () => {
    const reader = await as("user-erin");
    const governance = await call(base, reader, "Policies", {
      categoryId: "category-due-diligence",
    });
    assert.deepEqual(titles(governance.data.policies), []);
    const draft = await call(base, reader, "PolicyVersion", {
      id: "version-6",
    });
    assert.equal(draft.refused, "NotFound");
  });

  it("shows the author their drafts, sensitive ones included", async () => {
    const author = await as("user-bob");
    const usage = await call(base, author, "Policies", {
      categoryId: "category-usage",
    });
    assert.deepEqual(titles(usage.data.policies), [
      "Acceptable Use",
      "Privileged Access",
    ]);
    const draft = (usage.data.policies as Row[]).find(
      (p) => p.title === "Acceptable Use",
    );
    assert.equal(draft?.currentDraftVersionId, "version-3");
    assert.equal(draft?.viewerCan.edit, true);
  });

  it("obfuscates a sensitive policy for a site admin until they break glass", async () => {
    const admin = await as("user-alice");
    const policy = await call(base, admin, "PolicyByNumber", {
      number: "POL-USAGE-000002",
    });
    const row = policy.data.policyByNumber as Row;
    assert.equal(row.viewerCan.contentObfuscated, true);
    assert.equal(row.viewerCan.canBreakGlass, true);
    const hidden = await call(base, admin, "PolicyVersion", {
      id: "version-9",
    });
    const content = (hidden.data.policyVersion as { contentJson: string })
      .contentJson;
    assert.ok(!content.includes("administrator"));
    const glass = await call(base, admin, "BreakGlassReveal", {
      policyId: "policy-8",
      reason: "Incident review",
    });
    assert.equal(glass.refused, undefined);
    const shown = await call(base, admin, "PolicyVersion", { id: "version-9" });
    assert.ok(
      (
        shown.data.policyVersion as { contentJson: string }
      ).contentJson.includes("Administrator access"),
    );
  });

  it("answers the reader's detail for a published policy", async () => {
    const reader = await as("user-erin");
    const found = await call(base, reader, "PolicyByNumber", {
      number: EXPENSE_CLAIMS_NUMBER,
    });
    const row = found.data.policyByNumber as Row;
    assert.equal(row.currentVersionStatus, "PUBLISHED");
    assert.equal(row.currentVersionNo, 2);
    assert.equal(row.viewerCan.ack, true);
    const versions = await call(base, reader, "PolicyVersions", {
      policyId: "policy-1",
    });
    assert.deepEqual(
      (versions.data.policyVersions as { versionNo: number }[]).map(
        (v) => v.versionNo,
      ),
      [1, 2],
    );
  });
});

describe("refusals", () => {
  const refusals: [string, string, Record<string, unknown>][] = [
    ["user-erin", "Users", {}],
    ["user-erin", "Organizations", {}],
    [
      "user-bob",
      "SetGlobalSettings",
      {
        input: {
          announcement: { enabled: false, level: "info", message: "" },
          maintenance: { enabled: false, message: "" },
        },
      },
    ],
    [
      "user-erin",
      "CreatePolicy",
      {
        homeCategoryId: "category-reimbursement",
        sensitivity: "STANDARD",
        title: "Not mine to write",
      },
    ],
    ["user-erin", "SaveDraft", { contentJson: "{}", policyId: "policy-2" }],
    ["user-charlie", "CreateCategory", { name: "Legal", slug: "legal" }],
    ["user-bob", "CreateTemplate", { name: "Mine" }],
    ["user-bob", "AckRoster", { policyVersionId: "version-2" }],
    ["user-erin", "AuditLog", {}],
    // A site admin isn't a privacy officer: the case queue is the officers' alone.
    ["user-alice", "ReportCases", {}],
    ["user-bob", "BreakGlassReveal", { policyId: "policy-8", reason: "x" }],
  ];
  for (const [personId, operation, variables] of refusals)
    it(`refuses ${operation} to ${personId}`, async () => {
      const answer = await call(base, await as(personId), operation, variables);
      assert.equal(answer.refused, "PermissionDenied");
    });

  it("signs a disabled account out at once", async () => {
    const admin = await as("user-alice");
    const reader = await as("user-erin");
    await call(base, admin, "DisableUser", { userId: "user-erin" });
    const { status } = await query(base, documentOf("Me"), reader);
    assert.equal(status, 401);
  });
});

describe("settings", () => {
  it("serves what setGlobalSettings saved", async () => {
    const admin = await as("user-alice");
    const input = {
      announcement: { enabled: true, level: "warning", message: "Audit week." },
      maintenance: { enabled: true, message: "Back at noon." },
    };
    const saved = await call(base, admin, "SetGlobalSettings", { input });
    assert.deepEqual(saved.data.setGlobalSettings, input);
    const reader = await as("user-erin");
    const read = await call(base, reader, "GlobalSettings");
    assert.deepEqual(read.data.globalSettings, input);
  });
});

describe("Steward AI", () => {
  it("reports itself unavailable", async () => {
    const answer = await call(base, await as("user-erin"), "AiHealth");
    assert.deepEqual(answer.data.aiHealth, {
      available: false,
      reason: "ai_service_unavailable",
    });
  });

  it("answers a job as the gateway does when the ai service is down", async () => {
    const author = await as("user-bob");
    const answer = await call(base, author, "SubmitDraftGeneration", {
      input: {
        brief: "Travel booking.",
        sections: [{ key: "purpose", order: 0, title: "Purpose" }],
      },
    });
    assert.equal(answer.refused, "INTERNAL");
  });
});
