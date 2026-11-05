// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Each audit entry carries the subject its service writes, so auditLog(subject: ...) answers what a
// live stack answers (#35). steward-core files a policy's creation and a discarded draft under
// policy:<id> and its draft saves, publishes and status changes under policy_version:<id>
// (internal/grpcsvc/policy_handler.go); steward-workflow files every run event under
// policy_version:<id> (internal/grpcsvc/workflow.go); steward-identity files a break-glass grant
// under the grantee's user:<id> (internal/store/breakglass.go, internal/audit/audit.go); and
// steward-obligations files an acknowledgement under acknowledgment:<id>
// (internal/ack/platform_audit.go).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { query, startForTests, startFresh } from "#product/test-client.ts";
import { type Answer, call, signInAs } from "#product/web-client.ts";

const SUBMIT = `mutation SubmitWorkflow(
  $policyVersionId: ID!
  $policyId: ID!
  $categoryId: ID!
  $ancestorCategoryIds: [ID!]!
) {
  submitWorkflow(
    policyVersionId: $policyVersionId
    policyId: $policyId
    categoryId: $categoryId
    ancestorCategoryIds: $ancestorCategoryIds
  ) {
    runId
  }
}`;

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

const ok = (answer: Answer) => {
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data;
};

const LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [{ text: "Book travel through the portal.", type: "text" }],
        type: "paragraph",
      },
    ],
    type: "root",
  },
});

/** The subjects auditLog shows for one action, newest first. */
const subjectsOf = async (admin: Signed, action: string) => {
  const page = ok(await call(base, admin, "AuditLog", { pageSize: 500 }))
    .auditLog as { records: { action: string; subject: string }[] };
  return page.records.filter((r) => r.action === action).map((r) => r.subject);
};

const draftOf = async (signed: Signed, policyId: string) => {
  const policy = ok(await call(base, signed, "Policy", { id: policyId }))
    .policy as { currentDraftVersionId: null | string };
  assert.ok(policy.currentDraftVersionId);
  return policy.currentDraftVersionId;
};

describe("audit subjects", () => {
  it("files a new policy under the policy and its first draft under the version", async () => {
    const author = await signInAs(base, "user-bob");
    const admin = await signInAs(base, "user-alice");
    const created = ok(
      await call(base, author, "CreatePolicy", {
        documentType: "POLICY",
        homeCategoryId: "category-reimbursement",
        sensitivity: "STANDARD",
        title: "Travel Booking",
      }),
    ).createPolicy as { currentDraftVersionId: string; id: string };

    assert.equal(
      (await subjectsOf(admin, "policy.created"))[0],
      `policy:${created.id}`,
    );
    assert.equal(
      (await subjectsOf(admin, "policy.draft_saved"))[0],
      `policy_version:${created.currentDraftVersionId}`,
    );
  });

  it("files a submission, the decision and the publish under the version", async () => {
    const author = await signInAs(base, "user-bob");
    const approver = await signInAs(base, "user-charlie");
    const admin = await signInAs(base, "user-alice");
    ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: "policy-1",
      }),
    );
    const draftId = await draftOf(author, "policy-1");
    const { body } = await query(base, SUBMIT, author, {
      ancestorCategoryIds: [],
      categoryId: "category-reimbursement",
      policyId: "policy-1",
      policyVersionId: draftId,
    });
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    const task = (
      ok(await call(base, approver, "PendingTasks")).pendingTasks as {
        policyVersionId: string;
        runId: string;
        taskId: string;
      }[]
    ).find((t) => t.policyVersionId === draftId);
    assert.ok(task);
    ok(
      await call(base, approver, "SignalWorkflow", {
        ...task,
        comment: "Reviewed.",
        signal: "SIGNAL_TYPE_APPROVE",
      }),
    );

    const version = `policy_version:${draftId}`;
    for (const action of [
      "policy.draft_saved",
      "workflow.submitted",
      "workflow.decision.approved",
      // The run's last approval reaches steward-core as a version status change.
      "policy.status_set",
    ]) {
      assert.equal((await subjectsOf(admin, action))[0], version, action);
    }
  });

  it("files a direct publish under the version", async () => {
    const author = await signInAs(base, "user-bob");
    const admin = await signInAs(base, "user-alice");
    ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: "policy-1",
      }),
    );
    const draftId = await draftOf(author, "policy-1");
    ok(await call(base, author, "PublishDraft", { policyId: "policy-1" }));

    assert.equal(
      (await subjectsOf(admin, "policy.published"))[0],
      `policy_version:${draftId}`,
    );
  });

  it("files a discarded draft under the policy", async () => {
    const author = await signInAs(base, "user-bob");
    const admin = await signInAs(base, "user-alice");
    ok(
      await call(base, author, "SaveDraft", {
        contentJson: LEXICAL,
        policyId: "policy-1",
      }),
    );
    ok(await call(base, author, "DiscardDraft", { policyId: "policy-1" }));

    assert.deepEqual(await subjectsOf(admin, "policy.draft_discarded"), [
      "policy:policy-1",
    ]);
  });

  it("files a break-glass grant under the person it was granted to", async () => {
    const admin = await signInAs(base, "user-alice");
    ok(
      await call(base, admin, "BreakGlassReveal", {
        policyId: "policy-2",
        reason: "Incident review.",
      }),
    );

    assert.deepEqual(await subjectsOf(admin, "policy.break_glass_revealed"), [
      "user:user-alice",
    ]);
  });

  it("files an acknowledgement under the acknowledgement", async () => {
    const reader = await signInAs(base, "user-erin");
    const admin = await signInAs(base, "user-alice");
    ok(await call(base, reader, "RecordAck", { policyVersionId: "version-7" }));

    // steward-web's RecordAck doesn't ask for the acknowledgement's id, so match its shape.
    const subjects = await subjectsOf(admin, "ack.recorded");
    assert.equal(subjects.length, 1);
    assert.match(subjects[0] ?? "", /^acknowledgment:\S+$/);
  });
});
