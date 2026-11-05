// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Category access (steward-web's A5): each category's own RACI rules, as steward-core stores them
// and steward-gateway answers them, the access simulator, which evaluates the category chain the
// way steward-authz does, and resolveUserLabels for the people the rules name.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  post,
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
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

const RULE = "subjectKind subjectRef read ack approve author";

const RULESET = `query ($categoryId: ID!) {
  categoryRuleset(categoryId: $categoryId) { categoryId rules { ${RULE} } }
}`;

const SET = `mutation ($categoryId: ID!, $rules: [RaciRuleInput!]!) {
  setCategoryRuleset(categoryId: $categoryId, rules: $rules) { categoryId rules { ${RULE} } }
}`;

const SIMULATE = `query ($categoryId: ID!, $userId: ID!, $draftRules: [RaciRuleInput!]) {
  simulateCategory(categoryId: $categoryId, userId: $userId, draftRules: $draftRules) {
    read readReason ack ackReason approve approveReason author authorReason
  }
}`;

const LABELS = `query ($ids: [ID!]!) { resolveUserLabels(ids: $ids) { id name email } }`;

const rule = (
  subjectKind: string,
  subjectReference: string,
  [read, ack, approve, author]: string[],
) => ({
  ack,
  approve,
  author,
  read,
  subjectKind,
  subjectRef: subjectReference,
});

const ALLOW_ALL = ["ALLOW", "ALLOW", "ALLOW", "ALLOW"];

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown>,
) => {
  const { body } = await query(base, text, signed, variables);
  return { code: body.errors?.[0]?.extensions.code, data: body.data ?? {} };
};

const admin = () => signInAs(base, "user-alice");

const rulesOf = async (categoryId: string) =>
  (await ask(await admin(), RULESET, { categoryId })).data.categoryRuleset;

const simulate = async (
  categoryId: string,
  userId: string,
  draftRules?: unknown[],
) =>
  (
    await ask(await admin(), SIMULATE, {
      categoryId,
      draftRules,
      userId,
    })
  ).data.simulateCategory;

const verdict = (
  [read, ack, approve, author]: boolean[],
  [readReason, ackReason, approveReason, authorReason]: string[],
) => ({
  ack,
  ackReason,
  approve,
  approveReason,
  author,
  authorReason,
  read,
  readReason,
});

describe("categoryRuleset", () => {
  it("answers each category's own rules, top-down", async () => {
    assert.deepEqual(await rulesOf("category-facilities"), {
      categoryId: "category-facilities",
      rules: [
        rule("GROUP", "Facilities team", ALLOW_ALL),
        rule("GROUP", "All staff", ["ALLOW", "ALLOW", "BLANK", "DENY"]),
      ],
    });
    assert.deepEqual(await rulesOf("category-workplace"), {
      categoryId: "category-workplace",
      rules: [rule("EVERYONE", "", ["ALLOW", "BLANK", "BLANK", "BLANK"])],
    });
    assert.deepEqual(await rulesOf("category-expenses"), {
      categoryId: "category-expenses",
      rules: [
        rule("GROUP", "Finance team", ALLOW_ALL),
        rule("USER", "user-erin", ["BLANK", "BLANK", "DENY", "DENY"]),
        rule("GROUP", "All staff", ["ALLOW", "BLANK", "BLANK", "BLANK"]),
      ],
    });
  });

  it("answers no rules for a category without any, or one it doesn't know", async () => {
    assert.deepEqual(await rulesOf("category-travel"), {
      categoryId: "category-travel",
      rules: [],
    });
    assert.deepEqual(await rulesOf("category-nowhere"), {
      categoryId: "category-nowhere",
      rules: [],
    });
  });

  it("is refused to someone without group or template management", async () => {
    const reader = await signInAs(base, "user-erin");
    const { code } = await ask(reader, RULESET, {
      categoryId: "category-facilities",
    });
    assert.equal(code, "PermissionDenied");
  });
});

describe("setCategoryRuleset", () => {
  it("replaces the category's rules and leaves its ancestors alone", async () => {
    const rules = [
      rule("USER", "user-bob", ["ALLOW", "BLANK", "BLANK", "ALLOW"]),
      rule("EVERYONE", "", ["ALLOW", "ALLOW", "BLANK", "BLANK"]),
    ];
    const { code, data } = await ask(await admin(), SET, {
      categoryId: "category-travel",
      rules,
    });
    assert.equal(code, undefined);
    assert.deepEqual(data.setCategoryRuleset, {
      categoryId: "category-travel",
      rules,
    });
    assert.deepEqual(await rulesOf("category-travel"), {
      categoryId: "category-travel",
      rules,
    });
    assert.equal(
      ((await rulesOf("category-workplace")) as { rules: unknown[] }).rules
        .length,
      1,
    );
  });

  it("audits each rule created, changed or removed, as steward-core does", async () => {
    await ask(await admin(), SET, {
      categoryId: "category-facilities",
      rules: [
        rule("GROUP", "Facilities team", ["ALLOW", "ALLOW", "ALLOW", "BLANK"]),
        rule("USER", "user-bob", ALLOW_ALL),
      ],
    });
    const actions = stewardData()
      .audit.filter((r) => r.groupId === "category-facilities")
      .map((r) => r.action)
      .toSorted();
    assert.deepEqual(actions, [
      "category_rule.created",
      "category_rule.deleted",
      "category_rule.updated",
    ]);
  });

  it("refuses an invalid rule and keeps the old ones", async () => {
    for (const bad of [
      rule("EVERYONE", "someone", ALLOW_ALL),
      rule("GROUP", " ", ALLOW_ALL),
      rule("USER", "", ALLOW_ALL),
    ]) {
      const { code } = await ask(await admin(), SET, {
        categoryId: "category-facilities",
        rules: [bad],
      });
      assert.equal(code, "InvalidArgument");
    }
    assert.equal(
      ((await rulesOf("category-facilities")) as { rules: unknown[] }).rules
        .length,
      2,
    );
  });

  it("is a site admin's alone", async () => {
    const reader = await signInAs(base, "user-erin");
    const { code } = await ask(reader, SET, {
      categoryId: "category-facilities",
      rules: [],
    });
    assert.equal(code, "PermissionDenied");
  });
});

