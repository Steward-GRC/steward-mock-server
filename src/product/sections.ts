// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A policy version's sections, as steward-core reads them (internal/domain/diff.go): its content
// is either the older envelope {"sections": {"<key>": "text"}}, kept as it is, or a Lexical
// document, split on its top-level headings. A heading's section is keyed by a slug of its text,
// "-2", "-3" for repeats, and text before the first heading lands under "body". The section text
// keeps the heading as its first line. Section keys everywhere in the mock (the version diff, and
// anything that cites a section) come from here, so they match the keys steward-ai cites.

import type { Section } from "#product/data/library.ts";

interface LexicalNode {
  children?: LexicalNode[];
  text?: string;
  type?: string;
}

/** Node types whose text flows inline within a block. */
const INLINE = new Set(["autolink", "hashtag", "link", "mark", "text"]);

/** The concatenated plain text of a subtree: inline runs join, blocks take a newline. */
export const nodeText = (node: LexicalNode | undefined): string => {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  let out = "";
  for (const child of node.children ?? []) {
    const text = nodeText(child);
    if (!text) continue;
    if (out.length > 0 && !INLINE.has(child.type ?? "")) out += "\n";
    out += text;
  }
  return out;
};

/**
 * core's slugify: lowercase, keep a-z and 0-9, collapse every other run into one hyphen, trim
 * hyphens at either end.
 */
export const slugify = (value: string): string => {
  let out = "";
  let dashed = false;
  for (const ch of value.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      dashed = false;
    } else if (!dashed && out.length > 0) {
      out += "-";
      dashed = true;
    }
  }
  return out.replaceAll(/^-+|-+$/g, "");
};

/** core's reserveSectionKey: "section" for an empty base, "-2", "-3" for repeats. */
const reserve = (base: string, used: Map<string, number>): string => {
  const key = base || "section";
  const count = (used.get(key) ?? 0) + 1;
  used.set(key, count);
  return count === 1 ? key : `${key}-${String(count)}`;
};

/** Go's sort.Strings order for the ASCII keys core makes. */
const byteOrder = (a: string, b: string) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** One block of a document, as core's ContentBlock: a heading and the text up to the next one. */
export interface ContentBlock {
  key: string;
  text: string;
  title: string;
}

/**
 * core's lexicalBlocks over a document's top-level children. A heading starts a block keyed by a
 * slug of its text, "section" when empty, "-2", "-3" for repeats by order. Text before the first
 * heading is the "body" block, titled "Introduction", present only when it has text; "body" is
 * reserved even when empty, so a heading "Body" is keyed "body-2". A block's text keeps the
 * heading as its first line.
 */
const lexicalBlocks = (root: LexicalNode): ContentBlock[] => {
  const out: ContentBlock[] = [];
  const used = new Map<string, number>();
  let key = reserve("body", used);
  let title = "Introduction";
  let buffer = "";
  const flush = () => {
    const text = buffer.trim();
    if (text) out.push({ key, text, title });
    buffer = "";
  };
  for (const child of root.children ?? []) {
    if (child.type === "heading") {
      flush();
      const heading = nodeText(child).trim();
      key = reserve(slugify(heading), used);
      title = heading || "Untitled section";
      buffer = heading;
      continue;
    }
    const text = nodeText(child).trim();
    if (!text) continue;
    if (buffer.length > 0) buffer += "\n";
    buffer += text;
  }
  flush();
  return out;
};

/**
 * core's SplitBlocks: serialized content as ordered blocks, or undefined for content that doesn't
 * parse. The older {"sections": {...}} envelope has no order or titles, so its entries come back
 * sorted by key with the key as the title. Empty content has no blocks.
 */
