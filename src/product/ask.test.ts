// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Ask on the mock: searchAndAnswer answers from the published policies the caller may read, cites
// the sections it drew on, and marks each cited sentence with the segments steward-web's answer
// view splits on. Real AI is tested on the appliance only; this is the simulation that lets the
// Ask page be walked against the mock. A control turns it off, and AI then answers as if the ai
// service were down.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  control,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let bob: Signed;
let dave: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  bob = await signInAs(base, "user-bob");
  dave = await signInAs(base, "user-dave");
});

interface Result {
  answer: string;
  citations: { policyId: string; policyTitle: string; sectionKey: string }[];
  hasSensitiveSource: boolean;
  noAuthorizedSource: boolean;
  segments: {
    end: number;
    sources: { policyId: string; sectionKey: string }[];
    start: number;
  }[];
}

const ask = async (signed: Signed, question: string) => {
  const answer = await call(base, signed, "SearchAndAnswer", { question });
  return {
    refused: answer.refused,
    result: answer.data.searchAndAnswer as Result | undefined,
  };
};

describe("Ask against the mock", () => {
  it("says AI is available", async () => {
    const answer = await call(base, bob, "AiHealth");
    assert.deepEqual(answer.data.aiHealth, { available: true, reason: null });
  });

  it("answers from a published policy and cites its section", async () => {
    const { result } = await ask(bob, "When must I file an expense claim?");
    assert.ok(result);
    assert.match(result.answer, /30 days/);
    assert.equal(result.noAuthorizedSource, false);
    const cited = result.citations.find((c) => c.policyId === "policy-1");
    assert.ok(cited, "the expenses policy is cited");
    assert.equal(cited.sectionKey, "policy-statement");
    assert.equal(cited.policyTitle, "Expense Claims Policy");
  });

  it("marks cited text with segments that fit the answer and name cited sections", async () => {
    const { result } = await ask(bob, "When must I file an expense claim?");
    assert.ok(result);
    assert.ok(result.segments.length > 0);
    for (const segment of result.segments) {
      assert.ok(segment.start >= 0 && segment.end > segment.start);
      assert.ok(segment.end <= result.answer.length);
      for (const source of segment.sources)
        assert.ok(
          result.citations.some(
            (c) =>
              c.policyId === source.policyId &&
              c.sectionKey === source.sectionKey,
          ),
        );
    }
  });

  it("answers that nothing matches when no readable source does", async () => {
    const { result } = await ask(
      bob,
      "What is our quantum teleportation rule?",
    );
    assert.ok(result);
    assert.equal(result.noAuthorizedSource, true);
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.segments, []);
  });

  it("flags a sensitive source for a reader who may see it", async () => {
    const { result } = await ask(bob, "Who may hold administrator access?");
    assert.ok(result);
    assert.ok(result.citations.some((c) => c.policyId === "policy-8"));
    assert.equal(result.hasSensitiveSource, true);
  });

  it("never cites a policy the caller may not read", async () => {
    const { result } = await ask(dave, "Who may hold administrator access?");
    assert.ok(result);
    assert.ok(!result.citations.some((c) => c.policyId === "policy-8"));
    assert.equal(result.hasSensitiveSource, false);
    assert.equal(result.noAuthorizedSource, true);
  });

  it("lists the questions asked, most asked first, up to the limit", async () => {
    for (const question of [
      "When must I file an expense claim?",
      "Who may hold administrator access?",
      "Who may hold administrator access?",
    ])
      await ask(bob, question);
    const all = await call(base, bob, "TopPolicyQuestions", { limit: 6 });
    assert.deepEqual(all.data.topPolicyQuestions, [
      "Who may hold administrator access?",
      "When must I file an expense claim?",
    ]);
    const one = await call(base, bob, "TopPolicyQuestions", { limit: 1 });
    assert.deepEqual(one.data.topPolicyQuestions, [
      "Who may hold administrator access?",
    ]);
  });

  it("answers as if the ai service were down while the simulation is off", async () => {
    await control(base, { kind: "ai-simulation", on: false });
    const health = await call(base, bob, "AiHealth");
    assert.equal(
      (health.data.aiHealth as { available: boolean }).available,
      false,
    );
    const { refused } = await ask(bob, "When must I file an expense claim?");
    assert.equal(refused, "INTERNAL");
    await control(base, { kind: "ai-simulation", on: true });
    const { result } = await ask(bob, "When must I file an expense claim?");
    assert.ok(result?.citations.length);
  });
});
