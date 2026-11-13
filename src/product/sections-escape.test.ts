// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The word diff HTML escapes author text (steward-core#111): only the <ins> and <del> the diff
// writes are markup, and a reader that splits on them and decodes entities gets the words back.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffBlocks, diffVersions, wordDiffHtml } from "#product/sections.ts";

interface Run {
  kind: "del" | "ins" | "same";
  words: string[];
}

const unescape = (s: string) =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** A reference reader for the diff HTML, the way the web reads it. */
const parseDiff = (html: string): Run[] => {
  const runs: Run[] = [];
  let kind: Run["kind"] = "same";
  const add = (raw: string) => {
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      const last = runs.at(-1);
      if (last?.kind === kind) last.words.push(unescape(word));
      else runs.push({ kind, words: [unescape(word)] });
    }
  };
  let pos = 0;
  for (const m of html.matchAll(/<\/?(ins|del)>/g)) {
    add(html.slice(pos, m.index));
    if (m[0] === "<ins>") kind = "ins";
    else if (m[0] === "<del>") kind = "del";
    else kind = "same";
    pos = m.index + m[0].length;
  }
  add(html.slice(pos));
  return runs;
};

const envelope = (sections: Record<string, string>) =>
  JSON.stringify({ sections });

const only = (result: ReturnType<typeof diffBlocks>) => {
  assert.ok("diffs" in result, JSON.stringify(result));
  return Object.fromEntries(
    result.diffs.map((d) => [d.sectionKey, d.wordDiffHtml]),
  );
};

describe("the word diff HTML escapes author text", () => {
  it("escapes &, < and > and leaves quotes alone", () => {
    assert.equal(
      wordDiffHtml(`a "q" 'r'`, `a "q" 'r' x&y <b>`),
      `a "q" 'r' <ins>x&amp;y</ins> <ins>&lt;b&gt;</ins>`,
    );
  });

  it("escapes once: an existing entity is text, not escaped twice by another pass", () => {
    assert.equal(wordDiffHtml("&lt;", "&lt; z"), "&amp;lt; <ins>z</ins>");
  });

  it("compares words raw", () => {
    assert.equal(wordDiffHtml("a <b> c", "a <b> c"), "a &lt;b&gt; c");
  });

  it("escapes changed words, in the template path", () => {
    const defs = [{ key: "a", title: "A" }];
    const diffs = diffVersions(
      envelope({ a: "keep <b>bold</b> &lt; old" }),
      envelope({ a: "keep <b>bold</b> &lt; <ins>x</ins> new" }),
      defs,
      false,
    );
    const html = diffs?.[0]?.wordDiffHtml ?? "";
    assert.ok(!html.includes("<b>") && !html.includes("<ins>x"), html);
    assert.deepEqual(parseDiff(html), [
      { kind: "same", words: ["keep", "<b>bold</b>", "&lt;"] },
      { kind: "del", words: ["old"] },
      { kind: "ins", words: ["<ins>x</ins>", "new"] },
    ]);
  });

  it("escapes a whole added and a whole removed section, in the template path", () => {
    const defs = [{ key: "a", title: "A" }];
    const text = "a <b>c</b> & <del>y</del>";
    const added = diffVersions(
      envelope({}),
      envelope({ a: text }),
      defs,
      false,
    );
    assert.deepEqual(parseDiff(added?.[0]?.wordDiffHtml ?? ""), [
      { kind: "ins", words: text.split(" ") },
    ]);
    const removed = diffVersions(
      envelope({ a: text }),
      envelope({}),
      defs,
      false,
    );
    assert.deepEqual(parseDiff(removed?.[0]?.wordDiffHtml ?? ""), [
      { kind: "del", words: text.split(" ") },
    ]);
  });

  it("escapes every branch of the block path and keeps newlines in whole blocks", () => {
    const from = envelope({
      edit: "keep <i>old</i> &amp;",
      gone: "a &\n<ins>b</ins>",
      same: "x <b>1</b>",
    });
    const to = envelope({
      edit: "keep <i>new</i> &amp;",
      fresh: "<del>c</del> >\nd",
      same: "x <b>1</b>",
    });
    const html = only(diffBlocks(from, to));
    for (const leak of ["<b>", "<i>", "<ins>b", "<del>c"])
      for (const value of Object.values(html))
        assert.ok(!value.includes(leak), `${leak} leaked in ${value}`);
    assert.equal(html["gone"], "<del>a &amp;\n&lt;ins&gt;b&lt;/ins&gt;</del>");
    assert.equal(html["fresh"], "<ins>&lt;del&gt;c&lt;/del&gt; &gt;\nd</ins>");
    assert.equal(html["same"], "");
    assert.deepEqual(parseDiff(html["edit"] ?? ""), [
      { kind: "same", words: ["keep"] },
      { kind: "del", words: ["<i>old</i>"] },
      { kind: "ins", words: ["<i>new</i>"] },
      { kind: "same", words: ["&amp;"] },
    ]);
    assert.deepEqual(parseDiff(html["gone"] ?? ""), [
      { kind: "del", words: ["a", "&", "<ins>b</ins>"] },
    ]);
    assert.deepEqual(parseDiff(html["fresh"] ?? ""), [
      { kind: "ins", words: ["<del>c</del>", ">", "d"] },
    ]);
  });
});
