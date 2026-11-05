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
import { extractSections, slugify, wordDiffHtml } from "#product/sections.ts";
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
