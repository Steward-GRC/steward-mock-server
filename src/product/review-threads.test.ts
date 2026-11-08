// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Inline review comments on a policy version: an approver starts a thread on text in the version
// under review, the drafter replies and resolves it, and a reader outside the review is refused.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

interface Thread {
  id: string;
  messages: { authorName: null | string; authorUserId: string; body: string }[];
  occurrence: number;
  quote: string;
  resolved: boolean;
}

const VERSION = "version-4";
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

const start = async (user = "user-charlie", body = "What is this?") => {
  const answer = await as(user, "AddReviewThread", {
    body,
    occurrence: 2,
    policyVersionId: VERSION,
    quote: "seven years",
  });
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data.addReviewThread as Thread;
};

describe("inline review threads", () => {
  it("lets an approver start a thread that anchors on a quote and which match of it", async () => {
    const thread = await start();
    assert.equal(thread.quote, "seven years");
    assert.equal(thread.occurrence, 2);
    assert.equal(thread.resolved, false);
    assert.equal(thread.messages[0]?.body, "What is this?");
    assert.equal(thread.messages[0]?.authorUserId, "user-charlie");
    assert.ok(thread.messages[0]?.authorName);
  });

  it("lists a version's threads for its drafter", async () => {
    const thread = await start();
    const answer = await as("user-bob", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.deepEqual(
      (answer.data.reviewThreads as Thread[]).map((t) => t.id),
      [thread.id],
    );
  });

  it("lets the drafter reply, resolve and reopen", async () => {
    const thread = await start();
    const reply = await as("user-bob", "ReplyReviewThread", {
      body: "Fixed in the next draft.",
      threadId: thread.id,
    });
    assert.deepEqual(
      (reply.data.replyReviewThread as Thread).messages.map((m) => m.body),
      ["What is this?", "Fixed in the next draft."],
    );
    const done = await as("user-bob", "SetReviewThreadResolved", {
      resolved: true,
      threadId: thread.id,
    });
    assert.equal((done.data.setReviewThreadResolved as Thread).resolved, true);
    const again = await as("user-bob", "SetReviewThreadResolved", {
      resolved: false,
      threadId: thread.id,
    });
    assert.equal(
      (again.data.setReviewThreadResolved as Thread).resolved,
      false,
    );
  });

  it("refuses an empty comment and an empty quote", async () => {
    const empty = await as("user-charlie", "AddReviewThread", {
      body: "  ",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: "x",
    });
    assert.equal(empty.refused, "InvalidArgument");
    const noQuote = await as("user-charlie", "AddReviewThread", {
      body: "Why?",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: " ",
    });
    assert.equal(noQuote.refused, "InvalidArgument");
  });

  it("keeps someone outside the review from starting or answering a thread", async () => {
    const thread = await start();
    const outsider = await as("user-erin", "AddReviewThread", {
      body: "Hi",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: "seven years",
    });
    assert.notEqual(outsider.refused, undefined);
    const reply = await as("user-erin", "ReplyReviewThread", {
      body: "Hi",
      threadId: thread.id,
    });
    assert.notEqual(reply.refused, undefined);
  });

  it("lets only the person who started a thread delete it", async () => {
    const thread = await start();
    const other = await as("user-bob", "DeleteReviewThread", {
      threadId: thread.id,
    });
    assert.notEqual(other.refused, undefined);
    const own = await as("user-charlie", "DeleteReviewThread", {
      threadId: thread.id,
    });
    assert.equal(own.data.deleteReviewThread, true);
    const left = await as("user-bob", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.deepEqual(left.data.reviewThreads, []);
  });
});

describe("whose thread it is", () => {
  // Charlie and Alice both hold a seat on version-4's review stage; Bob is the author.
  it("is with the approver who started it, and the author sees it with who wrote it", async () => {
    const thread = await start();
    assert.equal(
      (thread as { approverUserId: string } & Thread).approverUserId,
      "user-charlie",
    );
    const asAuthor = await as("user-bob", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    const seen = asAuthor.data.reviewThreads as Thread[];
    assert.deepEqual(
      seen.map((t) => t.id),
      [thread.id],
    );
    assert.equal(seen[0]?.messages[0]?.authorUserId, "user-charlie");
    assert.ok(seen[0]?.messages[0]?.authorName);
  });

  it("is not shown to another approver on the same step", async () => {
    await start();
    const other = await as("user-alice", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.deepEqual(other.data.reviewThreads, []);
    const own = await as("user-charlie", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.equal((own.data.reviewThreads as Thread[]).length, 1);
  });

  it("cannot be answered, resolved or deleted by another approver", async () => {
    const thread = await start();
    for (const [operation, variables] of [
      ["ReplyReviewThread", { body: "Me too.", threadId: thread.id }],
      ["SetReviewThreadResolved", { resolved: true, threadId: thread.id }],
      ["DeleteReviewThread", { threadId: thread.id }],
    ] as const) {
      const refused = await as("user-alice", operation, variables);
      assert.notEqual(refused.refused, undefined, operation);
    }
  });

  it("lets the author write to one approver, who alone sees it", async () => {
    const answer = await as("user-bob", "AddReviewThread", {
      body: "Can you check this wording?",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: "seven years",
      toUserId: "user-charlie",
    });
    assert.equal(answer.refused, undefined, JSON.stringify(answer));
    const thread = answer.data.addReviewThread as {
      approverUserId: string;
    } & Thread;
    assert.equal(thread.approverUserId, "user-charlie");
    const charlie = await as("user-charlie", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.equal((charlie.data.reviewThreads as Thread[]).length, 1);
    const alice = await as("user-alice", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.deepEqual(alice.data.reviewThreads, []);
  });

  it("makes the author say which approver, and only one who has a seat", async () => {
    const base = {
      body: "Check?",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: "seven years",
    };
    const none = await as("user-bob", "AddReviewThread", base);
    assert.equal(none.refused, "InvalidArgument");
    const stranger = await as("user-bob", "AddReviewThread", {
      ...base,
      toUserId: "user-erin",
    });
    assert.equal(stranger.refused, "InvalidArgument");
  });
});
