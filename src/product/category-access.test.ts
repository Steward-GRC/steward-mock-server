// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Category access (steward-web's A5): each category's own RACI rules, as steward-core stores them
// and steward-gateway answers them, the access simulator, which decides with the ordered engine
// the way the gateway does (per action, top-down, strict; owners people only; root always holds
// Read, Author and Manage), and resolveUserLabels for the people the rules name.

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

const RULE = "subjectKind subjectRef read ack approve author manage";

const RULESET = `query ($categoryId: ID!) {
  categoryRuleset(categoryId: $categoryId) { categoryId rules { ${RULE} } }
}`;

const SET = `mutation ($categoryId: ID!, $rules: [RaciRuleInput!]!) {
  setCategoryRuleset(categoryId: $categoryId, rules: $rules) { categoryId rules { ${RULE} } }
}`;

const SIMULATE = `query ($categoryId: ID!, $userId: ID!, $draftRules: [RaciRuleInput!]) {
  simulateCategory(categoryId: $categoryId, userId: $userId, draftRules: $draftRules) {
    read readReason readCode ack ackReason ackCode approve approveReason approveCode
    author authorReason authorCode manage manageReason manageCode
    configuredBlock { action categoryId subjectKind subjectRef }
  }
}`;

const LABELS = `query ($ids: [ID!]!) { resolveUserLabels(ids: $ids) { id name email } }`;

const rule = (
  subjectKind: string,
  subjectReference: string,
  [read, ack, approve, author, manage = "BLANK"]: string[],
) => ({
  ack,
  approve,
  author,
  manage,
  read,
  subjectKind,
  subjectRef: subjectReference,
});

const BLOCKED =
  "blocked: a deny for user user-alice in Leave is configured, but root is always allowed and ignores it";

const block = (action: string) => ({
  action,
  categoryId: "category-leave",
  subjectKind: "USER",
  subjectRef: "user-alice",
});

const ALLOW_ALL = ["ALLOW", "ALLOW", "ALLOW", "ALLOW", "ALLOW"];
const READ_ONLY = ["ALLOW", "BLANK", "BLANK", "BLANK"];

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

type Verdict = Record<string, unknown>;

const simulate = async (
  categoryId: string,
  userId: string,
  draftRules?: unknown[],
): Promise<Verdict> =>
  (
    await ask(await admin(), SIMULATE, {
      categoryId,
      draftRules,
      userId,
    })
  ).data.simulateCategory as Verdict;

/** A decision's three fields per action: the flag, the human reason and the structured code. */
const cell = (allowed: boolean, reason: string, code: string) => ({
  allowed,
  code,
  reason,
});
const part = (verdict: Verdict, action: string) =>
  cell(
    verdict[action] as boolean,
    verdict[`${action}Reason`] as string,
    verdict[`${action}Code`] as string,
  );

