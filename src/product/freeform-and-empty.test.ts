// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A freeform policy starts blank, a category's default template is what a policy starts from when
// none is chosen, and a document with no text can never be submitted for approval. The reference
// for the Go services (steward-core, steward-gateway).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { startForTests, startFresh } from "#product/test-client.ts";
import { call, signInAs } from "#product/web-client.ts";

const FINANCE = "category-finance";

interface Created {
  currentDraftVersionId: string;
  id: string;
  templateId: null | string;
  templateNone: boolean;
}
interface Version {
  contentJson: string;
  templateVersionId: string;
}

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

const bob = () => signInAs(base, "user-bob");

const create = async (templateId: null | string = null): Promise<Created> => {
  const answer = await call(base, await bob(), "CreatePolicy", {
    homeCategoryId: FINANCE,
    sensitivity: "STANDARD",
    templateId,
    title: "Hello",
  });
  assert.equal(answer.refused, undefined, JSON.stringify(answer));
  return answer.data.createPolicy as Created;
};

const versionOf = async (id: string): Promise<Version> =>
  (await call(base, await bob(), "PolicyVersion", { id })).data
    .policyVersion as Version;

const texts = (contentJson: string): string[] => {
  const found: string[] = [];
  const walk = (node: { children?: unknown[]; text?: unknown }) => {
    if (typeof node.text === "string") found.push(node.text);
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk((JSON.parse(contentJson) as { root: object }).root);
  return found.filter((text) => text.trim() !== "");
};

const text = (value: string) =>
  JSON.stringify({
    root: {
      children: [
        { children: [{ text: value, type: "text" }], type: "paragraph" },
      ],
      type: "root",
    },
  });

const submit = async (policy: Created) =>
  call(base, await bob(), "SubmitWorkflow", {
    ancestorCategoryIds: [],
    categoryId: FINANCE,
    policyId: policy.id,
    policyVersionId: policy.currentDraftVersionId,
  });

describe("the template a new policy starts from", () => {
  it("is the category's default when none is chosen", async () => {
    const policy = await create();
    const version = await versionOf(policy.currentDraftVersionId);
    assert.equal(version.templateVersionId, "template-version-1");
    assert.ok(texts(version.contentJson).includes("Purpose"));
  });
});

describe("making a policy freeform", () => {
  it("blanks the untouched starting draft, drops its template and marks the policy freeform", async () => {
    const policy = await create();
    const answer = await call(base, await bob(), "SetPolicyTemplate", {
      none: true,
      policyId: policy.id,
    });
    assert.equal(answer.refused, undefined, JSON.stringify(answer));
    const changed = answer.data.setPolicyTemplate as Created;
    assert.equal(changed.templateNone, true);
    assert.equal(changed.templateId, null);
    const version = await versionOf(policy.currentDraftVersionId);
    assert.equal(version.templateVersionId, "");
    assert.deepEqual(texts(version.contentJson), []);
  });

  it("leaves a draft the author has already written alone", async () => {
    const policy = await create();
    await call(base, await bob(), "SaveDraft", {
      contentJson: text("My own words."),
      policyId: policy.id,
    });
    await call(base, await bob(), "SetPolicyTemplate", {
      none: true,
      policyId: policy.id,
    });
    const version = await versionOf(policy.currentDraftVersionId);
    assert.deepEqual(texts(version.contentJson), ["My own words."]);
  });

  it("starts the untouched draft from another template when one is chosen", async () => {
    const policy = await create();
    const answer = await call(base, await bob(), "SetPolicyTemplate", {
      none: false,
      policyId: policy.id,
      templateId: "template-3",
    });
    assert.equal(answer.refused, undefined, JSON.stringify(answer));
    assert.equal(
      (answer.data.setPolicyTemplate as Created).templateId,
      "template-3",
    );
    const version = await versionOf(policy.currentDraftVersionId);
    assert.notEqual(version.templateVersionId, "template-version-1");
    assert.notEqual(version.templateVersionId, "");
  });

  it("is for the policy's authors only", async () => {
    const policy = await create();
    const refused = await call(
      base,
      await signInAs(base, "user-erin"),
      "SetPolicyTemplate",
      {
        none: true,
        policyId: policy.id,
      },
    );
    assert.notEqual(refused.refused, undefined);
  });
});

describe("submitting a document with no text", () => {
  it("is refused when the document holds no text, spaces alone included", async () => {
    const policy = await create();
    await call(base, await bob(), "SetPolicyTemplate", {
      none: true,
      policyId: policy.id,
    });
    const blank = await submit(policy);
    assert.equal(blank.refused, "FailedPrecondition");
    await call(base, await bob(), "SaveDraft", {
      contentJson: text(" ".repeat(3)),
      policyId: policy.id,
    });
    assert.equal((await submit(policy)).refused, "FailedPrecondition");
  });

  it("goes through with one character of text", async () => {
    const policy = await create();
    await call(base, await bob(), "SetPolicyTemplate", {
      none: true,
      policyId: policy.id,
    });
    await call(base, await bob(), "SaveDraft", {
      contentJson: text("x"),
      policyId: policy.id,
    });
    const answer = await submit(policy);
    assert.notEqual(
      answer.refused,
      "FailedPrecondition",
      JSON.stringify(answer),
    );
  });
});

describe("a new draft of a published policy (core's appendix copier)", () => {
  interface Appendix {
    contentJson: string;
    id: string;
    letter: string;
    orderIndex: number;
    policyVersionId: string;
    title: string;
  }
  const appendicesOf = async (versionId: string): Promise<Appendix[]> => {
    const answer = await call(base, await bob(), "PolicyVersion", {
      id: versionId,
    });
    return (answer.data.policyVersion as { appendices: Appendix[] }).appendices;
  };

  it("starts with copies of the published version's appendices", async () => {
    const saved = await call(base, await bob(), "SaveDraft", {
      contentJson: text("Edited."),
      policyId: "policy-1",
      templateVersionId: "template-version-1",
    });
    assert.equal(saved.refused, undefined, JSON.stringify(saved));
    const draftId = (saved.data.saveDraft as { id: string }).id;
    const published = await appendicesOf("version-2");
    const copied = await appendicesOf(draftId);
    assert.ok(published.length > 0, "the published version has an appendix");
    assert.deepEqual(
      copied.map((a) => [a.letter, a.title, a.contentJson, a.orderIndex]),
      published.map((a) => [a.letter, a.title, a.contentJson, a.orderIndex]),
    );
    // copies, not the same rows: each belongs to the draft and has its own id
    assert.ok(copied.every((a) => a.policyVersionId === draftId));
    assert.ok(copied.every((a) => !published.some((p) => p.id === a.id)));
  });

  it("lets the author change the copy without touching the published appendix", async () => {
    const saved = await call(base, await bob(), "SaveDraft", {
      contentJson: text("Edited."),
      policyId: "policy-1",
    });
    const draftId = (saved.data.saveDraft as { id: string }).id;
    const [copy] = await appendicesOf(draftId);
    await call(base, await bob(), "UpdateAppendix", {
      contentJson: JSON.stringify({ text: "New rates." }),
      id: copy!.id,
      title: "Per-diem rates (2027)",
    });
    const [published] = await appendicesOf("version-2");
    assert.equal(published?.title, "Per-diem rates");
  });

  it("does not copy again when the same draft is saved again", async () => {
    const first = await call(base, await bob(), "SaveDraft", {
      contentJson: text("One."),
      policyId: "policy-1",
    });
    const draftId = (first.data.saveDraft as { id: string }).id;
    await call(base, await bob(), "SaveDraft", {
      contentJson: text("Two."),
      policyId: "policy-1",
    });
    assert.equal(
      (await appendicesOf(draftId)).length,
      (await appendicesOf("version-2")).length,
    );
  });
});
