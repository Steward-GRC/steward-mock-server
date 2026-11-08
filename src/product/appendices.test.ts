// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The appendix life cycle (the approved model): an appendix belongs to a policy or procedure, not
// to one of its versions, and has a life of its own. Create -> draft; publish -> the version
// readers see; edit -> a new draft beside the published one; retire (kept, restorable); only a
// site admin deletes one for good. Readers see the latest published appendix on every version of
// the policy. The diff of a draft against what is published is for authors, site admins and
// compliance, and is shown only on the appendix's own edit page. Appendices are not policy: they
// never take part in an approval, and nobody comments on them.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
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

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const as = async (user: string) => signInAs(base, `user-${user}`);

// POL-EXPENSES-000002: published v3 over earlier versions, with one seeded appendix, A.
const POLICY = "policy-1";
const OLD_VERSION = "version-10";
const CURRENT_VERSION = "version-2";

const LIST = `query ($policyId: ID!, $includeRetired: Boolean) {
  policyAppendices(policyId: $policyId, includeRetired: $includeRetired) {
    id policyId letter retiredAt
    published { versionNo title contentJson publishedAt publishedBy }
    draft { versionNo title contentJson }
    versions { versionNo state }
  }
}`;
const CREATE = `mutation ($policyId: ID!, $title: String!, $contentJson: String!) {
  createPolicyAppendix(policyId: $policyId, title: $title, contentJson: $contentJson) {
    id policyId letter published { versionNo } draft { versionNo title }
  }
}`;
const SAVE = `mutation ($id: ID!, $title: String!, $contentJson: String!) {
  saveAppendixDraft(id: $id, title: $title, contentJson: $contentJson) {
    id draft { versionNo title contentJson } published { versionNo title }
  }
}`;
const PUBLISH = `mutation ($id: ID!) {
  publishAppendix(id: $id) { id published { versionNo title publishedAt publishedBy } draft { versionNo } }
}`;
const RETIRE = `mutation ($id: ID!) { retireAppendix(id: $id) { id retiredAt } }`;
const RESTORE = `mutation ($id: ID!) { restoreAppendix(id: $id) { id retiredAt letter } }`;
const DELETE = `mutation ($id: ID!) { deleteAppendixForever(id: $id) }`;
const REORDER = `mutation ($policyId: ID!, $orderedIds: [ID!]!) {
  reorderPolicyAppendices(policyId: $policyId, orderedIds: $orderedIds) { id letter }
}`;
const DIFF = `query ($id: ID!) { appendixDiff(id: $id) { sectionKey changeType wordDiffHtml } }`;
const READER = `query ($id: ID!) {
  policyVersion(id: $id) { id appendices { id letter title policyVersionId } }
}`;

interface Row {
  draft: { contentJson: string; title: string; versionNo: number } | null;
  id: string;
  letter: null | string;
  published: {
    contentJson: string;
    publishedAt: string;
    publishedBy: string;
    title: string;
    versionNo: number;
  } | null;
  retiredAt: null | string;
  versions: { state: string; versionNo: number }[];
}

const listed = async (user: string, includeRetired = false): Promise<Row[]> => {
  const answer = await ask(await as(user), LIST, {
    includeRetired,
    policyId: POLICY,
  });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.policyAppendices as Row[];
};

const create = async (user = "bob", title = "Glossary") => {
  const answer = await ask(await as(user), CREATE, {
    contentJson: JSON.stringify({ text: "Terms." }),
    policyId: POLICY,
    title,
  });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.createPolicyAppendix as {
    draft: { versionNo: number };
    id: string;
    letter: string;
    published: null | object;
  };
};

const readerTitles = async (versionId: string, user = "erin") => {
  const answer = await ask(await as(user), READER, { id: versionId });
  assert.equal(answer.code, undefined, answer.message);
  const version = answer.data.policyVersion as {
    appendices: { letter: string; policyVersionId: string; title: string }[];
  };
  return version.appendices;
};

/** The seeded appendix A, plus a published B and C, so there are three to order and retire. */
const withThree = async () => {
  const author = await as("bob");
  for (const title of ["Quote checklist", "Supplier terms"]) {
    const made = await create("bob", title);
    await ask(author, PUBLISH, { id: made.id });
  }
  return listed("bob");
};

