// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Appendix titles, contributors and the Published tab (bug log 218, 221, 223): a new appendix gets
// a unique default title by letter; an appendix and each of its versions list everyone who ever
// saved or published it, active or not, for authors, site admins and compliance; the published
// versions come newest first for the drop-down; and the draft-against-published diff can take
// text that is not saved yet, so it follows what the author is typing.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  query,
  type Signed,
  signIn,
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

// POL-EXPENSES-000002 with its seeded appendix A, "Per-diem rates".
const POLICY = "policy-1";
const SEEDED = "appendix-1";
const body = (text: string) => JSON.stringify({ text });

const CREATE = `mutation ($policyId: ID!, $title: String, $contentJson: String!) {
  createPolicyAppendix(policyId: $policyId, title: $title, contentJson: $contentJson) {
    id letter draft { title }
  }
}`;
const SAVE = `mutation ($id: ID!, $title: String!, $contentJson: String!) {
  saveAppendixDraft(id: $id, title: $title, contentJson: $contentJson) { id }
}`;
const PUBLISH = `mutation ($id: ID!) { publishAppendix(id: $id) { id } }`;
const RETIRE = `mutation ($id: ID!) { retireAppendix(id: $id) { id } }`;
const LEGACY_ADD = `mutation ($versionId: ID!, $title: String!, $contentJson: String!) {
  addAppendix(policyVersionId: $versionId, title: $title, contentJson: $contentJson) { id title letter }
}`;
const CONTRIBUTORS = `query ($id: ID!) {
  policyAppendix(id: $id) {
    contributors { userId name active }
    versions { versionNo contributors { userId name active } }
  }
}`;
const PUBLISHED_VERSIONS = `query ($id: ID!) {
  policyAppendix(id: $id) {
    publishedVersions { versionNo state title }
    versions { versionNo }
  }
}`;
const DIFF = `query ($id: ID!, $contentJson: String) {
  appendixDiff(id: $id, contentJson: $contentJson) { sectionKey changeType }
}`;

const make = async (user: string, title: null | string = null) => {
  const answer = await ask(await as(user), CREATE, {
    contentJson: body("Terms."),
    policyId: POLICY,
    title,
  });
  assert.equal(answer.code, undefined, answer.message);
  return answer.data.createPolicyAppendix as {
    draft: { title: string };
    id: string;
    letter: string;
  };
};

describe("a new appendix is titled by its letter (bug log 218)", () => {
  it("is Appendix B, then Appendix C, when no title is given", async () => {
    const first = await make("bob");
    const second = await make("bob");
    assert.deepEqual(
      [first.letter, first.draft.title, second.letter, second.draft.title],
      ["B", "Appendix B", "C", "Appendix C"],
    );
  });

  it("treats a blank title as no title", async () => {
    const blank = await make("bob", " ".repeat(3));
    assert.equal(blank.draft.title, "Appendix B");
  });

  it("keeps a title that was given", async () => {
    const named = await make("bob", "Glossary");
    assert.equal(named.draft.title, "Glossary");
  });

  it("skips a name another appendix of the policy already uses", async () => {
    await make("bob", "Appendix B");
    const next = await make("bob");
    assert.equal(next.letter, "C");
    assert.equal(next.draft.title, "Appendix C");
  });

  it("skips the name of a retired appendix too", async () => {
    const first = await make("bob");
    assert.equal(first.draft.title, "Appendix B");
    await ask(await as("bob"), RETIRE, { id: first.id });
    const next = await make("bob");
    assert.equal(next.letter, "B");
    assert.equal(next.draft.title, "Appendix C");
  });

  it("names the older version-bound add the same way", async () => {
    const added = await ask(await as("bob"), LEGACY_ADD, {
      contentJson: body("Terms."),
      title: "",
      versionId: "version-2",
    });
    assert.equal(added.code, undefined, added.message);
    assert.equal(
      (added.data.addAppendix as { title: string }).title,
      "Appendix B",
    );
  });

  it("leaves renaming open", async () => {
    const made = await make("bob");
    const renamed = await ask(await as("bob"), SAVE, {
      contentJson: body("Terms."),
      id: made.id,
      title: "Glossary of terms",
    });
    assert.equal(renamed.code, undefined, renamed.message);
  });

  it("gives every seeded policy's appendices titles that differ from each other", () => {
    for (const policy of stewardData().policies) {
      const titles = stewardData()
        .appendices.filter((a) => a.policyId === policy.id)
        .flatMap((a) => a.versions.at(-1)?.title ?? []);
      assert.equal(
        new Set(titles).size,
        titles.length,
        `${policy.number}: ${titles.join(", ")}`,
      );
    }
  });
});