export const splitBlocks = (
  contentJson: string,
): ContentBlock[] | undefined => {
  if (contentJson === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (parsed === null) return [];
  // A JSON array, string or number decodes as neither shape, which core treats as an error.
  if (typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { root, sections } = parsed as {
    root?: unknown;
    sections?: unknown;
  };
  // The envelope only when every section is text; otherwise core's decode falls to the tree.
  if (
    sections &&
    typeof sections === "object" &&
    !Array.isArray(sections) &&
    Object.values(sections).every((v) => typeof v === "string")
  )
    return Object.entries(sections as Record<string, string>)
      .toSorted(([a], [b]) => byteOrder(a, b))
      .map(([key, text]) => ({ key, text, title: key }));
  if (root === undefined || root === null) return [];
  if (typeof root !== "object" || Array.isArray(root)) return undefined;
  return lexicalBlocks(root as LexicalNode);
};

/** core's parseContent: section key to text, or undefined for content that doesn't parse. */
export const parseContent = (
  contentJson: string,
): Map<string, string> | undefined => {
  const blocks = splitBlocks(contentJson);
  return blocks && new Map(blocks.map((b) => [b.key, b.text]));
};

export interface ExtractedSection {
  key: string;
  text: string;
}

/**
 * core's ExtractSections: the template's sections in its order, then any the content has that the
 * template doesn't, sorted by key. Content that doesn't parse has none.
 */
export const extractSections = (
  contentJson: string,
  defs: readonly Pick<Section, "key">[] = [],
): ExtractedSection[] => {
  const sections = parseContent(contentJson);
  if (!sections || sections.size === 0) return [];
  const out: ExtractedSection[] = [];
  const seen = new Set<string>();
  for (const definition of defs) {
    const text = sections.get(definition.key);
    if (text === undefined) continue;
    out.push({ key: definition.key, text });
    seen.add(definition.key);
  }
  const orphans = [...sections.keys()]
    .filter((k) => !seen.has(k))
    .toSorted(byteOrder);
  for (const key of orphans) out.push({ key, text: sections.get(key) ?? "" });
  return out;
};

/** core's wordDiffHTML: an LCS word diff with <del> and <ins> around changed words. */
export const wordDiffHtml = (from: string, to: string): string => {
  const a = from.split(/\s+/).filter(Boolean);
  const b = to.split(/\s+/).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  const at = (left: number, right: number) => dp[left]?.[right] ?? 0;
  for (let left = 1; left <= a.length; left++)
    for (let right = 1; right <= b.length; right++) {
      const cells = dp[left] as number[];
      cells[right] =
        a[left - 1] === b[right - 1]
          ? at(left - 1, right - 1) + 1
          : Math.max(at(left - 1, right), at(left, right - 1));
    }
  const ops: string[] = [];
  let left = a.length;
  let right = b.length;
  while (left > 0 || right > 0) {
    if (left > 0 && right > 0 && a[left - 1] === b[right - 1]) {
      ops.push(`${a[left - 1] ?? ""} `);
      left--;
      right--;
    } else if (
      right > 0 &&
      (left === 0 || at(left, right - 1) >= at(left - 1, right))
    ) {
      ops.push(`<ins>${b[right - 1] ?? ""}</ins> `);
      right--;
    } else {
      ops.push(`<del>${a[left - 1] ?? ""}</del> `);
      left--;
    }
  }
  return ops.toReversed().join("").trim();
};

export interface SectionDiff {
  changeType: "added" | "changed" | "removed" | "unchanged";
  isBoilerplate: boolean;
  sectionKey: string;
  sectionTitle: string;
  wordDiffHtml: string;
}

/**
 * core's DiffVersions: one entry per section of the pinned template version, in its order. A
 * template migration marks every changed section as boilerplate.
 */
export const diffVersions = (
  fromJson: string,
  toJson: string,
  defs: readonly Pick<Section, "key" | "title">[],
  isTemplateMigration: boolean,
): SectionDiff[] | undefined => {
  const from = parseContent(fromJson);
  const to = parseContent(toJson);
  if (!from || !to) return undefined;
  return defs.map((definition) => {
    const before = from.get(definition.key) ?? "";
    const after = to.get(definition.key) ?? "";
    let changeType: SectionDiff["changeType"] = "changed";
    let html = "";
    if (before === "" && after !== "") {
      changeType = "added";
      html = `<ins>${after}</ins>`;
    } else if (before !== "" && after === "") {
      changeType = "removed";
      html = `<del>${before}</del>`;
    } else if (before === after) {
      changeType = "unchanged";
    } else {
      html = wordDiffHtml(before, after);
    }
    return {
      changeType,
      isBoilerplate: isTemplateMigration && changeType !== "unchanged",
      sectionKey: definition.key,
      sectionTitle: definition.title,
      wordDiffHtml: html,
    };
  });
};

/**
 * core's DiffBlocks, for a pair where either version has no pinned template: both sides are split
 * with splitBlocks and matched by key. One entry per block on either side, in the "to" order; a
 * block only the "from" side has (removed) sits right after the nearest earlier "from" block the
 * "to" side kept, or first when none. Titles come from the "to" side, or the "from" side for a
 * removed block. Never boilerplate. Content that doesn't parse names its side.
 */
export const diffBlocks = (
  fromJson: string,
  toJson: string,
): { badSide: "from" | "to" } | { diffs: SectionDiff[] } => {
  const from = splitBlocks(fromJson);
  if (!from) return { badSide: "from" };
  const to = splitBlocks(toJson);
  if (!to) return { badSide: "to" };
  const toKeys = new Set(to.map((b) => b.key));
  const fromByKey = new Map(from.map((b) => [b.key, b]));
  // Removed blocks, grouped under the last "from" block before them that "to" kept ("" for none).
  const removedAfter = new Map<string, ContentBlock[]>();
  let anchor = "";
  for (const block of from) {
    if (toKeys.has(block.key)) {
      anchor = block.key;
      continue;
    }
    removedAfter.set(anchor, [...(removedAfter.get(anchor) ?? []), block]);
  }
  const removed = (block: ContentBlock): SectionDiff => ({
    changeType: "removed",
    isBoilerplate: false,
    sectionKey: block.key,
    sectionTitle: block.title,
    wordDiffHtml: `<del>${block.text}</del>`,
  });
  const diffs = (removedAfter.get("") ?? []).map((block) => removed(block));
  for (const block of to) {
    const before = fromByKey.get(block.key);
    let changeType: SectionDiff["changeType"] = "changed";
    let html = "";
    if (!before) {
      changeType = "added";
      html = `<ins>${block.text}</ins>`;
    } else if (before.text === block.text) {
      changeType = "unchanged";
    } else {
      html = wordDiffHtml(before.text, block.text);
    }
    diffs.push(
      {
        changeType,
        isBoilerplate: false,
        sectionKey: block.key,
        sectionTitle: block.title,
        wordDiffHtml: html,
      },
      ...(removedAfter.get(block.key) ?? []).map((gone) => removed(gone)),
    );
  }
  return { diffs };
};
