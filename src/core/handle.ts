/*
MIT License

Copyright (c) 2026 Shane

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/
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
import { answerPage } from "#core/page.ts";
import { answerSetup } from "#core/setup.ts";

const log = createLogger("http");

/** The GraphQL path, for HTTP and the websocket alike. */
export const GRAPHQL_PATH = "/query";

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
    path === GRAPHQL_PATH &&
    (request.method === "POST" || request.method === "GET")
  ) {
    return answerGraphql(request, url);
  }
  const answer =
    answerHealth(request, path) ??
    answerPage(request, path) ??
    answerControls(request, path) ??
    answerAuth(request, path) ??
    answerSetup(request, path);
  return (await answer) ?? refuse(501, "not_mocked");
};

/** Answer one request. */
export const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === "OPTIONS")
    return withCors(request, new Response(null, { status: 204 }));
  const started = Date.now();
  const response = await route(request, url);
  // Paths and statuses only: bodies carry passwords and tokens, even invented ones.
  log.debug("request answered", {
    method: request.method,
    ms: Date.now() - started,
    path: url.pathname,
    status: response.status,
  });
  return withCors(request, response);
};
