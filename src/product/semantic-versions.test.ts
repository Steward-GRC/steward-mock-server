// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Semantic versions and change types, as steward-core stores them (steward-core#117), steward-
// workflow records the first stage's agreement (steward-workflow#71) and steward-gateway exposes
// them (steward-gateway#66): MAJOR.MINOR.FIX written at publish beside the ordinal versionNo, a
// change type suggested from the content, raised freely by the author, lowered only with a
// reason and the first stage's agreement. Templates are numbered the same way at publish.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { stewardData } from "#product/data.ts";
import { query, startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

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

const as = (personId: string) => signInAs(base, personId);

const SUBMIT = `mutation Submit(
  $policyVersionId: ID!
  $policyId: ID!
  $categoryId: ID!
  $changeType: ChangeType
  $changeTypeReason: String
) {
  submitWorkflow(
    policyVersionId: $policyVersionId
    policyId: $policyId
    categoryId: $categoryId
    ancestorCategoryIds: []
    changeType: $changeType
    changeTypeReason: $changeTypeReason
  ) {
    runId
  }
}`;

const VERSIONS = `query ($policyId: ID!) {
  policyVersions(policyId: $policyId) {
    id versionNo semanticVersion suggestedChangeType changeType requestedChangeType
    changeTypeReason changeTypeSetByUserId changeTypeAgreedByUserIds
  }
}`;

const ONE = `query ($id: ID!) {
  policyVersion(id: $id) {
    id versionNo status semanticVersion suggestedChangeType changeType requestedChangeType
    changeTypeReason changeTypeSetByUserId changeTypeAgreedByUserIds
  }
}`;

interface Version {
  changeType: null | string;
  changeTypeAgreedByUserIds: string[];
  changeTypeReason: null | string;
  changeTypeSetByUserId: null | string;
  id: string;
  requestedChangeType: null | string;
  semanticVersion: null | string;
  status: string;
  suggestedChangeType: null | string;
  versionNo: number;
}

const versionOf = async (signed: Signed, id: string) => {
  const { body } = await query(base, ONE, signed, { id });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as { policyVersion: Version }).policyVersion;
};

/** version-2, the published expenses policy at 3.0.0, is the base the edits below start from. */
const publishedContent = async (signed: Signed) =>
  (
    (await call(base, signed, "PolicyVersion", { id: "version-2" })).data
      .policyVersion as { contentJson: string }
  ).contentJson;

const FIX_EDIT = (json: string) =>
  json.replace("using the expenses page", "using the expense page");
const MINOR_EDIT = (json: string) =>
  json.replace(
    "A clear photo of the receipt is enough.",
    "A clear photo of the receipt is enough. Keep the paper copy somewhere safe for your own records, and tell your manager about anything that looks unusual in the claim.",
  );
const MAJOR_EDIT = (json: string) =>
  json.replace("within 30 days", "within 45 days");

const saveEdited = async (
  signed: Signed,
  edit: (json: string) => string,
): Promise<string> => {
  const edited = edit(await publishedContent(signed));
  const saved = await call(base, signed, "SaveDraft", {
    contentJson: edited,
    policyId: "policy-1",
    templateVersionId: "template-version-1",
  });
  assert.equal(saved.refused, undefined, JSON.stringify(saved));
  return (saved.data.saveDraft as { id: string }).id;
};

const submit = async (
  signed: Signed,
  policyVersionId: string,
  extra: { changeType?: string; changeTypeReason?: string } = {},
) => {
  const { body } = await query(base, SUBMIT, signed, {
    categoryId: "category-expenses",
    policyId: "policy-1",
    policyVersionId,
    ...extra,
  });
  return {
    kind: body.errors?.[0]?.extensions.kind,
    message: body.errors?.[0]?.message,
    refused: body.errors?.[0]?.extensions.code,
    runId: (body.data?.submitWorkflow as { runId: string } | undefined)?.runId,
  };
};

const approve = async (approver: Signed, policyVersionId: string) => {
  const tasks = (await call(base, approver, "PendingTasks")).data
    .pendingTasks as { policyVersionId: string; runId: string }[];
  const task = tasks.find((t) => t.policyVersionId === policyVersionId);
  assert.ok(task, "the approver has a task");
  const answer = await call(base, approver, "SignalWorkflow", {
    ...task,
    comment: "Reviewed.",
    signal: "SIGNAL_TYPE_APPROVE",
  });
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
};

