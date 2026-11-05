// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Every HTTP request the mock answers, as a fetch-style function: a Request in, a Response out.
// The network server calls it, and so can a client's own tests, in-process, with no port.
//
// Anything the mock doesn't serve answers 501 not_mocked, loudly, so a client that calls a route
// nobody mocked finds out at once instead of reaching past the mock to a real server.

import { answerAuth, sessionOf } from "#core/auth.ts";
import { answerControls } from "#core/controls.ts";
import { armedFailure, type Operation, prepare, run } from "#core/graphql.ts";
import { answerHealth } from "#core/health.ts";
import { json, readJson, refuse } from "#core/http.ts";
import { createLogger } from "#core/log.ts";
import {
  maintenanceAllows,
  maintenanceOn,
  maintenanceRefusal,
} from "#core/maintenance.ts";
import { answerPage } from "#core/page.ts";
import { product, settings } from "#core/product.ts";
import { answerSetup } from "#core/setup.ts";

const log = createLogger("http");

/** Origins allowed to call with credentials, from MOCK_CORS_ORIGINS (comma separated). */
const allowedOrigins = () =>
  new Set(
    (process.env.MOCK_CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );

const withCors = (request: Request, response: Response): Response => {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins().has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, x-csrf-token",
  );
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("vary", "origin");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const operationOf = async (request: Request, url: URL): Promise<Operation> => {
  if (request.method === "POST") return readJson<Operation>(request);
  const variables = url.searchParams.get("variables");
  return {
    operationName: url.searchParams.get("operationName"),
    query: url.searchParams.get("query") ?? undefined,
    variables: variables
      ? (JSON.parse(variables) as Record<string, unknown>)
      : null,
  };
};

/** POST /query, and GET /query for a query in the URL (never a mutation, as gqlgen refuses). */
const answerGraphql = async (request: Request, url: URL): Promise<Response> => {
  let input: Operation;
  try {
    input = await operationOf(request, url);
  } catch {
    return json(
      {
        errors: [
          {
            extensions: { code: "BAD_USER_INPUT" },
            message: "The variables aren't JSON.",
          },
        ],
      },
      400,
    );
  }
  const session = sessionOf(request);
  const prepared = prepare(input, session);
  // During maintenance only the product's banner fields answer, and whatever the product's allow
  // hook lets this caller run; everything else gets the maintenance refusal, as the gateway
  // answers in front of a stopped service.
  if (
    maintenanceOn() &&
    !(prepared.ok && maintenanceAllows(prepared.operation, request, session))
  ) {
    return maintenanceRefusal(request, url.pathname) as Response;
  }
  if (!prepared.ok) return json({ errors: prepared.errors }, prepared.status);
  if (prepared.operation.operation === "subscription") {
    return json(
      {
        errors: [
          {
            extensions: { code: "BAD_USER_INPUT" },
            message: "Subscribe over the websocket.",
          },
        ],
      },
      400,
    );
  }
  if (request.method === "GET" && prepared.operation.operation === "mutation") {
    return json(
      {
        errors: [
          {
            extensions: { code: "BAD_USER_INPUT" },
            message: "Send a mutation with POST.",
          },
        ],
      },
      405,
    );
  }
  const failure = armedFailure();
  if (failure) return failure;
  return json(await run(prepared, input, session));
};

const route = async (request: Request, url: URL): Promise<Response> => {
  const path = url.pathname;
  if (
    path === settings().graphqlPath &&
    (request.method === "POST" || request.method === "GET")
  ) {
    return answerGraphql(request, url);
  }
  // In order: the core's own paths, the maintenance refusal while maintenance is on, then the
  // product's routes, then the core's /auth and /setup
  // (whose catch-alls answer 404 for paths they don't know). Each is awaited before the next is
  // asked, so a route that answers nothing asynchronously still falls through.
  const answerers = [
    answerHealth,
    answerPage,
    answerControls,
    maintenanceRefusal,
    product().routes,
    answerAuth,
    answerSetup,
  ];
  for (const answerer of answerers) {
    const answer = await answerer?.(request, path);
    if (answer) return answer;
  }
  return refuse(501, "not_mocked");
};

/** Answer one request. */
export const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === "OPTIONS")
    return withCors(request, new Response(null, { status: 204 }));
  const started = Date.now();
  let response: Response;
  try {
    response = await route(request, url);
  } catch (error) {
    // A route that throws still answers, so the client sees a failure instead of waiting forever.
    log.error("route failed", {
      error: String(error),
      method: request.method,
      path: url.pathname,
    });
    response = refuse(500, "internal");
  }
  // Paths and statuses only: bodies carry passwords and tokens, even invented ones.
  log.debug("request answered", {
    method: request.method,
    ms: Date.now() - started,
    path: url.pathname,
    status: response.status,
  });
  return withCors(request, response);
};
