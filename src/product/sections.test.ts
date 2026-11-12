// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Section keys as steward-core derives them (internal/domain/diff.go). The expected values were
// produced by running core's own slugify, ExtractSections and wordDiffHTML on the same input, so
// the port is checked against core, not against itself. Then the seeded documents, which are
// Lexical documents keyed this way, and the version diff, which uses these keys.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { version } from "#product/data/policies.ts";
import {
  diffBlocks,
  extractSections,
  slugify,
  splitBlocks,
  wordDiffHtml,
} from "#product/sections.ts";
import { startForTests, startFresh } from "#product/test-client.ts";
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

const node = (type: string, text: string) => ({
  children: [{ text, type: "text" }],
  type,
});

describe("core's section keys", () => {
  it("slugs a heading the way core does", () => {
    const cases: [string, string][] = [
      ["Policy statement", "policy-statement"],
      ["  Booking a desk! ", "booking-a-desk"],
      ["3.1 Changing — a booking", "3-1-changing-a-booking"],
      ["Café menu", "caf-menu"],
      ["***", ""],
      ["", ""],
      ["Step 2: Report it", "step-2-report-it"],
      ["ÉTÉ", "t"],
    ];
    for (const [heading, slug] of cases) assert.equal(slugify(heading), slug);
  });

  it("splits a Lexical document on its headings, with body, repeats and the fallback key", () => {
    const document = JSON.stringify({
      root: {
        children: [
          {
            children: [
              { text: "Intro ", type: "text" },
              { children: [{ text: "line", type: "text" }], type: "link" },
            ],
            type: "paragraph",
          },
          node("heading", "Purpose"),
          node("paragraph", "Why."),
          {
            children: [node("listitem", "One"), node("listitem", "Two")],
            type: "list",
          },
          node("heading", "Purpose"),
          node("heading", "Body"),
          node("paragraph", "x"),
          node("heading", "!!"),
          node("paragraph", "y"),
        ],
      },
    });
    assert.deepEqual(
      extractSections(document, [{ key: "purpose" }, { key: "scope" }]),
      [
        { key: "purpose", text: "Purpose\nWhy.\nOne\nTwo" },
        { key: "body", text: "Intro line" },
        { key: "body-2", text: "Body\nx" },
        { key: "purpose-2", text: "Purpose" },
        { key: "section", text: "!!\ny" },
      ],
    );
  });

  it("keeps the older envelope's keys, and reads nothing from anything else", () => {
    assert.deepEqual(
      extractSections(JSON.stringify({ sections: { a: "first", z: "last" } })),
      [
        { key: "a", text: "first" },
        { key: "z", text: "last" },
      ],
    );
    assert.deepEqual(extractSections('[{"sectionKey":"1"}]'), []);
    assert.deepEqual(extractSections("not json"), []);
  });

  it("diffs words the way core does", () => {
    assert.equal(
      wordDiffHtml("a b c", "a x c d"),
      "a <del>b</del> <ins>x</ins> c <ins>d</ins>",
    );
  });
});

describe("the seeded documents", () => {
  it("are all Lexical documents with headings, none in the old section list", () => {
    for (const version of stewardData().versions) {
      const parsed = JSON.parse(version.contentJson) as unknown;
      assert.ok(!Array.isArray(parsed), version.id);
      assert.ok(
        extractSections(version.contentJson).length > 0,
        `${version.id} has no sections`,
      );
    }
  });

  it("key the Desk Booking Policy by its real headings, as the design's reader shows it", () => {
    const desk = stewardData().versions.find((v) => v.id === "version-11");
    assert.deepEqual(
      extractSections(desk?.contentJson ?? "").map((s) => s.key),
      [
        "booking-a-desk",
        "changing-a-booking",
        "purpose",
        "responsibilities",
        "scope",
      ],
    );
  });
});

describe("diffVersions", () => {
  it("answers each section of the template, keyed and diffed as core does", async () => {
    const reader = await signInAs(base, "user-erin");
    const answer = await call(base, reader, "DiffVersions", {
      fromVersionId: "version-10",
      toVersionId: "version-2",
    });
    assert.equal(answer.refused, undefined);
    assert.deepEqual(answer.data.diffVersions, [
      {
        changeType: "unchanged",
        sectionKey: "purpose",
        sectionTitle: "Purpose",
        wordDiffHtml: null,
      },
      {
        changeType: "unchanged",
        sectionKey: "scope",
        sectionTitle: "Scope",
        wordDiffHtml: null,
      },
      {
        changeType: "changed",
        sectionKey: "policy-statement",
        sectionTitle: "Policy statement",
        wordDiffHtml:
          "Policy statement File your claim within <del>60</del> <ins>30</ins> days of spending the money, using the expenses page. Attach a receipt for every item. <del>Post</del> <del>the</del> <del>original</del> <del>to</del> <ins>A</ins> <ins>clear</ins> <ins>photo</ins> <ins>of</ins> the <del>finance</del> <del>team.</del> <ins>receipt</ins> <ins>is</ins> <ins>enough.</ins>",
      },
    ]);
  });
});