describe("simulateCategory", () => {
  it("lets the Facilities team do everything in Facilities", async () => {
    const reason = "rule #1 allow group Facilities team";
    assert.deepEqual(
      await simulate("category-facilities", "user-erin"),
      verdict([true, true, true, true], [reason, reason, reason, reason]),
    );
  });

  it("lets all staff read and acknowledge Facilities, and not author", async () => {
    assert.deepEqual(
      await simulate("category-facilities", "user-bob"),
      verdict(
        [true, true, false, false],
        [
          "rule #2 allow group All staff",
          "rule #2 allow group All staff",
          "no rule → default deny",
          "rule #2 deny group All staff",
        ],
      ),
    );
  });

  it("answers the baseline for no one in particular from the inherited rule", async () => {
    assert.deepEqual(
      await simulate("category-facilities", ""),
      verdict(
        [true, false, false, false],
        [
          "↳ Workplace #1 allow everyone",
          "no rule → default deny",
          "no rule → default deny",
          "no rule → default deny",
        ],
      ),
    );
  });

  it("applies a person's own rule and the owner's rights in Expenses", async () => {
    assert.deepEqual(
      await simulate("category-expenses", "user-erin"),
      verdict(
        [true, false, false, false],
        [
          "rule #3 allow group All staff",
          "no rule → default deny",
          "rule #2 deny user user-erin",
          "rule #2 deny user user-erin",
        ],
      ),
    );
    assert.deepEqual(
      await simulate("category-expenses", "user-alice"),
      verdict(
        [true, false, true, true],
        [
          "owner (auto read/approve/author)",
          "no rule → default deny",
          "owner (auto read/approve/author)",
          "owner (auto read/approve/author)",
        ],
      ),
    );
  });

  it("gates everything on read, and lets author confer it", async () => {
    const draft = [
      rule("USER", "user-dave", ["BLANK", "ALLOW", "BLANK", "BLANK"]),
    ];
    assert.deepEqual(
      await simulate("category-travel", "user-dave", draft),
      verdict(
        [true, true, false, false],
        [
          "↳ Workplace #1 allow everyone",
          "rule #1 allow user user-dave",
          "no rule → default deny",
          "no rule → default deny",
        ],
      ),
    );
    const author = [
      rule("USER", "user-dave", ["DENY", "BLANK", "BLANK", "ALLOW"]),
    ];
    assert.deepEqual(
      await simulate("category-travel", "user-dave", author),
      verdict(
        [true, false, false, true],
        [
          "author implies read",
          "no rule → default deny",
          "no rule → default deny",
          "rule #1 allow user user-dave",
        ],
      ),
    );
    const denied = [
      rule("USER", "user-dave", ["DENY", "ALLOW", "BLANK", "BLANK"]),
    ];
    assert.deepEqual(
      await simulate("category-travel", "user-dave", denied),
      verdict(
        [false, false, false, false],
        [
          "rule #1 deny user user-dave",
          "requires read",
          "requires read",
          "requires read",
        ],
      ),
    );
  });

  it("previews draft rules without saving them", async () => {
    const draft = [rule("USER", "user-bob", ALLOW_ALL)];
    const preview = (await simulate(
      "category-facilities",
      "user-bob",
      draft,
    )) as {
      authorReason: string;
    };
    assert.equal(preview.authorReason, "rule #1 allow user user-bob");
    assert.equal(
      ((await rulesOf("category-facilities")) as { rules: unknown[] }).rules
        .length,
      2,
    );
  });

  it("refuses an unknown category or person, and a caller without the right", async () => {
    let { code } = await ask(await admin(), SIMULATE, {
      categoryId: "category-nowhere",
      userId: "",
    });
    assert.equal(code, "NotFound");
    ({ code } = await ask(await admin(), SIMULATE, {
      categoryId: "category-facilities",
      userId: "user-nobody",
    }));
    assert.equal(code, "NotFound");
    ({ code } = await ask(await signInAs(base, "user-erin"), SIMULATE, {
      categoryId: "category-facilities",
      userId: "",
    }));
    assert.equal(code, "PermissionDenied");
  });
});

describe("resolveUserLabels", () => {
  it("names each id, falling back to the id itself", async () => {
    const reader = await signInAs(base, "user-erin");
    const { data } = await ask(reader, LABELS, {
      ids: ["user-charlie", "user-nobody"],
    });
    assert.deepEqual(data.resolveUserLabels, [
      {
        email: "charlie@example.org",
        id: "user-charlie",
        name: "Charlie Approver",
      },
      { email: null, id: "user-nobody", name: "user-nobody" },
    ]);
  });

  it("needs someone signed in", async () => {
    const answer = await post(base, "/query", {
      query: 'query { resolveUserLabels(ids: ["user-bob"]) { id } }',
    });
    assert.equal(answer.status, 401);
  });
});
