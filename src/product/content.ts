// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Whether a document holds any text. The rule the service applies before a draft goes for review:
// at least one character of text somewhere in the document, spaces alone not counting. The text
// nodes count, and so do the text fields of the cards that hold their own (a toggle's heading and
// content, a toggle group's items, a callout), with their markup taken out.

interface Node {
  [key: string]: unknown;
  children?: unknown[];
  type?: unknown;
}

const plain = (value: unknown): string =>
  typeof value === "string"
    ? value.replaceAll(/<[^>]*>/g, "").replaceAll("&nbsp;", " ")
    : "";

const cardText = (node: Node): string => {
  if (node.type === "toggle") return plain(node.heading) + plain(node.content);
  if (node.type === "callout") return plain(node.calloutText);
  if (node.type === "toggle-group" && Array.isArray(node.items))
    return (node.items as { content?: unknown; heading?: unknown }[])
      .map((item) => plain(item?.heading) + plain(item?.content))
      .join("");
  return "";
};

const hasTextIn = (node: Node): boolean =>
  (typeof node.text === "string" && node.text.trim() !== "") ||
  cardText(node).trim() !== "" ||
  (node.children ?? []).some((child) => hasTextIn(child as Node));

/** True when the stored content has at least one character of text; false for anything unreadable. */
export const hasContent = (contentJson: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const { root, sections } = parsed as { root?: Node; sections?: unknown };
  if (root && typeof root === "object") return hasTextIn(root);
  if (sections && typeof sections === "object")
    return Object.values(sections).some(
      (value) => typeof value === "string" && value.trim() !== "",
    );
  return false;
};
