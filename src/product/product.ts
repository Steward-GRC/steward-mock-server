// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward's gateway, as the one object src/serve.ts hands the core. The settings follow
// steward-gateway, so the web apps (and later the phone apps) talk to the mock with their live
// code unchanged. src/core never imports this folder.

import { readFileSync } from "node:fs";

import type { Product } from "#core/product.ts";

import { collabSockets } from "#product/collab.ts";
import { productActions, productSummary } from "#product/controls.ts";
import { seed } from "#product/data.ts";
import { resolvers } from "#product/resolvers.ts";
import { stewardRoutes } from "#product/routes.ts";

const read = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8");

export const steward: Product = {
  actions: productActions,
  resolvers,
  routes: stewardRoutes,
  schema: [read("schema.graphql"), read("schema-pending.graphql")],
  seed,
  settings: {
    graphqlPath: "/query",
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
    sessionCookie: "steward_sid",
    version: "v0.1.0-mock",
    /** steward-gateway's version header (the services answer health with it). */
    versionHeader: "Steward-Version",
  },
  sockets: collabSockets,
  summary: productSummary,
};
