// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Who this mock is: Steward's gateway. The values follow steward-gateway, so the web apps (and
// later the phone apps) talk to the mock with their live code unchanged.

export const product = {
  /** The product's name, on the controls page and in the ready line. */
  name: "Steward",
  /**
   * 5175: Brigade's mock is 5170, Sneakers' 5171, VitalsDA's 5172, and 5173 and 5174 are where
   * the staff and admin dev servers run.
   */
  port: 5175,
  /**
   * The root fields anyone may ask for before signing in: steward-gateway's public operations
   * (internal/bff/publicops.go), the global settings and the anonymous reporting flow.
   */
  publicFields: [
    "__typename",
    "globalSettings",
    "submitAnonymousReport",
    "checkReport",
    "replyToReport",
  ],
  /** steward-gateway's session cookie (internal/bff/http.go). */
  sessionCookie: process.env.MOCK_SESSION_COOKIE || "steward_sid",
  /** The version the mock reports: a release shape clients can parse. */
  version: process.env.MOCK_SERVER_VERSION || "v0.1.0-mock",
  /** steward-gateway's version header (the services answer health with it). */
  versionHeader: "Steward-Version",
};
