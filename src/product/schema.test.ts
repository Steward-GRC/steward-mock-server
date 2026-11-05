// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The schema is a copy of steward-gateway's, pinned to one commit. These checks run offline:
// the copy names the pinned commit and matches the hash scripts/schema-copy.sh recorded, so a
// hand edit or a half-done bump fails here instead of drifting from the gateway.

import { buildSchema } from "graphql";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const pins = Object.fromEntries(
  read("../../schema-refs.env")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);

const schema = read("./schema.graphql");

describe("the gateway schema copy", () => {
  it("names the pinned steward-gateway commit", () => {
    assert.match(pins.STEWARD_GATEWAY_REF ?? "", /^[0-9a-f]{40}$/);
    assert.ok(
      schema.includes(
        `# steward-gateway commit: ${pins.STEWARD_GATEWAY_REF}\n`,
      ),
      "src/product/schema.graphql names another commit; rerun scripts/schema-copy.sh",
    );
  });

  it("matches the recorded hash", () => {
    const sum = createHash("sha256").update(schema).digest("hex");
    assert.equal(sum, pins.STEWARD_GATEWAY_SCHEMA_SHA256);
  });

  it("builds", () => {
    const built = buildSchema(schema);
    assert.ok(built.getQueryType()?.getFields().me);
    assert.ok(built.getQueryType()?.getFields().globalSettings);
  });
});