// The cases below are core's DiffBlocks tests (internal/domain/diff_blocks_test.go) and the
// freeform handler tests, so a version with no template diffs block by block here as in core.
const lexical = (...parts: [kind: "h" | "p", text: string][]) =>
  JSON.stringify({
    root: {
      children: parts.map(([kind, text]) =>
        node(kind === "h" ? "heading" : "paragraph", text),
      ),
      type: "root",
    },
  });

const blockKeys = (json: string) =>
  splitBlocks(json)?.map((b) => `${b.key}|${b.title}`);

const summary = (result: ReturnType<typeof diffBlocks>) => {
  assert.ok("diffs" in result, JSON.stringify(result));
  return result.diffs.map(
    (d) => `${d.sectionKey}|${d.sectionTitle}|${d.changeType}`,
  );
};

describe("splitBlocks", () => {
  it("splits on headings, with an Introduction only when there is leading text", () => {
    assert.deepEqual(
      splitBlocks(
        lexical(
          ["p", "Preamble text."],
          ["h", "Purpose"],
          ["p", "Why we exist."],
          ["h", "Scope"],
          ["p", "Everyone."],
        ),
      ),
      [
        { key: "body", text: "Preamble text.", title: "Introduction" },
        { key: "purpose", text: "Purpose\nWhy we exist.", title: "Purpose" },
        { key: "scope", text: "Scope\nEveryone.", title: "Scope" },
      ],
    );
    assert.deepEqual(
      splitBlocks(lexical(["h", "Purpose"], ["p", "Why."]))?.map((b) => b.key),
      ["purpose"],
    );
    assert.deepEqual(splitBlocks(lexical(["p", "One."], ["p", "Two."])), [
      { key: "body", text: "One.\nTwo.", title: "Introduction" },
    ]);
  });

  it("numbers repeated headings, names an empty one, and reserves body", () => {
    assert.deepEqual(
      blockKeys(
        lexical(
          ["h", "Notes"],
          ["p", "a"],
          ["h", "Notes"],
          ["p", "b"],
          ["h", "Notes"],
          ["p", "c"],
        ),
      ),
      ["notes|Notes", "notes-2|Notes", "notes-3|Notes"],
    );
    assert.deepEqual(blockKeys(lexical(["h", ""], ["p", "text"])), [
      "section|Untitled section",
    ]);
    assert.deepEqual(blockKeys(lexical(["h", "Body"], ["p", "text"])), [
      "body-2|Body",
    ]);
  });

  it("sorts the older envelope by key with the key as the title, and has none for empty content", () => {
    assert.deepEqual(splitBlocks('{"sections":{"b":"two","a":"one"}}'), [
      { key: "a", text: "one", title: "a" },
      { key: "b", text: "two", title: "b" },
    ]);
    for (const empty of [
      "",
      '{"root":null}',
      '{"root":{"type":"root","children":[]}}',
    ])
      assert.deepEqual(splitBlocks(empty), []);
    assert.equal(splitBlocks("not-json"), undefined);
  });
});

