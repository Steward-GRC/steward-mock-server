// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The demo start state: a brand-new install with the basic setup (the people, the category tree,
// the templates, the workflows, the groups and the settings) and no sample documents. The
// "Start as a new install" control keeps the sample data and only sends the clients through
// first-run setup; this one takes the documents away too, and Reset and Start fresh then return
// to it until the sample data is asked for again.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { control, startForTests, startFresh } from "#product/test-client.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await control(base, { kind: "start-state", state: "sample" });
  await server.close();
});
beforeEach(() => startFresh());

const documents = () => {
  const data = stewardData();
  return {
    appendices: data.appendices.length,
    audit: data.audit.length,
    policies: data.policies.length,
    reportCases: data.reportCases.length,
    runs: data.runs.length,
    versions: data.versions.length,
  };
};

describe("the demo start state", () => {
  it("has the sample documents by default", () => {
    assert.ok(documents().policies > 0);
  });

  it("keeps the basic setup and has no documents", async () => {
    await control(base, { kind: "start-state", state: "demo" });
    assert.deepEqual(documents(), {
      appendices: 0,
      audit: 0,
      policies: 0,
      reportCases: 0,
      runs: 0,
      versions: 0,
    });
    const data = stewardData();
    assert.ok(data.categories.length > 0, "the category tree stays");
    assert.ok(
      data.templates.length > 0 && data.templateVersions.length > 0,
      "templates stay",
    );
    assert.ok(data.workflowDefs.length > 0, "workflows stay");
    assert.ok(data.platformGroups.length > 0, "groups stay");
    assert.ok(
      data.people.some((person) => person.username === "alice"),
      "the people stay",
    );
    assert.equal(
      data.people.some((person) => person.username === "p.quinn"),
      false,
      "the merge-accounts duplicates are sample data",
    );
    assert.deepEqual(
      data.people.flatMap(
        (person) =>
          (person as { policyOverrides?: unknown[] }).policyOverrides ?? [],
      ),
      [],
      "no access override points at a document that is not there",
    );
  });

  it("is what Reset and Start fresh return to, until the sample data is asked for", async () => {
    await control(base, { kind: "start-state", state: "demo" });
    stewardData().policies.push({ ...stewardData().categories[0] } as never);
    await control(base, { kind: "reset" });
    assert.equal(documents().policies, 0);
    await control(base, { kind: "fresh" });
    assert.equal(documents().policies, 0);
    await control(base, { kind: "start-state", state: "sample" });
    assert.ok(documents().policies > 0);
  });

  it("signs everyone out, as a new install has nobody signed in", async () => {
    const { mockState } = await import("#core/state.ts");
    await control(base, { kind: "sign-in", personId: "user-alice" });
    assert.ok(mockState.sessions.size > 0);
    await control(base, { kind: "start-state", state: "demo" });
    assert.equal(mockState.sessions.size, 0);
  });
});
