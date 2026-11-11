// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What an approver sees of an edit made while the version is in review: the diff since the version
// they last reviewed. It moves when they act (comment, reply, vote, send comments) or press Mark as
// reviewed. The author gets no such view, and a person with no seat on the run is refused.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

interface Diff {
  changeType: string;
  sectionKey: string;
}

const VERSION = "version-4";
const RUN = { policyVersionId: VERSION, runId: "run-1" };
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

const as = async (
  user: string,
  operation: string,
  variables: Record<string, unknown>,
) => call(base, await signInAs(base, user), operation, variables);

const since = async (user: string): Promise<Diff[]> => {
  const answer = await as(user, "VersionChangesSinceReview", {
    policyVersionId: VERSION,
  });
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data.versionChangesSinceReview as Diff[];
};
// The gateway leaves unchanged sections out, so the list is already only the changes.
const changed = (diffs: Diff[]) => diffs;

const lexical = (...sections: [string, string][]) =>
  JSON.stringify({
    root: {
      children: sections.flatMap(([title, body]) => [
        {
          children: [{ text: title, type: "text" }],
          tag: "h2",
          type: "heading",
        },
        { children: [{ text: body, type: "text" }], type: "paragraph" },
      ]),
      type: "root",
    },
  });

/** The author edits the text in review. */
const authorEdits = async () => {
  const current = await as("user-bob", "SaveDraft", {
    contentJson: lexical(
      ["Steps", "Book through the portal 21 days ahead."],
      ["Afterwards", "Ask."],
    ),
    policyId: "policy-3",
  });
  assert.equal(current.refused, undefined, JSON.stringify(current));
};

describe("the changes since an approver last reviewed", () => {
  it("shows nothing before the author edits", async () => {
    assert.deepEqual(changed(await since("user-charlie")), []);
  });

  it("answers an empty list, never null, when nothing changed", async () => {
    const answer = await as("user-charlie", "VersionChangesSinceReview", {
      policyVersionId: VERSION,
    });
    assert.deepEqual(answer.data.versionChangesSinceReview, []);
  });

  it("leaves out the sections that did not change", async () => {
    await since("user-charlie");
    await authorEdits();
    const diffs = await since("user-charlie");
    assert.ok(diffs.length > 0);
    assert.ok(
      diffs.every((d) => d.changeType !== "unchanged"),
      JSON.stringify(diffs),
    );
  });

  it("shows each approver the edit the author made in review", async () => {
    assert.deepEqual(changed(await since("user-charlie")), []);
    assert.deepEqual(changed(await since("user-alice")), []);
    await authorEdits();
    assert.ok(changed(await since("user-charlie")).length > 0);
    assert.ok(changed(await since("user-alice")).length > 0);
  });

  it("moves for an approver who comments, and only for that approver", async () => {
    await since("user-charlie");
    await since("user-alice");
    await authorEdits();
    const thread = await as("user-charlie", "AddReviewThread", {
      body: "Noted.",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: "portal",
    });
    assert.equal(thread.refused, undefined, JSON.stringify(thread));
    assert.deepEqual(changed(await since("user-charlie")), []);
    assert.ok(changed(await since("user-alice")).length > 0);
  });

  it("moves when the approver votes, sends comments, or marks it reviewed", async () => {
    await since("user-charlie");
    await since("user-alice");
    await authorEdits();
    const sent = await as("user-charlie", "SignalWorkflow", {
      ...RUN,
      comment: "See my comments.",
      signal: "SIGNAL_TYPE_REQUEST_CHANGES",
      taskId: "task-1",
    });
    assert.equal(sent.refused, undefined, JSON.stringify(sent));
    assert.deepEqual(changed(await since("user-charlie")), []);
    const marked = await as("user-alice", "MarkVersionReviewed", {
      policyVersionId: VERSION,
    });
    assert.equal(marked.data.markVersionReviewed, true);
    assert.deepEqual(changed(await since("user-alice")), []);
  });

  it("shows a later edit again after the approver has moved on", async () => {
    await since("user-charlie");
    await authorEdits();
    await as("user-charlie", "MarkVersionReviewed", {
      policyVersionId: VERSION,
    });
    assert.deepEqual(changed(await since("user-charlie")), []);
    await as("user-bob", "SaveDraft", {
      contentJson: lexical(
        ["Steps", "Book through the portal 30 days ahead."],
        ["Afterwards", "Ask."],
      ),
      policyId: "policy-3",
    });
    assert.ok(changed(await since("user-charlie")).length > 0);
  });

  it("is refused with PermissionDenied for the author and for someone with no seat", async () => {
    for (const user of ["user-bob", "user-erin"]) {
      const answer = await as(user, "VersionChangesSinceReview", {
        policyVersionId: VERSION,
      });
      assert.equal(answer.refused, "PermissionDenied", user);
    }
  });

  it("refuses markVersionReviewed the same way", async () => {
    for (const user of ["user-bob", "user-erin"]) {
      const answer = await as(user, "MarkVersionReviewed", {
        policyVersionId: VERSION,
      });
      assert.equal(answer.refused, "PermissionDenied", user);
    }
  });
});

const status = async () =>
  (await as("user-bob", "WorkflowStatus", { policyVersionId: VERSION })).data
    .workflowStatus as {
    stageAssignees: { state: string; userId: string }[][];
    status: string;
  };

describe("sending comments", () => {
  it("changes no status and keeps the approver's seat open", async () => {
    const sent = await as("user-charlie", "SignalWorkflow", {
      ...RUN,
      comment: "See my comments.",
      signal: "SIGNAL_TYPE_REQUEST_CHANGES",
      taskId: "task-1",
    });
    assert.equal(sent.refused, undefined, JSON.stringify(sent));
    const now = await status();
    assert.equal(now.status, "APPROVAL_STATUS_IN_REVIEW");
    assert.equal(
      now.stageAssignees[0]?.find((s) => s.userId === "user-charlie")?.state,
      "pending",
    );
  });

  it("is refused for someone with no seat on the run", async () => {
    const sent = await as("user-erin", "SignalWorkflow", {
      ...RUN,
      comment: "x",
      signal: "SIGNAL_TYPE_REQUEST_CHANGES",
      taskId: "task-1",
    });
    assert.notEqual(sent.refused, undefined);
  });

  it("lets the approver approve afterwards", async () => {
    await as("user-charlie", "SignalWorkflow", {
      ...RUN,
      comment: "See my comments.",
      signal: "SIGNAL_TYPE_REQUEST_CHANGES",
      taskId: "task-1",
    });
    const approved = await as("user-charlie", "SignalWorkflow", {
      ...RUN,
      comment: "Fine now.",
      signal: "SIGNAL_TYPE_APPROVE",
      taskId: "task-1",
    });
    assert.equal(approved.refused, undefined, JSON.stringify(approved));
  });
});
