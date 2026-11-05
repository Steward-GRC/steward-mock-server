// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// GraphQL over a websocket on the GraphQL path, the way gqlgen serves it: the
// graphql-transport-ws protocol that current clients speak, and the older graphql-ws protocol
// (subscriptions-transport-ws) that some mobile clients still use. A socket authenticates with
// the session cookie on its upgrade request, or a bearer token in its connection_init payload
// ({ "authToken": "..." } or { "Authorization": "Bearer ..." }). When its session ends (Start
// fresh, an expired session), the socket closes with 4401 and the client signs in again.

import type { IncomingMessage } from "node:http";

import { type WebSocket, WebSocketServer } from "ws";

import { sessionOfCookie, sessionOfToken } from "#core/auth.ts";
import { listen, SESSIONS_ENDED } from "#core/events.ts";
import { type Operation, prepare, run, start } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import { mockState, type Session } from "#core/state.ts";

const log = createLogger("websocket");

const TRANSPORT = "graphql-transport-ws";
const LEGACY = "graphql-ws";

/** How often the legacy protocol's keep-alive goes out: gqlgen's 10 seconds. */
const KEEP_ALIVE_MS = 10_000;
/** How long a client has to send connection_init. */
const INIT_TIMEOUT_MS = 10_000;

interface Message {
  id?: string;
  payload?: Record<string, unknown>;
  type?: string;
}

const tokenOf = (
  payload: Record<string, unknown> | undefined,
): string | undefined => {
  if (!payload) return undefined;
  const headers = (payload.headers ?? {}) as Record<string, unknown>;
  const raw =
    payload.authToken ??
    payload.Authorization ??
    payload.authorization ??
    headers.Authorization ??
    headers.authorization;
  if (typeof raw !== "string") return undefined;
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : raw;
};

const asRequest = (incoming: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined)
      for (const one of [value].flat()) headers.append(name, one);
  }
  return new Request("https://mock.invalid/", { headers });
};

const serve = (socket: WebSocket, incoming: IncomingMessage) => {
  const legacy = socket.protocol === LEGACY;
  const cookieSession = sessionOfCookie(asRequest(incoming));
  let session: null | Session = cookieSession;
  let acknowledged = false;
  const operations = new Map<string, () => void>();

  const send = (message: Message) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const close = (code: number, reason: string) => {
    for (const stop of operations.values()) stop();
    operations.clear();
    socket.close(code, reason);
  };

  const initTimer = setTimeout(() => {
    if (!acknowledged) close(4408, "Connection initialisation timeout");
  }, INIT_TIMEOUT_MS);
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stopListening = listen(SESSIONS_ENDED, () => {
    if (session && !mockState.sessions.has(session.id))
      close(4401, "Unauthorized");
  });

  const finish = (id: string) => {
    operations.delete(id);
    send({ id, type: "complete" });
  };

  const fail = (id: string, errors: object[]) => {
    operations.delete(id);
    if (legacy)
      send({
        id,
        payload: errors[0] as Record<string, unknown>,
        type: "error",
      });
    else
      send({
        id,
        payload: errors as unknown as Record<string, unknown>,
        type: "error",
      });
  };

  const begin = async (id: string, payload: Operation) => {
    const prepared = prepare(payload, session);
    if (!prepared.ok) return fail(id, prepared.errors);
    const data = legacy ? "data" : "next";
    if (prepared.operation.operation !== "subscription") {
      const result = await run(prepared, payload, session);
      send({ id, payload: result as Record<string, unknown>, type: data });
      return finish(id);
    }
    const stream = await start(prepared, payload, session);
    if (!(Symbol.asyncIterator in stream)) {
      send({ id, payload: stream as Record<string, unknown>, type: data });
      return finish(id);
    }
    const iterator = stream[Symbol.asyncIterator]();
    operations.set(id, () => void iterator.return?.());
    log.debug("subscription started", {
      id,
      operation: prepared.operation.name?.value,
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done || !operations.has(id)) break;
      send({ id, payload: next.value as Record<string, unknown>, type: data });
    }
    if (operations.has(id)) finish(id);
  };

  socket.on("message", (raw) => {
    let message: Message;
    try {
      message = JSON.parse(String(raw)) as Message;
    } catch {
      return close(4400, "Invalid message received");
    }
    switch (message.type) {
      case "complete":
      case "stop": {
        const id = message.id ?? "";
        operations.get(id)?.();
        operations.delete(id);
        return;
      }
      case "connection_init": {
        if (acknowledged)
          return close(4429, "Too many initialisation requests");
        clearTimeout(initTimer);
        const token = tokenOf(message.payload);
        if (token) session = sessionOfToken(token);
        acknowledged = true;
        send({ type: "connection_ack" });
        if (legacy) {
          send({ type: "ka" });
          keepAlive = setInterval(() => send({ type: "ka" }), KEEP_ALIVE_MS);
        }
        return;
      }
      case "connection_terminate": {
        return close(1000, "Normal Closure");
      }
      case "ping": {
        return send({ type: "pong" });
      }
      case "pong": {
        return;
      }
      case "start":
      case "subscribe": {
        if (!acknowledged) return close(4401, "Unauthorized");
        const id = message.id ?? "";
        if (operations.has(id))
          return close(4409, `Subscriber for ${id} already exists`);
        operations.set(id, () => {});
        void begin(id, (message.payload ?? {}) as Operation).catch(
          (error: unknown) => {
            log.error("operation failed", { error: String(error), id });
            fail(id, [
              {
                extensions: { code: "INTERNAL" },
                message: "Something went wrong on our side.",
              },
            ]);
          },
        );
        return;
      }
      default: {
        return close(4400, `Unknown message type ${String(message.type)}`);
      }
    }
  });

  socket.on("close", () => {
    clearTimeout(initTimer);
    clearInterval(keepAlive);
    stopListening();
    for (const stop of operations.values()) stop();
    operations.clear();
  });
};

/** The websocket server for the GraphQL path; the HTTP server hands it upgrade requests. */
export const createWebSocketServer = (): WebSocketServer => {
  const server = new WebSocketServer({
    handleProtocols: (protocols) => {
      if (protocols.has(TRANSPORT)) return TRANSPORT;
      if (protocols.has(LEGACY)) return LEGACY;
      return false;
    },
    noServer: true,
  });
  server.on("connection", serve);
  return server;
};