describe("diffBlocks", () => {
  it("answers added, removed, changed and unchanged in the to order, a removed block after the one it followed", () => {
    const from = lexical(
      ["h", "Purpose"],
      ["p", "Keep this."],
      ["h", "Scope"],
      ["p", "All staff."],
      ["h", "Gone"],
      ["p", "Old section."],
    );
    const to = lexical(
      ["h", "Purpose"],
      ["p", "Keep this."],
      ["h", "Scope"],
      ["p", "All staff and contractors."],
      ["h", "Fresh"],
      ["p", "New section."],
    );
    const result = diffBlocks(from, to);
    assert.deepEqual(summary(result), [
      "purpose|Purpose|unchanged",
      "scope|Scope|changed",
      "gone|Gone|removed",
      "fresh|Fresh|added",
    ]);
    assert.ok("diffs" in result);
    assert.deepEqual(
      result.diffs.map((d) => [d.isBoilerplate, d.wordDiffHtml]),
      [
        [false, ""],
        [
          false,
          "Scope All <del>staff.</del> <ins>staff</ins> <ins>and</ins> <ins>contractors.</ins>",
        ],
        [false, "<del>Gone\nOld section.</del>"],
        [false, "<ins>Fresh\nNew section.</ins>"],
      ],
    );
  });

  it("puts a removed first block first", () => {
    assert.deepEqual(
      summary(
        diffBlocks(
          lexical(["h", "Old"], ["p", "x"], ["h", "Keep"], ["p", "y"]),
          lexical(["h", "Keep"], ["p", "y"]),
        ),
      ),
      ["old|Old|removed", "keep|Keep|unchanged"],
    );
  });

  it("keys the introduction and repeated headings", () => {
    assert.deepEqual(
      summary(
        diffBlocks(
          lexical(
            ["p", "Intro."],
            ["h", "Notes"],
            ["p", "a"],
            ["h", "Notes"],
            ["p", "b"],
          ),
          lexical(
            ["p", "Intro changed."],
            ["h", "Notes"],
            ["p", "a"],
            ["h", "Notes"],
            ["p", "b2"],
          ),
        ),
      ),
      [
        "body|Introduction|changed",
        "notes|Notes|unchanged",
        "notes-2|Notes|changed",
      ],
    );
  });

  it("handles an empty side and names the side that does not parse", () => {
    const to = lexical(["h", "Purpose"], ["p", "x"]);
    assert.deepEqual(summary(diffBlocks("", to)), ["purpose|Purpose|added"]);
    assert.deepEqual(summary(diffBlocks(to, "")), ["purpose|Purpose|removed"]);
    assert.deepEqual(summary(diffBlocks("", "")), []);
    assert.deepEqual(diffBlocks("not-json", to), { badSide: "from" });
    assert.deepEqual(diffBlocks(to, "not-json"), { badSide: "to" });
  });
});

const addVersion = (id: string, contentJson: string, templateVersionId = "") =>
  stewardData().versions.push(
    version({
      contentJson,
      createdAt: "2026-11-01T00:00:00Z",
      id,
      policyId: "policy-19",
      templateVersionId,
    }),
  );
const diffAs = async (fromVersionId: string, toVersionId: string) =>
  call(base, await signInAs(base, "user-bob"), "DiffVersions", {
    fromVersionId,
    toVersionId,
  });

describe("diffVersions of a version with no template", () => {
  const FROM = lexical(
    ["p", "Intro."],
    ["h", "Purpose"],
    ["p", "Why we exist."],
  );
  const TO = lexical(
    ["p", "Intro."],
    ["h", "Purpose"],
    ["p", "Why we really exist."],
    ["h", "Scope"],
    ["p", "Everyone."],
  );

  it("diffs a freeform pair block by block", async () => {
    addVersion("freeform-from", FROM);
    addVersion("freeform-to", TO);
    const answer = await diffAs("freeform-from", "freeform-to");
    assert.equal(answer.refused, undefined, JSON.stringify(answer));
    assert.deepEqual(answer.data.diffVersions, [
      {
        changeType: "unchanged",
        sectionKey: "body",
        sectionTitle: "Introduction",
        wordDiffHtml: null,
      },
      {
        changeType: "changed",
        sectionKey: "purpose",
        sectionTitle: "Purpose",
        wordDiffHtml: "Purpose Why we <ins>really</ins> exist.",
      },
      {
        changeType: "added",
        sectionKey: "scope",
        sectionTitle: "Scope",
        wordDiffHtml: "<ins>Scope\nEveryone.</ins>",
      },
    ]);
  });

  it("diffs a freeform version against a templated one instead of failing", async () => {
    addVersion("templated-from", FROM, "template-version-1");
    addVersion("freeform-to", TO);
    const answer = await diffAs("templated-from", "freeform-to");
    assert.equal(answer.refused, undefined, JSON.stringify(answer));
    assert.deepEqual(
      (
        answer.data.diffVersions as { changeType: string; sectionKey: string }[]
      ).map((d) => `${d.sectionKey}:${d.changeType}`),
      ["body:unchanged", "purpose:changed", "scope:added"],
    );
  });

  it("refuses content that does not parse, naming the side", async () => {
    addVersion("freeform-ok", TO);
    addVersion("freeform-bad", "not-json");
    const bad = await diffAs("freeform-ok", "freeform-bad");
    assert.equal(bad.refused, "INTERNAL");
    assert.match(JSON.stringify(bad), /diff: to content/);
    const badFrom = await diffAs("freeform-bad", "freeform-ok");
    assert.match(JSON.stringify(badFrom), /diff: from content/);
  });
});