describe("the seeded versions", () => {
  it("number each policy from 1.0.0 and bump by the change type", async () => {
    const reader = await as("user-erin");
    const { body } = await query(base, VERSIONS, reader, {
      policyId: "policy-1",
    });
    const versions = (body.data as { policyVersions: Version[] })
      .policyVersions;
    assert.deepEqual(
      versions.map((v) => [v.versionNo, v.semanticVersion, v.changeType]),
      [
        [1, "1.0.0", null],
        [2, "2.0.0", "MAJOR"],
        [3, "3.0.0", "MAJOR"],
      ],
    );
    assert.deepEqual(versions[0]?.changeTypeAgreedByUserIds, []);
  });
});

describe("a draft shows the number a publish would give", () => {
  it("is a Fix for a small wording change", async () => {
    const author = await as("user-bob");
    const id = await saveEdited(author, FIX_EDIT);
    const version = await versionOf(author, id);
    assert.equal(version.versionNo, 0);
    assert.equal(version.semanticVersion, "3.0.1");
    assert.equal(version.suggestedChangeType, "FIX");
    assert.equal(version.changeType, "FIX");
    assert.equal(version.requestedChangeType, null);
  });

  it("is a Minor for more than ten changed words", async () => {
    const author = await as("user-bob");
    const version = await versionOf(
      author,
      await saveEdited(author, MINOR_EDIT),
    );
    assert.equal(version.semanticVersion, "3.1.0");
    assert.equal(version.suggestedChangeType, "MINOR");
  });

  it("is a Major when a number changes", async () => {
    const author = await as("user-bob");
    const version = await versionOf(
      author,
      await saveEdited(author, MAJOR_EDIT),
    );
    assert.equal(version.semanticVersion, "4.0.0");
    assert.equal(version.suggestedChangeType, "MAJOR");
  });

  it("is a Major when an obligation word changes", async () => {
    const author = await as("user-bob");
    const version = await versionOf(
      author,
      await saveEdited(author, (json) =>
        json.replace(
          "Attach a receipt for every item.",
          "You must attach a receipt for every item.",
        ),
      ),
    );
    assert.equal(version.suggestedChangeType, "MAJOR");
  });

  it("follows the draft as it is edited", async () => {
    const author = await as("user-bob");
    const id = await saveEdited(author, FIX_EDIT);
    assert.equal((await versionOf(author, id)).semanticVersion, "3.0.1");
    await saveEdited(author, MAJOR_EDIT);
    assert.equal((await versionOf(author, id)).semanticVersion, "4.0.0");
  });
});

describe("publishing writes the semantic version", () => {
  it("stores the suggested number and type when the last approval publishes", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const id = await saveEdited(author, MINOR_EDIT);
    assert.equal((await submit(author, id)).refused, undefined);
    await approve(approver, id);
    const version = await versionOf(author, id);
    assert.equal(version.versionNo, 4);
    assert.equal(version.semanticVersion, "3.1.0");
    assert.equal(version.changeType, "MINOR");
    assert.equal(version.suggestedChangeType, "MINOR");
    assert.equal(version.changeTypeSetByUserId, null);
  });

  it("numbers the next version from the stored one, not the ordinal", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const first = await saveEdited(author, MINOR_EDIT);
    await submit(author, first);
    await approve(approver, first);
    const content = (
      (await call(base, author, "PolicyVersion", { id: first })).data
        .policyVersion as { contentJson: string }
    ).contentJson;
    const second = (
      (
        await call(base, author, "SaveDraft", {
          contentJson: FIX_EDIT(content),
          policyId: "policy-1",
          templateVersionId: "template-version-1",
        })
      ).data.saveDraft as { id: string }
    ).id;
    const draft = await versionOf(author, second);
    assert.equal(draft.semanticVersion, "3.1.1");
    await submit(author, second);
    await approve(approver, second);
    assert.equal((await versionOf(author, second)).semanticVersion, "3.1.1");
  });

  it("publishes a draft directly with the suggestion", async () => {
    const author = await as("user-bob");
    const id = await saveEdited(author, MAJOR_EDIT);
    const published = await call(base, author, "PublishDraft", {
      policyId: "policy-1",
    });
    assert.equal(published.refused, undefined, JSON.stringify(published));
    const version = await versionOf(author, id);
    assert.equal(version.semanticVersion, "4.0.0");
    assert.equal(version.changeType, "MAJOR");
  });

  it("gives the first version 1.0.0 and takes no pick", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const created = (
      await call(base, author, "CreatePolicy", {
        documentType: "POLICY",
        homeCategoryId: "category-expenses",
        sensitivity: "STANDARD",
        title: "Travel Booking",
      })
    ).data.createPolicy as { currentDraftVersionId: string; id: string };
    const saved = await call(base, author, "SaveDraft", {
      contentJson: await publishedContent(author),
      policyId: created.id,
    });
    assert.equal(saved.refused, undefined);
    const id = created.currentDraftVersionId;
    const draft = await versionOf(author, id);
    assert.equal(draft.semanticVersion, "1.0.0");
    assert.equal(draft.suggestedChangeType, null);
    const sent = await query(base, SUBMIT, author, {
      categoryId: "category-expenses",
      changeType: "MAJOR",
      policyId: created.id,
      policyVersionId: id,
    });
    assert.equal(sent.body.errors, undefined);
    await approve(approver, id);
    const version = await versionOf(author, id);
    assert.equal(version.semanticVersion, "1.0.0");
    assert.equal(version.changeType, null);
    assert.equal(version.changeTypeSetByUserId, null);
  });
});

