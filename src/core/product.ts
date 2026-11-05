// Copyright 2026 The template-node-mock-server Authors
// SPDX-License-Identifier: Apache-2.0
// The contract between the core and a product. The core never imports src/product: whoever
// starts the mock hands it a product through useProduct (src/serve.ts hands it the one in
// src/product, the core tests hand it a fixture of their own). That keeps src/core the same file
// in every product that cloned the template, and lets the core tests pass whatever the product is.

import type { Action, ProductControl } from "#core/controls.ts";
import type { Resolvers } from "#core/graphql.ts";
import type { Person } from "#core/state.ts";

export interface Product {
  /** The product's own controls. */
  actions: ProductAction[];
  /** What each field of the schema answers, by type and field name. */
  resolvers: Resolvers;
  /**
   * The product's own HTTP routes: a Response for a request it serves, undefined for one it
   * doesn't. They run after the health probes, the controls and the GraphQL path (which a product
   * can't replace) and before the core's /auth and /setup routes, so a product can add a sign-in
   * path the core doesn't know.
   */
  routes?: ProductRoutes;
  /**
   * The gateway's GraphQL schema as SDL text, or several texts read as one: a copy of the real
   * gateway's schema, and beside it a file of schema that's ahead of the gateway (written with
   * `extend type`), so the copy stays untouched.
   */
  schema: string | string[];
  /** The invented data, made fresh on every reset. */
  seed: () => ProductData;
  settings: Settings;
  /** The counts the controls page shows under Data. */
  summary: () => Record<string, unknown>;
}

/** One of the product's own controls: a button on /_mock and a kind for /_mock/controls. */
export type ProductAction = { run: ProductControl } & Action;

/** The invented data a product serves. People are the part the sign-in routes read. */
export interface ProductData {
  people: Person[];
}

/** A product's own HTTP routes (see Product.routes). */
export type ProductRoutes = (
  request: Request,
  path: string,
) => Promise<Response | undefined> | Response | undefined;

/** Who the product's gateway is, as the mock presents it. */
export interface Settings {
  /** The GraphQL path, for HTTP and the websocket alike ("/query" on a gqlgen gateway). */
  graphqlPath: string;
  /** The product's name, on the controls page and in the ready line. */
  name: string;
  /** The port the mock listens on unless --port or PORT says otherwise. */
  port: number;
  /**
   * Root fields anyone may ask for before signing in. An operation runs without a session only
   * when every root field it selects is in this list.
   */
  publicFields: string[];
  /** The session cookie: the real gateway's name, so a client's live code reads it unchanged. */
  sessionCookie: string;
  /** The version the probes report: a release shape clients can parse. */
  version: string;
  /** The response header the probes carry the version in. */
  versionHeader: string;
}

let current: Product | undefined;
const changeHooks: (() => void)[] = [];

/** Run `hook` whenever a new product is handed in (the state reseeds, the schema rebuilds). */
export const onProductChange = (hook: () => void): void => {
  changeHooks.push(hook);
};

/** Hand the core its product. Everything starts fresh on the new product's data. */
export const useProduct = (product: Product): void => {
  current = product;
  for (const hook of changeHooks) hook();
};

/** The product the core is serving. */
export const product = (): Product => {
  if (!current)
    throw new Error(
      "the mock has no product: call useProduct() before starting it",
    );
  return current;
};

/** The product's settings, with the environment's overrides for the cookie and the version. */
export const settings = (): Settings => {
  const own = product().settings;
  return {
    ...own,
    sessionCookie: process.env.MOCK_SESSION_COOKIE || own.sessionCookie,
    version: process.env.MOCK_SERVER_VERSION || own.version,
  };
};
