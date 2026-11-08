// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The commit the mock was started from, read from git once at start, so what runs can be compared
// with main when diagnosing. A run with no git around it (an image) takes COMMIT, else "unknown".

import { execFileSync } from "node:child_process";

const read = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.COMMIT?.trim().slice(0, 7) || "unknown";
  }
};

const commit = read();

/** The short commit this process started from. */
export const buildCommit = (): string => commit;