describe("the author's pick at submit", () => {
  it("raises the type at once and keeps who set it", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const id = await saveEdited(author, FIX_EDIT);
    const sent = await submit(author, id, { changeType: "MAJOR" });
    assert.equal(sent.refused, undefined);
    const waiting = await versionOf(author, id);
    assert.equal(waiting.suggestedChangeType, "FIX");
    assert.equal(waiting.changeType, "MAJOR");
    assert.equal(waiting.changeTypeSetByUserId, "user-bob");
    assert.equal(waiting.requestedChangeType, null);
    assert.equal(waiting.semanticVersion, "4.0.0");
    await approve(approver, id);
    assert.equal((await versionOf(author, id)).semanticVersion, "4.0.0");
  });

  it("refuses a lowering with no reason and leaves the version a draft", async () => {
    const author = await as("user-bob");
    const id = await saveEdited(author, MAJOR_EDIT);
    const sent = await submit(author, id, { changeType: "FIX" });
    assert.equal(sent.refused, "InvalidArgument");
    assert.equal(
      sent.message,
      "submit: a reason is required to set the change type below the suggested one",
    );
    assert.equal(sent.kind, "business");
    assert.equal(sent.runId, undefined);
    assert.equal((await versionOf(author, id)).status, "DRAFT");
    const blank = await submit(author, id, {
      changeType: "MINOR",
      changeTypeReason: " ".repeat(3),
    });
    assert.equal(blank.refused, "InvalidArgument");
    assert.equal(
      stewardData().runs.filter((r) => r.policyVersionId === id).length,
      0,
    );
  });

  it("holds a lowering as a request until the first stage agrees, then applies it", async () => {
    const author = await as("user-bob");
    const approver = await as("user-charlie");
    const id = await saveEdited(author, MAJOR_EDIT);
    const sent = await submit(author, id, {
      changeType: "MINOR",
      changeTypeReason: "The extra days are a courtesy, not a rule change.",
    });
    assert.equal(sent.refused, undefined, sent.message);
    const waiting = await versionOf(author, id);
    assert.equal(waiting.suggestedChangeType, "MAJOR");
    assert.equal(waiting.changeType, "MAJOR");
    assert.equal(waiting.requestedChangeType, "MINOR");
    assert.equal(
      waiting.changeTypeReason,
      "The extra days are a courtesy, not a rule change.",
    );
    assert.equal(waiting.semanticVersion, "4.0.0");
    assert.deepEqual(waiting.changeTypeAgreedByUserIds, []);

    await approve(approver, id);
    const version = await versionOf(author, id);
    assert.equal(version.changeType, "MINOR");
    assert.equal(version.requestedChangeType, null);
    assert.deepEqual(version.changeTypeAgreedByUserIds, ["user-charlie"]);
    assert.equal(version.semanticVersion, "3.1.0");
  });

  it("applies the lowering when the first stage's quorum is met, not on the first of two approvals", async () => {
    // version-4's run has two stages; its first wants a majority of two approvers.
    const data = stewardData();
    const version = data.versions.find((v) => v.id === "version-4")!;
    version.change = {
      agreedBy: [],
      reason: "A small change.",
      requested: "FIX",
      setBy: "user-bob",
      suggested: "MAJOR",
      type: "MAJOR",
    };
    const author = await as("user-bob");
    const charlie = await as("user-charlie");
    const alice = await as("user-alice");
    const run = { policyVersionId: "version-4", runId: "run-1" };
    const decide = (who: Signed, taskId: string) =>
      call(base, who, "SignalWorkflow", {
        ...run,
        comment: "Reviewed.",
        signal: "SIGNAL_TYPE_APPROVE",
        taskId,
      });
    assert.equal((await decide(charlie, "task-1")).refused, undefined);
    assert.equal(version.change.requested, "FIX");
    assert.deepEqual(version.change.agreedBy, []);
    assert.equal((await decide(alice, "task-2")).refused, undefined);
    assert.equal(version.change?.requested, null);
    assert.equal(version.change?.type, "FIX");
    assert.deepEqual(version.change?.agreedBy.toSorted(), [
      "user-alice",
      "user-charlie",
    ]);
    assert.ok(author);
  });

  it("keeps the request when the draft is sent again with no pick", async () => {
    const author = await as("user-bob");
    const id = await saveEdited(author, MAJOR_EDIT);
    await submit(author, id, {
      changeType: "MINOR",
      changeTypeReason: "A courtesy.",
    });
    const again = await submit(author, id);
    assert.equal(again.refused, undefined, again.message);
    const version = await versionOf(author, id);
    assert.equal(version.requestedChangeType, "MINOR");
    assert.equal(version.changeTypeReason, "A courtesy.");
  });
});