describe("the contributors to an appendix (bug log 221)", () => {
  it("lists the seeded appendix's author, with a name", async () => {
    const answer = await ask(await as("bob"), CONTRIBUTORS, { id: SEEDED });
    assert.equal(answer.code, undefined, answer.message);
    const appendix = answer.data.policyAppendix as {
      contributors: { active: boolean; name: string; userId: string }[];
    };
    assert.deepEqual(appendix.contributors, [
      { active: true, name: "Bob Author", userId: "user-bob" },
    ]);
  });

  it("keeps everyone who saved or published it, in the order they first did", async () => {
    const made = await make("bob");
    await ask(await as("bob"), SAVE, {
      contentJson: body("Edited."),
      id: made.id,
      title: "Appendix B",
    });
    // Alice only publishes: publishing counts as contributing
    const alice = await as("alice");
    await ask(alice, PUBLISH, { id: made.id });
    const answer = await ask(alice, CONTRIBUTORS, { id: made.id });
    assert.equal(answer.code, undefined, answer.message);
    const appendix = answer.data.policyAppendix as {
      contributors: { userId: string }[];
      versions: { contributors: { userId: string }[]; versionNo: number }[];
    };
    assert.deepEqual(
      appendix.contributors.map((c) => c.userId),
      ["user-bob", "user-alice"],
    );
    assert.deepEqual(
      appendix.versions[0]?.contributors.map((c) => c.userId),
      ["user-bob", "user-alice"],
    );
  });

  it("keeps each version's own contributors", async () => {
    const made = await make("bob");
    await ask(await as("bob"), PUBLISH, { id: made.id });
    await ask(await as("alice"), SAVE, {
      contentJson: body("Second edition."),
      id: made.id,
      title: "Appendix B",
    });
    const answer = await ask(await as("bob"), CONTRIBUTORS, { id: made.id });
    const appendix = answer.data.policyAppendix as {
      contributors: { userId: string }[];
      versions: { contributors: { userId: string }[]; versionNo: number }[];
    };
    assert.deepEqual(
      appendix.versions.map((v) => [
        v.versionNo,
        v.contributors.map((c) => c.userId),
      ]),
      [
        [1, ["user-bob"]],
        [2, ["user-alice"]],
      ],
    );
    assert.deepEqual(
      appendix.contributors.map((c) => c.userId),
      ["user-bob", "user-alice"],
    );
  });

  it("still lists a person who has since been disabled, marked not active", async () => {
    const made = await make("bob");
    await ask(await as("bob"), PUBLISH, { id: made.id });
    stewardData().people.find((p) => p.id === "user-bob")!.disabled = true;
    const answer = await ask(await as("alice"), CONTRIBUTORS, { id: made.id });
    assert.equal(answer.code, undefined, answer.message);
    const appendix = answer.data.policyAppendix as {
      contributors: { active: boolean; name: string; userId: string }[];
    };
    assert.deepEqual(appendix.contributors, [
      { active: false, name: "Bob Author", userId: "user-bob" },
    ]);
  });

  it("is shown to an author, a site admin and compliance, and to nobody else", async () => {
    for (const user of ["bob", "alice", "dave"]) {
      const answer = await ask(await as(user), CONTRIBUTORS, { id: SEEDED });
      assert.equal(answer.code, undefined, `${user}: ${answer.message}`);
      assert.equal(
        (answer.data.policyAppendix as { contributors: unknown[] }).contributors
          .length,
        1,
        user,
      );
    }
    const reader = await ask(await as("erin"), CONTRIBUTORS, { id: SEEDED });
    assert.equal(reader.code, undefined, reader.message);
    const seen = reader.data.policyAppendix as {
      contributors: unknown[];
      versions: { contributors: unknown[] }[];
    };
    assert.deepEqual(seen.contributors, []);
    assert.ok(seen.versions.every((v) => v.contributors.length === 0));
  });

  it("adds whoever co-edits in the appendix room and checkpoints", async () => {
    const alice = await signIn(base, "alice");
    const token = await ask(
      alice,
      `mutation ($id: ID!) { issueAppendixCollabToken(appendixId: $id) { token wsUrl } }`,
      { id: SEEDED },
    );
    assert.equal(token.code, undefined, token.message);
    const room = token.data.issueAppendixCollabToken as {
      token: string;
      wsUrl: string;
    };
    const socket = new WebSocket(
      `${base.replace("http", "ws")}${room.wsUrl}?token=${room.token}`,
      { headers: { cookie: alice.cookie } },
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const content = JSON.stringify({
      root: {
        children: [],
        direction: null,
        format: "",
        indent: 0,
        type: "root",
        version: 1,
      },
    });
    const text = [...Buffer.from(content, "utf8")];
    const reply = new Promise<void>((resolve) =>
      socket.once("message", () => resolve()),
    );
    socket.send(Buffer.from([100, text.length, ...text, 0]));
    await reply;
    socket.close();
    const answer = await ask(await as("bob"), CONTRIBUTORS, { id: SEEDED });
    const appendix = answer.data.policyAppendix as {
      contributors: { userId: string }[];
    };
    assert.deepEqual(
      appendix.contributors.map((c) => c.userId),
      ["user-bob", "user-alice"],
    );
  });
});

const publishEdition = async (user: string, id: string, text: string) => {
  await ask(await as(user), SAVE, {
    contentJson: body(text),
    id,
    title: "Per-diem rates",
  });
  await ask(await as(user), PUBLISH, { id });
};

describe("the published versions for the drop-down (bug log 223)", () => {
  it("lists the published versions newest first, leaving the draft out", async () => {
    await publishEdition("bob", SEEDED, "Second.");
    await publishEdition("bob", SEEDED, "Third.");
    await ask(await as("bob"), SAVE, {
      contentJson: body("Fourth, unpublished."),
      id: SEEDED,
      title: "Per-diem rates",
    });
    const answer = await ask(await as("bob"), PUBLISHED_VERSIONS, {
      id: SEEDED,
    });
    assert.equal(answer.code, undefined, answer.message);
    const appendix = answer.data.policyAppendix as {
      publishedVersions: { state: string; versionNo: number }[];
      versions: { versionNo: number }[];
    };
    assert.deepEqual(
      appendix.publishedVersions.map((v) => [v.versionNo, v.state]),
      [
        [3, "PUBLISHED"],
        [2, "PUBLISHED"],
        [1, "PUBLISHED"],
      ],
    );
    // the version table itself stays oldest first
    assert.deepEqual(
      appendix.versions.map((v) => v.versionNo),
      [1, 2, 3, 4],
    );
  });

  it("shows a reader only the latest published version", async () => {
    await publishEdition("bob", SEEDED, "Second.");
    const answer = await ask(await as("erin"), PUBLISHED_VERSIONS, {
      id: SEEDED,
    });
    assert.equal(answer.code, undefined, answer.message);
    const appendix = answer.data.policyAppendix as {
      publishedVersions: { versionNo: number }[];
    };
    assert.deepEqual(
      appendix.publishedVersions.map((v) => v.versionNo),
      [2],
    );
  });
});

describe("the live diff (bug log 223)", () => {
  it("diffs text that is not saved against what is published", async () => {
    const answer = await ask(await as("bob"), DIFF, {
      contentJson: body(
        "Per-diem rates by country, now reviewed every quarter.",
      ),
      id: SEEDED,
    });
    assert.equal(answer.code, undefined, answer.message);
    const diff = answer.data.appendixDiff as {
      changeType: string;
      sectionKey: string;
    }[];
    assert.ok(
      diff.some((d) => d.changeType !== "unchanged"),
      "has a change",
    );
  });

  it("saves nothing: no draft appears and the stored draft is left alone", async () => {
    await ask(await as("bob"), DIFF, {
      contentJson: body("Typed, not saved."),
      id: SEEDED,
    });
    const appendix = stewardData().appendices.find((a) => a.id === SEEDED)!;
    assert.ok(!appendix.versions.some((v) => v.state === "DRAFT"));
  });

  it("is unchanged against itself", async () => {
    const answer = await ask(await as("bob"), DIFF, {
      contentJson: body(
        "Per-diem rates by country, reviewed annually by Finance.",
      ),
      id: SEEDED,
    });
    const diff = answer.data.appendixDiff as { changeType: string }[];
    assert.ok(diff.every((d) => d.changeType === "unchanged"));
  });

  it("is refused to those who may not see the diff", async () => {
    const answer = await ask(await as("erin"), DIFF, {
      contentJson: body("Typed."),
      id: SEEDED,
    });
    assert.equal(answer.code, "PermissionDenied");
  });
});
