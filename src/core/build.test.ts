// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock says which commit it was started from, so a version under test can be compared with
// main when diagnosing: on the /_mock page, and as JSON for a script (GET /_mock/version).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { buildCommit } from "#core/build.ts";
import { startForTests } from "#core/test-client.ts";

let base = "";
let server: RunningMockServer;
before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});

describe("the mock's build commit", () => {
  it("is the short commit of the checkout it runs from", () => {
    const git = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(buildCommit(), git);
  });

  it("is read by a script from /_mock/version", async () => {
    const answer = await fetch(`${base}/_mock/version`);
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as {
      commit: string;
      name: string;
      version: string;
    };
    assert.equal(body.commit, buildCommit());
    assert.ok(body.name);
    assert.ok(body.version);
  });

  it("shows on the /_mock page next to the version", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.ok(html.includes(`class="commit"`), "the page has a commit element");
    assert.ok(html.includes(buildCommit()));
  });
});
