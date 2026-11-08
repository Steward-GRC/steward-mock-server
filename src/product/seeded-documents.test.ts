// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The seeded documents (bug log 214): policies and procedures in every state, the reference drafts
// the owner uses, appendices with formatted text, files that open, threads at different stages and
// a three-seat step. A restart or Start fresh brings all of it back.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { headersFor, startForTests, startFresh } from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

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

const byNumber = (number: string) => {
  const { policies, versions } = stewardData();
  const policy = policies.find((p) => p.number === number);
  assert.ok(policy, `${number} is seeded`);
  return {
    policy,
    versions: versions.filter((v) => v.policyId === policy.id),
  };
};

describe("the reference documents", () => {
  it("has the expense policy, the finance policy with three appendices and the travel procedure", () => {
    assert.equal(byNumber("POL-EXPENSES-000002").policy.documentType, "POLICY");
    assert.equal(
      byNumber("PRC-TRAVEL-000003").policy.documentType,
      "PROCEDURE",
    );
    const finance = byNumber("POL-FINANCE-000003");
    const published = finance.versions.find((v) => v.status === "PUBLISHED");
    assert.deepEqual(
      published?.appendices.map((a) => a.letter),
      ["A", "B", "C"],
    );
    assert.equal(
      finance.versions.filter((v) => v.status === "SUPERSEDED").length,
      1,
    );
  });
});

const statesOf = (type: "POLICY" | "PROCEDURE") => {
  const { policies, versions } = stewardData();
  return new Set(
    policies
      .filter((p) => p.documentType === type)
      .flatMap((p) => versions.filter((v) => v.policyId === p.id))
      .map((v) => v.status),
  );
};

describe("the states", () => {
  it("covers published, draft, in review, rejected and withdrawn for policies and procedures", () => {
    for (const type of ["POLICY", "PROCEDURE"] as const) {
      const states = statesOf(type);
      for (const state of [
        "DRAFT",
        "IN_REVIEW",
        "PUBLISHED",
        "REJECTED",
        "WITHDRAWN",
      ]) {
        assert.ok(states.has(state), `${type} has a ${state} version`);
      }
    }
  });

  it("has a freeform policy with no template", () => {
    const freeform = stewardData().policies.find(
      (p) => p.templateNone && p.currentDraftVersionId && !p.templateId,
    );
    assert.ok(freeform);
  });

  it("asks for no acknowledgement on a procedure", () => {
    const { policies } = stewardData();
    for (const p of policies.filter((x) => x.documentType === "PROCEDURE")) {
      assert.notEqual(p.ackTriggers, "ON_PUBLISH", p.number);
    }
  });
});

describe("appendices and files", () => {
  it("writes appendices as formatted text, with lists and a table", () => {
    const text = byNumber("POL-FINANCE-000003")
      .versions.flatMap((v) => v.appendices)
      .map((a) => a.contentJson)
      .join("");
    for (const type of ['"type":"list"', '"type":"table"', '"type":"file"']) {
      assert.ok(text.includes(type), `an appendix holds ${type}`);
    }
  });

  it("serves the attached PDF and the image with real bytes", async () => {
    const erin = await signInAs(base, "user-erin");
    const want: Record<string, string> = {
      "asset-seed-1": "application/pdf",
      "asset-seed-2": "image/png",
    };
    for (const [id, contentType] of Object.entries(want)) {
      const response = await fetch(`${base}/api/assets/${id}`, {
        headers: headersFor(erin),
      });
      assert.equal(response.status, 200, id);
      assert.equal(response.headers.get("content-type"), contentType);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.length > 50, id);
      assert.equal(stewardData().assets[id]?.sizeBytes, bytes.length);
    }
  });

  it("keeps the files after Start fresh", async () => {
    startFresh();
    const erin = await signInAs(base, "user-erin");
    const response = await fetch(`${base}/api/assets/asset-seed-1`, {
      headers: headersFor(erin),
    });
    assert.equal(response.status, 200);
  });
});

describe("reviews", () => {
  it("has a three-seat step that needs all, and a majority sign-off after it", () => {
    const workflow = stewardData().workflowDefs.find(
      (w) => w.id === "workflow-4",
    );
    assert.equal(workflow?.stages[0]?.approvers.length, 3);
    assert.equal(workflow?.stages[0]?.quorum, "all");
    assert.equal(workflow?.stages[1]?.quorum, "majority");
  });

  it("has threads in different stages from different approvers", () => {
    const threads = stewardData().reviewThreads;
    assert.ok(new Set(threads.map((t) => t.approverUserId)).size >= 2);
    assert.ok(threads.some((t) => t.resolved));
    assert.ok(
      threads.some(
        (t) => t.suggestion?.turn === "AUTHOR" && !t.suggestion.outcome,
      ),
    );
    assert.ok(
      threads.some(
        (t) => t.suggestion?.turn === "REVIEWER" && !t.suggestion.outcome,
      ),
    );
    assert.ok(threads.some((t) => t.suggestion?.outcome === "CHANGED"));
  });

  it("puts every threaded version in review with a run", () => {
    const { reviewThreads, runs, versions } = stewardData();
    for (const thread of reviewThreads) {
      const version = versions.find((v) => v.id === thread.policyVersionId);
      assert.equal(version?.status, "IN_REVIEW");
      assert.ok(runs.some((r) => r.policyVersionId === version?.id));
    }
  });
});

const travel = () =>
  stewardData().policies.find((p) => p.number === "PRC-TRAVEL-000003")!;

describe("the Travel booking procedure's appendix", () => {
  it("has one published appendix titled Appendix A, with formatted text", () => {
    const appendices = stewardData().appendices.filter(
      (a) => a.policyId === travel().id,
    );
    assert.equal(appendices.length, 1);
    const row = appendices[0]!.versions.at(-1)!;
    assert.equal(row.state, "PUBLISHED");
    assert.equal(row.title, "Appendix A");
    for (const kind of ['"type":"table"', '"type":"list"', '"format":1'])
      assert.ok(row.contentJson.includes(kind), kind);
  });

  it("shows it on the version under approval, read as a reader would", () => {
    const draft = stewardData().versions.find(
      (v) => v.id === travel().currentDraftVersionId,
    )!;
    assert.deepEqual(
      draft.appendices.map((a) => [a.letter, a.title]),
      [["A", "Appendix A"]],
    );
  });

  it("keeps every policy's appendix titles different from each other", () => {
    for (const policy of stewardData().policies) {
      const titles = stewardData()
        .appendices.filter((a) => a.policyId === policy.id)
        .flatMap((a) => a.versions.at(-1)?.title ?? []);
      assert.equal(new Set(titles).size, titles.length, policy.number);
    }
  });
});
