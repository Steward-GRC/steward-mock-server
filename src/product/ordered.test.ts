// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The shared go-authz vectors (testdata/ordered.json, see ordered.SOURCE) through the mock's
// ordered engine: every case and every pool, compared on the allowed flag, the reason, the
// deciding entry, the gating action and the configured block, as go-authz's own runner does.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  type Action,
  decide,
  type Entry,
  type Person,
  pool,
  type PoolEntry,
  type RuleSet,
  type Superusers,
} from "#product/ordered.ts";

interface VectorCase {
  action: string;
  category: string;
  expect: {
    allowed: boolean;
    configuredBlock?: Entry | null;
    decidedBy?: Entry | null;
    gatedBy?: string;
    reason: string;
  };
  name: string;
  person: Person;
  ruleSet: RuleSet;
}

interface VectorFile {
  actions: Action[];
  cases: VectorCase[];
  model: string;
  options: { superusers?: Superusers };
  pools: VectorPool[];
  version: number;
}

interface VectorPool {
  action: string;
  category: string;
  expect: PoolEntry[];
  name: string;
  people: Person[];
  ruleSet: RuleSet;
}

const folder = new URL("testdata/", import.meta.url);
const raw = readFileSync(new URL("ordered.json", folder));
const vectors = JSON.parse(raw.toString("utf8")) as VectorFile;
const model = {
  actions: vectors.actions,
  superusers: vectors.options.superusers ?? null,
};

describe("the shared ordered vectors", () => {
  it("are the copy ordered.SOURCE names", () => {
    const source = readFileSync(new URL("ordered.SOURCE", folder), "utf8");
    const line = (key: string) =>
      new RegExp(`^${key}: (.+)$`, "m").exec(source)?.[1];
    assert.match(line("commit") ?? "", /^[\da-f]{40}$/);
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      line("sha256"),
    );
    assert.equal(vectors.model, "ordered");
    assert.ok(vectors.cases.length >= 74);
  });

  it("decide the same way through the mock's engine", () => {
    // The engine takes the role and capability matchers as plain subjects, so none is skipped.
    let ran = 0;
    const skipped = 0;
    for (const given of vectors.cases) {
      ran++;
      const got = decide(
        model,
        given.ruleSet,
        given.person,
        given.category,
        given.action,
      );
      const label = given.name;
      assert.equal(got.allowed, given.expect.allowed, `${label}: allowed`);
      assert.equal(got.reason, given.expect.reason, `${label}: reason`);
      assert.deepEqual(
        got.decidedBy,
        given.expect.decidedBy ?? null,
        `${label}: decidedBy`,
      );
      assert.equal(
        got.gatedBy,
        given.expect.gatedBy ?? "",
        `${label}: gatedBy`,
      );
      assert.deepEqual(
        got.configuredBlock,
        given.expect.configuredBlock ?? null,
        `${label}: configuredBlock`,
      );
    }
    console.log(
      `ordered vectors: ran ${String(ran)}, skipped ${String(skipped)}, total ${String(vectors.cases.length)}`,
    );
    assert.equal(ran + skipped, vectors.cases.length);
    assert.equal(skipped, 0);
  });

  it("list the same pools", () => {
    assert.ok(vectors.pools.length > 0);
    for (const given of vectors.pools) {
      assert.deepEqual(
        pool(model, given.ruleSet, given.people, given.category, given.action),
        given.expect,
        given.name,
      );
    }
    console.log(`ordered pools: ran ${String(vectors.pools.length)}`);
  });
});