describe("categoryRuleset", () => {
  it("answers each category's own rules, top-down, with a Manage cell", async () => {
    assert.deepEqual(await rulesOf("category-facilities"), {
      categoryId: "category-facilities",
      rules: [
        rule("GROUP", "Facilities team", ALLOW_ALL),
        rule("GROUP", "All staff", ["ALLOW", "ALLOW", "BLANK", "DENY"]),
      ],
    });
    assert.deepEqual(await rulesOf("category-workplace"), {
      categoryId: "category-workplace",
      rules: [rule("EVERYONE", "", READ_ONLY)],
    });
    assert.deepEqual(await rulesOf("category-expenses"), {
      categoryId: "category-expenses",
      rules: [
        rule("GROUP", "Finance team", ALLOW_ALL),
        rule("USER", "user-erin", ["BLANK", "BLANK", "DENY", "DENY"]),
        rule("GROUP", "All staff", READ_ONLY),
      ],
    });
  });

  it("starts every top-level category with the rule Everyone: Read", async () => {
    for (const id of [
      "category-finance",
      "category-people",
      "category-information",
      "category-workplace",
    ])
      assert.deepEqual(
        (await rulesOf(id)) as { rules: unknown[] },
        { categoryId: id, rules: [rule("EVERYONE", "", READ_ONLY)] },
        id,
      );
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
      rule("USER", "user-bob", ["ALLOW", "BLANK", "BLANK", "ALLOW", "ALLOW"]),
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

  it("leaves Manage blank when a client that doesn't know it omits the cell", async () => {
    const { code, data } = await ask(
      await admin(),
      `mutation ($rules: [RaciRuleInput!]!) {
        setCategoryRuleset(categoryId: "category-travel", rules: $rules) { rules { ${RULE} } }
      }`,
      {
        rules: [
          {
            ack: "BLANK",
            approve: "BLANK",
            author: "ALLOW",
            read: "ALLOW",
            subjectKind: "USER",
            subjectRef: "user-bob",
          },
        ],
      },
    );
    assert.equal(code, undefined);
    assert.deepEqual(data.setCategoryRuleset, {
      rules: [rule("USER", "user-bob", ["ALLOW", "BLANK", "BLANK", "ALLOW"])],
    });
  });

  it("audits each rule created, changed (a Manage cell included) or removed", async () => {
    await ask(await admin(), SET, {
      categoryId: "category-facilities",
      rules: [
        rule("GROUP", "Facilities team", ["ALLOW", "ALLOW", "ALLOW", "ALLOW"]),
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

  it("clears the reference an Everyone row carries, as the gateway does", async () => {
    const { code, data } = await ask(await admin(), SET, {
      categoryId: "category-facilities",
      rules: [rule("EVERYONE", "someone", ALLOW_ALL)],
    });
    assert.equal(code, undefined);
    assert.deepEqual(data.setCategoryRuleset, {
      categoryId: "category-facilities",
      rules: [rule("EVERYONE", "", ALLOW_ALL)],
    });
  });

  it("refuses a group or user rule without a subject and keeps the old rules", async () => {
    for (const bad of [
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
  it("lets the Facilities team do everything in Facilities, Manage included", async () => {
    const verdict = await simulate("category-facilities", "user-erin");
    const why = "allowed by group Facilities team in Facilities";
    for (const action of ["read", "ack", "approve", "author", "manage"])
      assert.deepEqual(part(verdict, action), cell(true, why, "ENTRY"), action);
    assert.deepEqual(verdict.configuredBlock, []);
  });

  it("lets all staff read and acknowledge Facilities, and not author", async () => {
    const verdict = await simulate("category-facilities", "user-bob");
    const staff = "by group All staff in Facilities";
    assert.deepEqual(
      part(verdict, "read"),
      cell(true, `allowed ${staff}`, "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "ack"),
      cell(true, `allowed ${staff}`, "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "author"),
      cell(false, `denied ${staff}`, "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "approve"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
    assert.deepEqual(
      part(verdict, "manage"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
  });

  it("answers the baseline for no one in particular from the inherited Everyone row", async () => {
    const verdict = await simulate("category-facilities", "");
    assert.deepEqual(
      part(verdict, "read"),
      cell(true, "allowed by Everyone in Workplace", "ENTRY"),
    );
    for (const action of ["ack", "approve", "author", "manage"])
      assert.deepEqual(
        part(verdict, action),
        cell(false, "denied: no rule decides", "DEFAULT_DENY"),
        action,
      );
  });

  it("applies a person's own row, strictly, per action", async () => {
    const verdict = await simulate("category-expenses", "user-erin");
    assert.deepEqual(
      part(verdict, "read"),
      cell(true, "allowed by group All staff in Expenses", "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "approve"),
      cell(false, "denied by user user-erin in Expenses", "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "author"),
      cell(false, "denied by user user-erin in Expenses", "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "ack"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
  });

  it("gives an owner Read, Author, Approve and Manage over a deny, and not Ack", async () => {
    // Charlie owns Information; a deny of everything for him in Devices doesn't matter.
    const draft = [
      rule("USER", "user-charlie", ["DENY", "DENY", "DENY", "DENY", "DENY"]),
    ];
    const verdict = await simulate("category-devices", "user-charlie", draft);
    const owner = "allowed: owner of the category or a parent";
    for (const action of ["read", "author", "approve", "manage"])
      assert.deepEqual(
        part(verdict, action),
        cell(true, owner, "OWNER"),
        action,
      );
    assert.deepEqual(
      part(verdict, "ack"),
      cell(false, "denied by user user-charlie in Devices", "ENTRY"),
    );
  });

  it("holds the root account to Read, Author and Manage always, and Approve and Ack to the rows", async () => {
    // Alice is root and owns Finance only; People has no owner, so only root applies there.
    const verdict = await simulate("category-leave", "user-alice");
    assert.deepEqual(
      part(verdict, "read"),
      cell(true, "allowed: root", "ROOT"),
    );
    assert.deepEqual(
      part(verdict, "author"),
      cell(true, "allowed: root", "ROOT"),
    );
    assert.deepEqual(
      part(verdict, "manage"),
      cell(true, "allowed: root", "ROOT"),
    );
    assert.deepEqual(
      part(verdict, "approve"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
    assert.deepEqual(
      part(verdict, "ack"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
    assert.deepEqual(verdict.configuredBlock, []);
  });

  it("saves a deny against root on Read, Author and Manage, shows it as blocked and never applies it", async () => {
    const draft = [
      rule("USER", "user-alice", ["DENY", "BLANK", "DENY", "DENY", "DENY"]),
    ];
    const verdict = await simulate("category-leave", "user-alice", draft);
    assert.deepEqual(part(verdict, "read"), cell(true, BLOCKED, "ROOT"));
    assert.deepEqual(part(verdict, "author"), cell(true, BLOCKED, "ROOT"));
    assert.deepEqual(part(verdict, "manage"), cell(true, BLOCKED, "ROOT"));
    // Approve follows the rows for root, so its deny applies and is not listed.
    assert.deepEqual(
      part(verdict, "approve"),
      cell(false, "denied by user user-alice in Leave", "ENTRY"),
    );
    assert.deepEqual(verdict.configuredBlock, [
      block("READ"),
      block("AUTHOR"),
      block("MANAGE"),
    ]);
  });

  it("lets root's Approve and Ack come from a row that allows them", async () => {
    const draft = [
      rule("USER", "user-alice", ["BLANK", "ALLOW", "ALLOW", "BLANK"]),
    ];
    const verdict = await simulate("category-leave", "user-alice", draft);
    assert.deepEqual(
      part(verdict, "approve"),
      cell(true, "allowed by user user-alice in Leave", "ENTRY"),
    );
    assert.deepEqual(
      part(verdict, "ack"),
      cell(true, "allowed by user user-alice in Leave", "ENTRY"),
    );
  });

  it("makes a site admin who is not root follow the rows, even a deny", async () => {
    const charlie = stewardData().people.find((p) => p.id === "user-charlie")!;
    charlie.roles.push("site-admin");
    const draft = [
      rule("USER", "user-charlie", ["DENY", "BLANK", "BLANK", "BLANK"]),
    ];
    const verdict = await simulate("category-leave", "user-charlie", draft);
    assert.deepEqual(
      part(verdict, "read"),
      cell(false, "denied by user user-charlie in Leave", "ENTRY"),
    );
    assert.deepEqual(verdict.configuredBlock, []);
  });

  it("matches a group name exactly, case included", async () => {
    // Bob is in "All staff"; a row for "all staff" is a different group.
    const lower = [
      rule("GROUP", "all staff", ["BLANK", "BLANK", "BLANK", "ALLOW"]),
    ];
    assert.deepEqual(
      part(await simulate("category-travel", "user-bob", lower), "author"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
    const exact = [
      rule("GROUP", "All staff", ["BLANK", "BLANK", "BLANK", "ALLOW"]),
    ];
    assert.deepEqual(
      part(await simulate("category-travel", "user-bob", exact), "author"),
      cell(true, "allowed by group All staff in Travel", "ENTRY"),
    );
  });

  it("gates Ack on Read, and lets Author or Manage confer Read over a deny", async () => {
    const gated = [
      rule("USER", "user-dave", ["DENY", "ALLOW", "BLANK", "BLANK"]),
    ];
    const denied = await simulate("category-travel", "user-dave", gated);
    assert.deepEqual(
      part(denied, "read"),
      cell(false, "denied by user user-dave in Travel", "ENTRY"),
    );
    assert.deepEqual(
      part(denied, "ack"),
      cell(false, "denied: requires read", "REQUIRES"),
    );
    const author = [
      rule("USER", "user-dave", ["DENY", "ALLOW", "BLANK", "ALLOW"]),
    ];
    const conferred = await simulate("category-travel", "user-dave", author);
    assert.deepEqual(
      part(conferred, "read"),
      cell(true, "allowed by user user-dave in Travel", "ENTRY"),
    );
    assert.deepEqual(
      part(conferred, "ack"),
      cell(true, "allowed by user user-dave in Travel", "ENTRY"),
    );
    assert.deepEqual(
      part(conferred, "manage"),
      cell(false, "denied: no rule decides", "DEFAULT_DENY"),
    );
    const manage = [
      rule("USER", "user-dave", ["DENY", "BLANK", "DENY", "DENY", "ALLOW"]),
    ];
    const managed = await simulate("category-travel", "user-dave", manage);
    for (const action of ["read", "author", "manage"])
      assert.equal(managed[action], true, action);
    assert.equal(managed.approve, false);
  });

  it("previews draft rules without saving them", async () => {
    const draft = [rule("USER", "user-bob", ALLOW_ALL)];
    const preview = await simulate("category-facilities", "user-bob", draft);
    assert.equal(
      preview.authorReason,
      "allowed by user user-bob in Facilities",
    );
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
