// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Who this mock is. A product changes these values (and the files beside this one) when it
// clones the template; nothing in src/core names a product.

export const product = {
  /** The product's name, on the controls page and in the ready line. */
  name: "Example",
  /** The port the mock listens on unless --port or PORT says otherwise. */
  port: 5180,
  /**
   * Root fields anyone may ask for before signing in. An operation runs without a session only
   * when every root field it selects is in this list.
   */
  publicFields: ["serverInfo"],
  /** The session cookie. Take the real gateway's name, so a client's live code reads it unchanged. */
  sessionCookie: process.env.MOCK_SESSION_COOKIE || "example_session",
  /** The version the mock reports: a release shape clients can parse. */
  version: process.env.MOCK_SERVER_VERSION || "v0.1.0-mock",
  /** The response header the health probes carry the version in. */
  versionHeader: "Example-Version",
};