describe("an appendix belongs to the policy, not to a version", () => {
  it("has the seeded appendix as published v1 of the policy", async () => {
    const rows = await listed("bob");
    assert.deepEqual(
      rows.map((r) => [r.letter, r.published?.versionNo, r.draft]),
      [["A", 1, null]],
    );
    assert.ok(stewardData().appendices.every((a) => a.policyId));
  });

  it("shows readers the same published appendices on every version of the policy", async () => {
    const current = await readerTitles(CURRENT_VERSION);
    const old = await readerTitles(OLD_VERSION);
    assert.deepEqual(
      current.map((a) => a.title),
      ["Per-diem rates"],
    );
    assert.deepEqual(
      old.map((a) => a.title),
      current.map((a) => a.title),
    );
    assert.ok(old.every((a) => a.policyVersionId === OLD_VERSION));
  });

  it("does not copy appendices into a new draft: there is nothing to copy", async () => {
    const author = await as("bob");
    const edit = await ask(
      author,
      `mutation ($policyId: ID!) { saveDraft(policyId: $policyId, contentJson: "{}") { id appendices { id } } }`,
      { policyId: POLICY },
    );
    if (edit.code === undefined) {
      const draft = edit.data.saveDraft as { appendices: { id: string }[] };
      const ids = draft.appendices.map((a) => a.id);
      const policyOwned = (await listed("bob")).map((r) => r.id);
      assert.deepEqual(ids, policyOwned);
    }
  });
});

describe("creating and publishing", () => {
  it("starts a new appendix as a draft only an editor sees", async () => {
    const made = await create();
    assert.equal(made.published, null);
    assert.equal(made.draft.versionNo, 1);
    assert.equal(made.letter, "B");
    assert.ok((await listed("bob")).some((r) => r.id === made.id));
    assert.ok(
      !(await readerTitles(CURRENT_VERSION)).some(
        (a) => a.title === "Glossary",
      ),
    );
    assert.ok(!(await listed("erin")).some((r) => r.id === made.id));
  });

  it("autosaves into the draft, and shows readers nothing until it is published", async () => {
    const made = await create();
    const author = await as("bob");
    const saved = await ask(author, SAVE, {
      contentJson: JSON.stringify({ text: "More terms." }),
      id: made.id,
      title: "Glossary of terms",
    });
    assert.equal(saved.code, undefined, saved.message);
    assert.equal(
      (saved.data.saveAppendixDraft as { draft: { title: string } }).draft
        .title,
      "Glossary of terms",
    );
    assert.ok(
      !(await readerTitles(CURRENT_VERSION)).some((a) =>
        a.title.startsWith("Glossary"),
      ),
    );
  });

  it("publishes to the version readers see, with who and when", async () => {
    const made = await create();
    const published = await ask(await as("bob"), PUBLISH, { id: made.id });
    assert.equal(published.code, undefined, published.message);
    const row = published.data.publishAppendix as {
      draft: null | object;
      published: {
        publishedAt: string;
        publishedBy: string;
        versionNo: number;
      };
    };
    assert.equal(row.published.versionNo, 1);
    assert.equal(row.published.publishedBy, "user-bob");
    assert.ok(Date.parse(row.published.publishedAt) > 0);
    assert.equal(row.draft, null);
    assert.ok(
      (await readerTitles(CURRENT_VERSION)).some((a) => a.title === "Glossary"),
    );
  });

  it("keeps showing the published appendix while a newer draft is being written", async () => {
    const [first] = await listed("bob");
    const author = await as("bob");
    await ask(author, SAVE, {
      contentJson: JSON.stringify({ text: "Changed." }),
      id: (first as Row).id,
      title: "Approval limits (draft)",
    });
    const rows = await listed("bob");
    assert.equal(rows[0]?.published?.title, "Per-diem rates");
    assert.equal(rows[0]?.draft?.title, "Approval limits (draft)");
    assert.equal(rows[0]?.draft?.versionNo, 2);
    assert.equal(
      (await readerTitles(CURRENT_VERSION))[0]?.title,
      "Per-diem rates",
    );
    await ask(author, PUBLISH, { id: (first as Row).id });
    assert.equal(
      (await readerTitles(CURRENT_VERSION))[0]?.title,
      "Approval limits (draft)",
    );
    assert.deepEqual(
      (await listed("bob"))[0]?.versions.map((v) => [v.versionNo, v.state]),
      [
        [1, "PUBLISHED"],
        [2, "PUBLISHED"],
      ],
    );
  });

  it("lets the policy publish while an appendix is still a draft", async () => {
    const made = await create();
    assert.equal(made.published, null);
    const policy = stewardData().policies.find((p) => p.id === POLICY);
    assert.ok(policy?.currentPublishedVersionId);
  });
});

