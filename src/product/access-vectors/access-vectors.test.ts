// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Report-only: runs the shared access vectors (decide.json, vendored beside this file) against the
// mock's current RACI rules through its real simulateCategory resolution, and counts the cases
// that agree, differ or cannot be expressed in the old model. Differences never fail the suite. A
// malformed vector file or an adapter that cannot map a case does.
//
//   npm run test:vectors-report     writes REPORT.md beside this file (sets VECTORS_REPORT=1)
//   npm test                        runs the same checks and writes nothing

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { StewardPerson } from "#product/data/people.ts";

import {
  type Outcome,
  parseVectors,
  type Plan,
  plan,
  renderReport,
  summarise,
  type Vectors,
} from "#product/access-vectors/adapter.ts";
import { stewardData } from "#product/data.ts";
import { query, startForTests, startFresh } from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

const FILE = new URL("decide.json", import.meta.url);
const REPORT = new URL("REPORT.md", import.meta.url);
const REPORTING = process.env.VECTORS_REPORT === "1";

const SIMULATE = `query ($categoryId: ID!, $userId: ID!) {
  simulateCategory(categoryId: $categoryId, userId: $userId) {
    read readReason approve approveReason author authorReason
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

/** Loads the mock with the planned categories and person, asks, and reads the answer. */
const askMock = async (
  load: Extract<Plan, { kind: "map" }>,
): Promise<Outcome["mock"]> => {
  startFresh();
  const signed = await signInAs(base, "user-alice");
  const data = stewardData();
  const [seedCategory] = data.categories;
  const seedPerson = data.people.find((p) => p.id !== "user-alice");
  assert.ok(seedCategory && seedPerson, "the seed has a category and a person");
  data.categories = load.categories.map((c) => ({
    ...structuredClone(seedCategory),
    approverRule: [],
    authorRule: [],
    id: c.id,
    name: c.id,
    owners: [],
    parentId: c.parentId,
    rules: c.rules,
    slug: c.id,
  }));
  const person: Partial<StewardPerson> = {
    ...structuredClone(seedPerson),
    groups: load.person.groups,
    id: load.person.id,
    roles: [],
  };
  data.people.push(person as StewardPerson);
  const { body } = await query(base, SIMULATE, signed, {
    categoryId: load.askedCategory,
    userId: load.person.id,
  });
  if (body.errors?.length)
    return { error: String(body.errors[0]?.extensions.code ?? "ERROR") };
  const answer = body.data?.simulateCategory as Record<string, unknown>;
  const key = load.askedAction;
  return {
    allowed: answer[key] === true,
    reason: String(answer[`${key}Reason`]),
  };
};

const run = async (file: Vectors): Promise<Outcome[]> => {
  const outcomes: Outcome[] = [];
  for (const vector of file.cases) {
    const mapped = plan(vector, file.actions);
    outcomes.push(
      mapped.kind === "unrepresentable"
        ? { mapped, vector }
        : {
            given: await askMock(
              plan(vector, file.actions, false) as typeof mapped,
            ),
            mapped,
            mock: await askMock(mapped),
            vector,
          },
    );
  }
  return outcomes;
};

describe("adapter input checks", () => {
  it("rejects a vector file that is not the expected shape", () => {
    assert.throws(() => parseVectors("{"), /not valid JSON/);
    assert.throws(() => parseVectors("{}"), /version/);
    assert.throws(
      () =>
        parseVectors(JSON.stringify({ actions: [], cases: [{}], version: 1 })),
      /case 0/,
    );
  });

  it("rejects a repeated case name", () => {
    const text = readFileSync(FILE, "utf8");
    const file = JSON.parse(text);
    file.cases.push(file.cases[0]);
    assert.throws(
      () => parseVectors(JSON.stringify(file)),
      /repeated case name/,
    );
  });

  it("rejects an entry the adapter cannot read", () => {
    const file = JSON.parse(readFileSync(FILE, "utf8"));
    file.cases[0].ruleSet.categories.team = {
      entries: [{ action: "read", effect: "maybe", subject: "user:a" }],
    };
    assert.throws(() => parseVectors(JSON.stringify(file)), /effect/);
    file.cases[0].ruleSet.categories.team = {
      entries: [{ action: "read", effect: "allow", subject: "nobody" }],
    };
    assert.throws(() => parseVectors(JSON.stringify(file)), /subject/);
  });
});

describe("shared access vectors against the mock's current rules", () => {
  it("maps and runs every case, and reports without failing on differences", async () => {
    const vectors = parseVectors(readFileSync(FILE, "utf8"));
    assert.ok(vectors.cases.length > 0, "the vector file has cases");
    const outcomes = await run(vectors);
    assert.equal(outcomes.length, vectors.cases.length);
    const counts = summarise(outcomes);
    assert.equal(
      counts.same + counts.differs + counts.unrepresentable,
      vectors.cases.length,
    );
    console.log(
      `access vectors: ${String(vectors.cases.length)} cases, ${String(counts.same)} same, ${String(counts.differs)} differ, ${String(counts.unrepresentable)} unrepresentable`,
    );
    if (REPORTING) writeFileSync(REPORT, renderReport(outcomes, counts));
  });
});