const TEMPLATES = `query {
  templates { id updatedAt }
}`;
const TEMPLATE_VERSIONS = `query ($templateId: ID!) {
  templateVersions(templateId: $templateId) {
    id versionNo status semanticVersion changeType createdAt publishedAt
  }
}`;

interface TemplateVersionRow {
  changeType: null | string;
  createdAt: null | string;
  id: string;
  publishedAt: null | string;
  semanticVersion: null | string;
  status: string;
  versionNo: number;
}

const templateVersions = async (signed: Signed, templateId: string) => {
  const { body } = await query(base, TEMPLATE_VERSIONS, signed, {
    templateId,
  });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as { templateVersions: TemplateVersionRow[] })
    .templateVersions;
};

const publishTemplateVersion = async (signed: Signed, id: string) => {
  const { body } = await query(
    base,
    `mutation ($id: ID!) { publishTemplateVersion(id: $id) { id } }`,
    signed,
    { id },
  );
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
};

const updatedAtOf = async (signed: Signed, id: string) => {
  const { body } = await query(base, TEMPLATES, signed);
  return (
    body.data as { templates: { id: string; updatedAt: null | string }[] }
  ).templates.find((t) => t.id === id)?.updatedAt;
};

const sections = (extra: { required: boolean; title: string }) => [
  {
    blocks: [],
    key: "purpose",
    order: 0,
    required: true,
    title: "Purpose",
  },
  { blocks: [], key: "scope", order: 1, required: true, title: "Scope" },
  {
    blocks: [],
    key: "policy-statement",
    order: 2,
    required: true,
    title: extra.title,
  },
  {
    blocks: [],
    key: "approval",
    order: 3,
    required: extra.required,
    title: "Approval",
  },
];

describe("template versions", () => {
  it("are seeded at 1.0.0 with their times, and a draft has none", async () => {
    const admin = await as("user-alice");
    const versions = await templateVersions(admin, "template-1");
    const published = versions.find((v) => v.status === "published");
    assert.equal(published?.semanticVersion, "1.0.0");
    assert.ok(published?.createdAt);
    assert.ok(published?.publishedAt);
    const draft = versions.find((v) => v.status === "draft");
    assert.equal(draft?.semanticVersion, null);
    assert.equal(draft?.publishedAt, null);
    assert.ok(await updatedAtOf(admin, "template-1"));
  });

  it("number at publish from the section change: an optional section is a Minor", async () => {
    const admin = await as("user-alice");
    const before = await updatedAtOf(admin, "template-1");
    await publishTemplateVersion(admin, "template-version-3");
    const published = (await templateVersions(admin, "template-1")).find(
      (v) => v.id === "template-version-3",
    );
    assert.equal(published?.semanticVersion, "1.1.0");
    assert.equal(published?.changeType, "MINOR");
    assert.ok(published?.publishedAt);
    assert.ok((await updatedAtOf(admin, "template-1")) !== before);
  });

  it("raise the first number for a required section and the third for a retitle", async () => {
    const admin = await as("user-alice");
    const create = async (input: ReturnType<typeof sections>) => {
      const { body } = await query(
        base,
        `mutation ($templateId: ID!, $sections: [SectionInput!]!) {
          createTemplateVersion(templateId: $templateId, sections: $sections) { id }
        }`,
        admin,
        { sections: input, templateId: "template-1" },
      );
      assert.equal(body.errors, undefined, JSON.stringify(body.errors));
      return (body.data as { createTemplateVersion: { id: string } })
        .createTemplateVersion.id;
    };
    const major = await create(
      sections({ required: true, title: "Policy statement" }),
    );
    await publishTemplateVersion(admin, major);
    let rows = await templateVersions(admin, "template-1");
    assert.equal(rows.find((v) => v.id === major)?.semanticVersion, "2.0.0");
    const fix = await create(
      sections({ required: true, title: "The policy statement" }),
    );
    await publishTemplateVersion(admin, fix);
    rows = await templateVersions(admin, "template-1");
    const row = rows.find((v) => v.id === fix);
    assert.equal(row?.semanticVersion, "2.0.1");
    assert.equal(row?.changeType, "FIX");
  });
});