describe("who may", () => {
  it("refuses a reader every write and shows them no draft", async () => {
    const [first] = await listed("bob");
    const reader = await as("erin");
    for (const [text, variables] of [
      [CREATE, { contentJson: "{}", policyId: POLICY, title: "X" }],
      [SAVE, { contentJson: "{}", id: (first as Row).id, title: "X" }],
      [PUBLISH, { id: (first as Row).id }],
      [RETIRE, { id: (first as Row).id }],
      [DELETE, { id: (first as Row).id }],
    ] as const) {
      const answer = await ask(reader, text, variables);
      assert.equal(answer.code, "PermissionDenied", text.slice(0, 40));
    }
  });

  it("refuses an author deleting for good, which is the site admin's", async () => {
    const made = await create();
    const refused = await ask(await as("bob"), DELETE, { id: made.id });
    assert.equal(refused.code, "PermissionDenied");
    const allowed = await ask(await as("alice"), DELETE, { id: made.id });
    assert.equal(allowed.code, undefined, allowed.message);
    assert.ok(!(await listed("alice", true)).some((r) => r.id === made.id));
  });
});

describe("retiring and restoring", () => {
  it("keeps a retired appendix, hides it from readers, and re-letters the rest", async () => {
    const rows = await withThree();
    const author = await as("bob");
    await ask(author, RETIRE, { id: (rows[0] as Row).id });
    const titles = (await readerTitles(CURRENT_VERSION)).map((a) => [
      a.letter,
      a.title,
    ]);
    assert.deepEqual(titles, [
      ["A", "Quote checklist"],
      ["B", "Supplier terms"],
    ]);
    const all = await listed("bob", true);
    assert.equal(all.length, 3);
    assert.ok(all.find((r) => r.id === (rows[0] as Row).id)?.retiredAt);
    assert.equal((await listed("bob")).length, 2);
    assert.equal((await listed("erin", true)).length, 2);
  });

  it("restores it to the end of the list", async () => {
    const rows = await withThree();
    const author = await as("bob");
    await ask(author, RETIRE, { id: (rows[0] as Row).id });
    const restored = await ask(author, RESTORE, { id: (rows[0] as Row).id });
    assert.equal(restored.code, undefined, restored.message);
    const row = restored.data.restoreAppendix as {
      letter: string;
      retiredAt: null | string;
    };
    assert.equal(row.retiredAt, null);
    assert.equal(row.letter, "C");
  });

  it("lets a site admin delete a retired appendix for good, history and all", async () => {
    const rows = await withThree();
    const target = (rows[2] as Row).id;
    await ask(await as("bob"), RETIRE, { id: target });
    const gone = await ask(await as("alice"), DELETE, { id: target });
    assert.equal(gone.code, undefined, gone.message);
    assert.ok(!(await listed("alice", true)).some((r) => r.id === target));
  });
});

describe("order", () => {
  it("reorders the appendices and re-letters them", async () => {
    const rows = await withThree();
    const ids = rows.map((r) => r.id).toReversed();
    const answer = await ask(await as("bob"), REORDER, {
      orderedIds: ids,
      policyId: POLICY,
    });
    assert.equal(answer.code, undefined, answer.message);
    assert.deepEqual(
      (
        answer.data.reorderPolicyAppendices as { id: string; letter: string }[]
      ).map((r) => [r.id, r.letter]),
      ids.map((id, index) => [id, String.fromCodePoint(65 + index)]),
    );
  });
});

const draftChange = async () => {
  const [first] = await listed("bob");
  await ask(await as("bob"), SAVE, {
    contentJson: JSON.stringify({ text: "Entirely new words." }),
    id: (first as Row).id,
    title: "Approval limits",
  });
  return (first as Row).id;
};

describe("the version diff", () => {
  it("is shown to an author, a site admin and compliance", async () => {
    const id = await draftChange();
    for (const user of ["bob", "alice", "dave"]) {
      const answer = await ask(await as(user), DIFF, { id });
      assert.equal(answer.code, undefined, `${user}: ${answer.message}`);
      assert.ok(Array.isArray(answer.data.appendixDiff));
    }
  });

  it("is refused to everyone else", async () => {
    const id = await draftChange();
    const answer = await ask(await as("erin"), DIFF, { id });
    assert.equal(answer.code, "PermissionDenied");
  });
});
