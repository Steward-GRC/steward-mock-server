// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The contract between the core and a product. The core never imports src/product: whoever
// starts the mock hands it a product through useProduct (src/serve.ts hands it the one in
// src/product, the core tests hand it a fixture of their own). That keeps src/core the same file
// in every product that cloned the template, and lets the core tests pass whatever the product is.

import type { OperationDefinitionNode } from "graphql";
import type { WebSocket } from "ws";

import type { Action, ProductControl } from "#core/controls.ts";
import type { Resolvers } from "#core/graphql.ts";
import type { MaintenanceWindow, Person, Session } from "#core/state.ts";

/** A per-person field a product adds to the Users card. */
export interface PersonField {
  /** A short hint in the empty input. */
  hint?: string;
  /** The property on the person. It can't be one of the core's own fields. */
  key: string;
  /** "text" is one string, "list" a list edited as comma-separated text, "boolean" a checkbox. */
  kind: "boolean" | "list" | "text";
  label: string;
}

export interface Product {
  /** The product's own controls. */
  actions: ProductAction[];
  /**
   * The product's maintenance behaviour: how its gateway answers while maintenance is on, and
   * which fields keep answering for its banner. Its resolvers read the window with
   * `maintenance()` from src/core/maintenance.ts and hear changes on MAINTENANCE_CHANGED.
   */
  maintenance?: ProductMaintenance;
  /**
   * Fields of the product's own on each person, beyond the core's sign-in fields: shown and
   * edited in the Users card on /_mock, stored on the person, and listed by GET /_mock/people, so
   * the user store stays the owner's to edit while the product decides what the fields mean.
   */
  personFields?: PersonField[];
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
  /**
   * The product's own websocket paths. On an upgrade for any path but the GraphQL one, the core
   * asks this hook: undefined answers 404, a Response refuses the upgrade with that answer (a
   * plain-text 401 without a session, say), and a handler accepts it and gets the socket.
   * `sessionOfCookie(request)` from src/core/auth.ts reads the session from the upgrade.
   */
  sockets?: ProductSockets;
  /** The counts the controls page shows under Data. */
  summary: () => Record<string, unknown>;
}

/** One of the product's own controls: a button on /_mock and a kind for /_mock/controls. */
export type ProductAction = { run: ProductControl } & Action;

/** The invented data a product serves. People are the part the sign-in routes read. */
export interface ProductData {
  people: Person[];
}

/** How a product's gateway behaves during maintenance (see Product.maintenance). */
export interface ProductMaintenance {
  /**
   * Whether a GraphQL operation runs as normal during maintenance for this caller, the way a
   * gateway lets a site admin keep using the admin console (and end maintenance) while everyone
   * else is refused. The core calls it for an operation that parsed and selects more than
   * `fields`, with the caller's session (null when signed out). It doesn't open /auth, /setup,
   * the product's routes or new websockets.
   */
  allow?: (
    request: Request,
    session: null | Session,
    operation: OperationDefinitionNode,
  ) => boolean;
  /**
   * The answer a gateway call gets while maintenance is on. Without one, the core answers 503
   * with a Retry-After (`maintenanceAnswer` in src/core/maintenance.ts, which this can build on).
   */
  answer?: (
    request: Request,
    path: string,
    window: MaintenanceWindow,
  ) => Response;
  /** Root fields that keep answering during maintenance: the product's maintenance banner query. */
  fields?: string[];
  /**
   * What maintenance closes. "gateway" (the default) is a gateway in front of a stopped service:
   * the GraphQL path, /auth, /setup, the product's routes and new websockets answer the
   * refusal, and /readyz says not ready. "graphql" is a gateway that gates only its GraphQL
   * operations: every other route and websocket stays open and /readyz stays ready, while each
   * operation, over HTTP or on the websocket, still goes through `fields` and `allow`.
   */
  scope?: "gateway" | "graphql";
}

/** A product's own HTTP routes (see Product.routes). */
export type ProductRoutes = (
  request: Request,
  path: string,
) => Promise<Response | undefined> | Response | undefined;

/** A product's own websocket paths (see Product.sockets). */
export type ProductSockets = (
  request: Request,
  path: string,
) => Response | SocketHandler | undefined;

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

/** What a product does with a websocket it accepted: the socket, and the upgrade request. */
export type SocketHandler = (socket: WebSocket, request: Request) => void;

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
