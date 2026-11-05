// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The gateway's maintenance cycle, driven from the controls: announce a window, start
// maintenance, extend or update it, end it, or cancel an announcement. The window lives in the
// shared state, so every client sees the same one, and it goes back to none on a reset.
//
// While maintenance is on, the gateway paths (the GraphQL path, /auth, /setup, the product's own
// routes and new websockets) answer the product's maintenance refusal: by default 503 with a
// Retry-After until the window ends, the way a gateway in front of a stopped service answers.
// /readyz says not ready; /livez, /healthz and /_mock keep answering, and so do the root fields
// the product lists for its maintenance banner and the GraphQL operations its allow hook lets a
// caller run. A product whose gateway gates only GraphQL sets its scope to "graphql": then only
// GraphQL operations are refused, over HTTP and on the websocket, and everything else stays open.

import type { OperationDefinitionNode } from "graphql";

import { MAINTENANCE_CHANGED, publish } from "#core/events.ts";
import { json, refuse } from "#core/http.ts";
import { product } from "#core/product.ts";
import {
  type MaintenanceWindow,
  mockState,
  noMaintenance,
  type Session,
} from "#core/state.ts";

export { MAINTENANCE_CHANGED } from "#core/events.ts";
export type { MaintenanceWindow } from "#core/state.ts";

/** How long a client is told to wait when the window has no end yet. */
const DEFAULT_RETRY_SECONDS = 300;

/** The window as it stands. A product's resolvers read it for their maintenance fields. */
export const maintenance = (): MaintenanceWindow => ({
  ...mockState.maintenance,
});

export const maintenanceOn = (): boolean =>
  mockState.maintenance.state === "active";

const set = (window: MaintenanceWindow) => {
  mockState.maintenance = window;
  publish(MAINTENANCE_CHANGED, maintenance());
};

/** Seconds until the window ends, or the default when it has no end. */
export const retryAfter = (window: MaintenanceWindow): number => {
  if (!window.endsAt) return DEFAULT_RETRY_SECONDS;
  return Math.max(
    1,
    Math.ceil((Date.parse(window.endsAt) - Date.now()) / 1000),
  );
};

/** The core's maintenance answer: 503, a Retry-After, and the window's message. */
export const maintenanceAnswer = (window: MaintenanceWindow): Response =>
  json({ error: "maintenance", message: window.message }, 503, {
    "retry-after": String(retryAfter(window)),
  });

/** The answer for a gateway call while maintenance is on (the product's, or the core's), else undefined. */
export const maintenanceRefusal = (
  request: Request,
  path: string,
): Response | undefined => {
  if (!maintenanceOn()) return undefined;
  const window = maintenance();
  return (
    product().maintenance?.answer?.(request, path, window) ??
    maintenanceAnswer(window)
  );
};

/** Whether maintenance closes the whole gateway (the default) or only its GraphQL operations. */
export const maintenanceClosesGateway = (): boolean =>
  (product().maintenance?.scope ?? "gateway") === "gateway";

/** The answer for a non-GraphQL call or a new websocket while maintenance closes the gateway. */
export const maintenanceGate = (
  request: Request,
  path: string,
): Response | undefined =>
  maintenanceClosesGateway() ? maintenanceRefusal(request, path) : undefined;

/** The GraphQL error an operation on an open websocket gets while maintenance refuses it. */
export const maintenanceError = (): {
  extensions: { code: string };
  message: string;
} => ({
  extensions: { code: "MAINTENANCE" },
  message:
    mockState.maintenance.message ?? "The service is down for maintenance.",
});

/**
 * Whether a GraphQL operation runs during maintenance: it selects only the fields the product
 * keeps answering, or the product's allow hook lets this caller through.
 */
export const maintenanceAllows = (
  operation: OperationDefinitionNode,
  request: Request,
  session: null | Session,
): boolean => {
  const fields = product().maintenance?.fields ?? [];
  const banner = operation.selectionSet.selections.every(
    (selection) =>
      selection.kind === "Field" &&
      (selection.name.value === "__typename" ||
        fields.includes(selection.name.value)),
  );
  return (
    banner ||
    product().maintenance?.allow?.(request, session, operation) === true
  );
};

type Body = Record<string, unknown>;

const text = (value: unknown): null | string | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return typeof value === "string" ? value : undefined;
};

/** A time from the controls, as an ISO string; undefined when absent, false when it doesn't parse. */
const time = (value: unknown): false | null | string | undefined => {
  const given = text(value);
  if (given === undefined || given === null) return given;
  const at = Date.parse(given);
  return Number.isNaN(at) ? false : new Date(at).toISOString();
};

/** The window with the body's fields laid over it, or a refusal when the times don't make sense. */
const merged = (
  base: MaintenanceWindow,
  body: Body,
  state: MaintenanceWindow["state"],
) => {
  const startsAt = time(body.startsAt);
  const endsAt = time(body.endsAt);
  if (startsAt === false || endsAt === false)
    return refuse(400, "invalid_time");
  const message = text(body.message);
  const next: MaintenanceWindow = {
    endsAt: endsAt === undefined ? base.endsAt : endsAt,
    message: message === undefined ? base.message : message,
    startsAt: startsAt === undefined ? base.startsAt : startsAt,
    state,
  };
  if (
    next.startsAt &&
    next.endsAt &&
    Date.parse(next.endsAt) <= Date.parse(next.startsAt)
  ) {
    return refuse(400, "ends_before_it_starts");
  }
  return next;
};

const apply = (result: MaintenanceWindow | Response) => {
  if (result instanceof Response) return result;
  set(result);
  return;
};

/** The maintenance kinds for POST /_mock/controls. */
export const maintenanceControls: Record<
  string,
  (body: Body) => Response | undefined
> = {
  /** A window ahead: when it starts and ends, and what clients tell people. */
  "maintenance-announce": (body) => {
    if (maintenanceOn()) return refuse(409, "maintenance_active");
    if (!body.startsAt || !body.endsAt) return refuse(400, "window_required");
    return apply(merged(noMaintenance(), body, "announced"));
  },
  /** Drop an announcement that hasn't started. Maintenance that's on is ended, not cancelled. */
  "maintenance-cancel": () => {
    if (maintenanceOn()) return refuse(409, "maintenance_active");
    if (mockState.maintenance.state === "none")
      return refuse(409, "nothing_announced");
    set(noMaintenance());
    return;
  },
  /** Back to normal. */
  "maintenance-end": () => {
    set(noMaintenance());
    return;
  },
  /** Maintenance on now: the announced window if there is one, with the body's changes. */
  "maintenance-start": (body) => {
    const announced = mockState.maintenance;
    const base = announced.state === "none" ? noMaintenance() : announced;
    return apply(
      merged({ ...base, startsAt: new Date().toISOString() }, body, "active"),
    );
  },
  /** Extend or change the window, announced or on. */
  "maintenance-update": (body) => {
    const current = mockState.maintenance;
    if (current.state === "none") return refuse(409, "no_maintenance");
    return apply(merged(current, body, current.state));
  },
};
