// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The template's source carries no emoji. Products that clone the template run a PR check that
// refuses emoji in source files, and their src/core has to stay the template's byte for byte, so
// one emoji here blocks every product's next sync. These are the same character ranges that check
// uses: the emoji planes, the miscellaneous symbols and dingbats, the arrows-and-symbols
// supplement, the variation selectors and the regional indicators. Markdown is allowed emoji and
// isn't scanned.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const files = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) return files(full);
    return name.endsWith(".md") ? [] : [full];
  });

describe("source", () => {
  it("carries no emoji, so products can take it unchanged", () => {
    const found = ["src", "bin"].flatMap((folder) =>
      files(path.join(ROOT, folder)).flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, at) =>
            EMOJI.test(line)
              ? [`${path.relative(ROOT, file)}:${String(at + 1)}`]
              : [],
          ),
      ),
    );
    assert.deepEqual(found, []);
  });
});
