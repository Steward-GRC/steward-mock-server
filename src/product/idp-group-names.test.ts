// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// idpGroupNames and the structured verdicts of simulateCategory, as steward-gateway answers them.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

const NAMES = `query ($prefix: String, $limit: Int) {
  idpGroupNames(prefix: $prefix, limit: $limit) { names truncated }
}`;

const SIM = `query ($categoryId: ID!, $userId: ID!, $groupName: String) {
  simulateCategory(categoryId: $categoryId, userId: $userId, groupName: $groupName) {
    read readCode
    readVerdict { code rule { categoryId categoryName depth ruleNumber subjectKind subjectRef action } }
    manageVerdict { code rule { ruleNumber } }
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
beforeEach(() => {
  startFresh();
});

const ask = async (text: string, variables: Record<string, unknown>) => {
  const signed: Signed = await signInAs(base, "user-alice");
  const { body } = await query(base, text, signed, variables);
  return { code: body.errors?.[0]?.extensions.code, data: body.data ?? {} };
};

describe("idpGroupNames", () => {
  it("lists distinct names, byte-sorted, matching the prefix case-insensitively", async () => {
    const all = (await ask(NAMES, {})).data.idpGroupNames as {
      names: string[];
      truncated: boolean;
    };
    assert.equal(all.truncated, false);
    assert.deepEqual(all.names, [...new Set(all.names)].toSorted());
    assert.ok(all.names.includes("Facilities team"));
    const filtered = (await ask(NAMES, { prefix: "  facil " })).data
      .idpGroupNames as { names: string[] };
    assert.deepEqual(filtered.names, ["Facilities team"]);
  });

  it("truncates at the limit and says so", async () => {
    const page = (await ask(NAMES, { limit: 1 })).data.idpGroupNames as {
      names: string[];
      truncated: boolean;
    };
    assert.equal(page.names.length, 1);
    assert.equal(page.truncated, true);
  });
});

describe("simulateCategory verdicts and groupName", () => {
  it("names the deciding rule for a group's members", async () => {
    const out = (
      await ask(SIM, {
        categoryId: "category-facilities",
        groupName: "Facilities team",
        userId: "",
      })
    ).data.simulateCategory as {
      read: boolean;
      readVerdict: {
        code: string;
        rule: { ruleNumber: number; subjectRef: string };
      };
    };
    assert.equal(out.read, true);
    assert.equal(out.readVerdict.code, "RULE_ALLOW");
    assert.equal(out.readVerdict.rule.subjectRef, "Facilities team");
    assert.equal(out.readVerdict.rule.ruleNumber, 1);
  });

  it("reports the site admin seat and an owner without a rule", async () => {
    const out = (
      await ask(SIM, {
        categoryId: "category-facilities",
        userId: "user-alice",
      })
    ).data.simulateCategory as {
      readVerdict: { code: string; rule: unknown };
    };
    assert.ok(
      ["OWNER", "RULE_ALLOW", "SITE_ADMIN_READ"].includes(out.readVerdict.code),
    );
  });

  it("refuses a user and a group together", async () => {
    const out = await ask(SIM, {
      categoryId: "category-facilities",
      groupName: "Facilities team",
      userId: "user-alice",
    });
    assert.equal(out.code, "InvalidArgument");
  });
});
