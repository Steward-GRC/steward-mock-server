// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
import shared from "@bugs5382/node-oxlint-config/oxfmt";

// The shared settings. Governance files belong to the governance sync, so the
// formatter leaves them as the sync writes them.
export default {
  ...shared,
  ignorePatterns: [
    ...(shared.ignorePatterns ?? []),
    ".github/**",
    ".claude/**",
    "CLAUDE.md",
    // A byte-exact copy of steward-gateway's SDL; schema.test.ts checks its hash.
    "src/product/schema.graphql",
  ],
};
