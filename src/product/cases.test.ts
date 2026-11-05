// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Reporting cases: each case owns its lists, so a change to one case never shows on another.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

const OFFICER = "user-mhamilton";

let base = "";
let server: RunningMockServer;
let officer: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  officer = await signInAs(base, OFFICER);
});

const caseOf = async (caseId: string) => {
  const answer = await call(base, officer, "ReportCase", { caseId });
  assert.equal(answer.refused, undefined);
  return answer.data.reportCase as Record<string, unknown[]>;
};

describe("report cases", () => {
  it("keeps a note added to one case off the others", async () => {
    const before1 = await caseOf("case-1");
    const before2 = await caseOf("case-2");

    const added = await call(base, officer, "AddCaseNote", {
      body: "Checked the folder's sharing settings.",
      caseId: "case-3",
    });
    assert.equal(added.refused, undefined);

    assert.equal((await caseOf("case-3")).notes?.length, 1);
    assert.deepEqual(await caseOf("case-1"), before1);
    assert.deepEqual(await caseOf("case-2"), before2);
  });

  it("starts every case's lists fresh on each seed", async () => {
    await call(base, officer, "AddCaseNote", {
      body: "A note from the last run.",
      caseId: "case-1",
    });
    startFresh();
    officer = await signInAs(base, OFFICER);

    assert.deepEqual((await caseOf("case-1")).notes, []);
    assert.deepEqual((await caseOf("case-3")).notes, []);
  });
});
