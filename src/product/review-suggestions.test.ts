// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Suggested changes on a review thread: a reviewer proposes replacement text for the quoted words,
// the author and the reviewer take turns countering, and the thread ends in one outcome. The mock
// keeps the rounds and the outcome; the client applies accepted text to the document and saves.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

interface Suggestion {
  closedBy: null | string;
  closedText: null | string;
  outcome: null | string;
  reason: null | string;
  rounds: { by: string; text: string }[];
  text: string;
  turn: string;
}
interface Thread {
  id: string;
  resolved: boolean;
  suggestion: null | Suggestion;
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

/** Charlie reviews, Bob drafts. */
const propose = async (suggestedText: null | string = "six years") => {
  const answer = await as("user-charlie", "AddReviewThread", {
    body: "Shorter?",
    occurrence: 1,
    policyVersionId: VERSION,
    quote: "seven years",
    suggestedText,
  });
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data.addReviewThread as Thread;
};
const counter = (user: string, threadId: string, text: string) =>
  as(user, "CounterReviewSuggestion", { text, threadId });
const close = (
  user: string,
  threadId: string,
  outcome: string,
  reason?: string,
) => as(user, "CloseReviewSuggestion", { outcome, reason, threadId });

describe("starting a suggestion", () => {
  it("opens it on the author's turn when a reviewer proposes", async () => {
    const thread = await propose();
    assert.equal(thread.suggestion?.text, "six years");
    assert.equal(thread.suggestion?.turn, "AUTHOR");
    assert.deepEqual(
      thread.suggestion?.rounds.map((r) => r.by),
      ["REVIEWER"],
    );
    assert.equal(thread.suggestion?.outcome, null);
  });

  it("opens it on the reviewer's turn when the author proposes", async () => {
    const answer = await as("user-bob", "AddReviewThread", {
      body: "How about this?",
      occurrence: 1,
      policyVersionId: VERSION,
      quote: "seven years",
      suggestedText: "five years",
    });
    assert.equal(
      (answer.data.addReviewThread as Thread).suggestion?.turn,
      "REVIEWER",
    );
  });

  it("is a plain comment when no text, or the same text, is proposed", async () => {
    assert.equal((await propose(null)).suggestion, null);
    assert.equal((await propose("seven years")).suggestion, null);
  });

  it("comes back on the version's thread list", async () => {
    const thread = await propose();
    const list = await as("user-bob", "ReviewThreads", {
      policyVersionId: VERSION,
    });
    assert.equal(
      (list.data.reviewThreads as Thread[])[0]?.suggestion?.text,
      "six years",
    );
    assert.equal((list.data.reviewThreads as Thread[])[0]?.id, thread.id);
  });
});

describe("countering", () => {
  it("lets the side whose turn it is counter, and flips the turn", async () => {
    const thread = await propose();
    const answer = await counter("user-bob", thread.id, "five years");
    const next = (answer.data.counterReviewSuggestion as Thread).suggestion;
    assert.equal(next?.text, "five years");
    assert.equal(next?.turn, "REVIEWER");
    assert.deepEqual(
      next?.rounds.map((r) => [r.by, r.text]),
      [
        ["REVIEWER", "six years"],
        ["AUTHOR", "five years"],
      ],
    );
  });

  it("refuses a counter out of turn, an empty one, and one on a plain comment", async () => {
    const thread = await propose();
    assert.notEqual(
      (await counter("user-charlie", thread.id, "four years")).refused,
      undefined,
    );
    assert.equal(
      (await counter("user-bob", thread.id, "  ")).refused,
      "InvalidArgument",
    );
    const plain = await propose(null);
    assert.notEqual(
      (await counter("user-bob", plain.id, "x")).refused,
      undefined,
    );
  });

  it("keeps someone outside the review out", async () => {
    const thread = await propose();
    assert.notEqual(
      (await counter("user-erin", thread.id, "x")).refused,
      undefined,
    );
  });
});

describe("closing", () => {
  it("lets the author change it, which resolves the thread and records the text", async () => {
    const thread = await propose();
    const answer = await close("user-bob", thread.id, "CHANGED");
    const done = answer.data.closeReviewSuggestion as Thread;
    assert.equal(done.resolved, true);
    assert.equal(done.suggestion?.outcome, "CHANGED");
    assert.equal(done.suggestion?.closedText, "six years");
    assert.equal(done.suggestion?.closedBy, "user-bob");
  });

  it("lets the author remove the note, and the reviewer agree on their turn", async () => {
    const first = await propose();
    assert.equal(
      (
        (await close("user-bob", first.id, "REMOVED")).data
          .closeReviewSuggestion as Thread
      ).suggestion?.outcome,
      "REMOVED",
    );
    const second = await propose();
    await counter("user-bob", second.id, "five years");
    const agreed = await close("user-charlie", second.id, "AGREED");
    assert.equal(
      (agreed.data.closeReviewSuggestion as Thread).suggestion?.closedText,
      "five years",
    );
  });

  it("does not let the wrong side use an outcome that is not theirs", async () => {
    const thread = await propose();
    // the reviewer proposed and it is the author's turn: the reviewer cannot agree with themselves
    assert.notEqual(
      (await close("user-charlie", thread.id, "AGREED")).refused,
      undefined,
    );
    // the author's CHANGED/REMOVED belong to the author
    await counter("user-bob", thread.id, "five years");
    assert.notEqual(
      (await close("user-bob", thread.id, "CHANGED")).refused,
      undefined,
    );
  });

  it("needs a reason for not agreed, and records it", async () => {
    const thread = await propose();
    assert.equal(
      (await close("user-bob", thread.id, "NOT_AGREED")).refused,
      "InvalidArgument",
    );
    const answer = await close(
      "user-bob",
      thread.id,
      "NOT_AGREED",
      "Law says seven.",
    );
    const done = (answer.data.closeReviewSuggestion as Thread).suggestion;
    assert.equal(done?.outcome, "NOT_AGREED");
    assert.equal(done?.reason, "Law says seven.");
  });

  it("lets the side that proposed first withdraw while it is not their turn", async () => {
    const thread = await propose();
    const answer = await close("user-charlie", thread.id, "WITHDRAWN");
    assert.equal(
      (answer.data.closeReviewSuggestion as Thread).suggestion?.outcome,
      "WITHDRAWN",
    );
    const other = await propose();
    assert.notEqual(
      (await close("user-bob", other.id, "WITHDRAWN")).refused,
      undefined,
    );
  });

  it("refuses to close twice, or to counter a closed suggestion", async () => {
    const thread = await propose();
    await close("user-bob", thread.id, "REMOVED");
    assert.notEqual(
      (await close("user-bob", thread.id, "REMOVED")).refused,
      undefined,
    );
    assert.notEqual(
      (await counter("user-bob", thread.id, "x")).refused,
      undefined,
    );
  });
});
