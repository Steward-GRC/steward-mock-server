// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's own tools: GET /_mock/controls for what's going on, POST /_mock/controls with a
// `kind` to change it, GET /_mock/state for the whole state, GET /_mock/people for who can sign
// in. The /_mock page and tests drive the mock through these. They have no sign-in, so the
// server listens on loopback unless HOST says otherwise.
//
// The core kinds work for every product: reset, fresh, fail-next, expire-session and sign-in.
// A product adds its own in src/product/controls.ts.

import { issueSession } from "#core/auth.ts";
import { json, readJson, refuse } from "#core/http.ts";
import { maintenanceControls } from "#core/maintenance.ts";
import { product, settings } from "#core/product.ts";
import {
  endSessions,
  mockState,
  personById,
  resetData,
  startFresh,
} from "#core/state.ts";

/** One button on the controls page: it posts `body` (plus `kind`) to /_mock/controls. */
export interface Action {
  body?: Record<string, unknown>;
  hint?: string;
  kind: string;
  label: string;
  /** The page's section heading for it. */
  section: string;
}

export type ControlBody = { kind?: string } & Record<string, unknown>;

/** What a product's control does: change the state, then answer a value or a refusal. */
export type ProductControl = (body: ControlBody) => Response | unknown;

const CORE_ACTIONS: Action[] = [
  {
    body: { mode: "graphql" },
    hint: "The next GraphQL call answers an INTERNAL error.",
    kind: "fail-next",
    label: "Fail the next call",
    section: "Failures",
  },
  {
    body: { mode: "http", status: 503 },
    kind: "fail-next",
    label: "Fail it with a 503",
    section: "Failures",
  },
  {
    hint: "Every client's next call answers 401, and open sockets close.",
    kind: "expire-session",
    label: "Expire every session",
    section: "Failures",
  },
  {
    hint: "Everyone stays signed in.",
    kind: "reset",
    label: "Put the sample data back",
    section: "Start over",
  },
  {
    hint: "Back to first boot: everyone is signed out.",
    kind: "fresh",
    label: "Start fresh",
    section: "Start over",
  },
  {
    body: { firstRun: true },
    hint: "The same, and the clients walk first-run setup.",
    kind: "fresh",
    label: "Start as a new install",
    section: "Start over",
  },
];

const snapshot = () => ({
  actions: [
    ...product().actions.map(({ run: _run, ...action }) => action),
    ...CORE_ACTIONS,
  ],
  failNext: mockState.failNext,
  freshAt: mockState.freshAt,
  maintenance: mockState.maintenance,
  needsSetup: mockState.needsSetup,
  product: settings().name,
  sessions: [...mockState.sessions.values()].map(({ personId, startedAt }) => ({
    personId,
    startedAt,
  })),
  startedAt: mockState.startedAt,
  summary: product().summary(),
});

const CORE_KINDS: Record<string, (body: ControlBody) => Response | unknown> = {
  ...maintenanceControls,
  "expire-session": (body) => {
    endSessions(typeof body.personId === "string" ? body.personId : undefined);
  },
  "fail-next": (body) => {
    const mode = body.mode === "http" ? "http" : "graphql";
    mockState.failNext = {
      mode,
      status: mode === "http" ? Number(body.status ?? 503) : 200,
    };
  },
  fresh: (body) => {
    startFresh(body.firstRun === true);
  },
  reset: () => {
    resetData();
  },
  /** A finished sign-in in one step, for tests and a client's dev quick login. */
  "sign-in": (body) => {
    const person = personById(String(body.personId ?? ""));
    if (!person || person.disabled) return refuse(404, "unknown_person");
    return issueSession(person, body.token === true);
  },
};

/** Maps become objects and Sets arrays, so GET /_mock/state reads as plain JSON. */
const plain = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
};

const control = async (request: Request) => {
  const body = await readJson<ControlBody>(request);
  const kind = typeof body.kind === "string" ? body.kind : "";
  const run =
    CORE_KINDS[kind] ??
    (kind in productControls() ? productControls()[kind] : undefined);
  if (!run) return refuse(400, "unknown_kind");
  const result = await run(body);
  if (result instanceof Response) return result;
  return json({ ...snapshot(), ...(result === undefined ? {} : { result }) });
};

const productControls = (): Record<string, ProductControl> =>
  Object.fromEntries(
    product().actions.map((action) => [action.kind, action.run]),
  );

export const answerControls = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  if (path === "/_mock/controls" && request.method === "GET")
    return json(snapshot());
  if (path === "/_mock/controls" && request.method === "POST")
    return control(request);
  if (path === "/_mock/state" && request.method === "GET") {
    return new Response(JSON.stringify(mockState, plain), {
      headers: { "content-type": "application/json" },
    });
  }
  if (path === "/_mock/people" && request.method === "GET")
    return json(mockState.data.people);
  return undefined;
};
