// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock as a network server: plain HTTP, and HTTPS too when given a certificate (an iOS app
// refuses plain HTTP outside its exceptions). Both share one state and one websocket server.

import type { AddressInfo, Server } from "node:net";
import type { Duplex } from "node:stream";

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  STATUS_CODES,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer } from "ws";

import { handle } from "#core/handle.ts";
import { createLogger } from "#core/log.ts";
import { maintenanceGate } from "#core/maintenance.ts";
import { product, type ProductSockets, settings } from "#core/product.ts";
import { createWebSocketServer } from "#core/websocket.ts";

const log = createLogger("server");

export interface MockServerOptions {
  /** Where to listen. Loopback by default: the controls have no sign-in. */
  host?: string;
  /** 0 picks a free port; the result says which. */
  port?: number;
  tls?: { cert: Buffer | string; key: Buffer | string; port: number };
}

export interface RunningMockServer {
  close: () => Promise<void>;
  http: Server;
  https?: Server;
  /** The HTTP port it got. */
  port: number;
}

const bodyOf = async (
  incoming: IncomingMessage,
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  if (incoming.method === "GET" || incoming.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
};

const listener =
  (scheme: "http" | "https"): RequestListener =>
  (incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined)
          for (const one of [value].flat()) headers.append(name, one);
      }
      const url = new URL(
        incoming.url ?? "/",
        `${scheme}://${incoming.headers.host ?? "localhost"}`,
      );
      const body = await bodyOf(incoming);
      const answer = await handle(
        new Request(url, { body, headers, method: incoming.method }),
      );
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of answer.headers.entries())
        if (name !== "set-cookie") out[name] = value;
      const cookies = answer.headers.getSetCookie();
      if (cookies.length > 0) out["set-cookie"] = cookies;
      outgoing.writeHead(answer.status, out);
      outgoing.end(Buffer.from(await answer.arrayBuffer()));
    })();
  };

const listen = (server: Server, port: number, host: string) =>
  new Promise<Server>((ready, failed) => {
    server.once("error", failed);
    server.listen(port, host, () => ready(server));
  });

const closeServer = (server: Server) =>
  new Promise<void>((done) => server.close(() => done()));

/** The upgrade request as a fetch Request, so a product reads it the way it reads any other. */
const requestOf = (incoming: IncomingMessage): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined)
      for (const one of [value].flat()) headers.append(name, one);
  }
  return new Request(
    new URL(
      incoming.url ?? "/",
      `http://${incoming.headers.host ?? "localhost"}`,
    ),
    { headers },
  );
};

/** Refuse an upgrade with an HTTP answer on the raw socket, then close it. */
const refuseUpgrade = async (
  socket: Duplex,
  answer: Response,
): Promise<void> => {
  const body = Buffer.from(await answer.arrayBuffer());
  const lines = [
    `HTTP/1.1 ${String(answer.status)} ${STATUS_CODES[answer.status] ?? ""}`,
  ];
  for (const [name, value] of answer.headers.entries())
    lines.push(`${name}: ${value}`);
  lines.push(
    `content-length: ${String(body.length)}`,
    "connection: close",
    "",
    "",
  );
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
};

/** Start the mock gateway on a port. */
export const startMockServer = async ({
  host = "127.0.0.1",
  port = settings().port,
  tls,
}: MockServerOptions = {}): Promise<RunningMockServer> => {
  const sockets = createWebSocketServer();
  // The product's own websocket paths get a server of their own: no subprotocol to agree on.
  const productSockets = new WebSocketServer({ noServer: true });
  const upgrade = (server: Server) =>
    server.on(
      "upgrade",
      (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = new URL(incoming.url ?? "/", "https://mock.invalid")
          .pathname;
        // While maintenance closes the gateway, a new socket gets the maintenance refusal; open
        // ones stay, and their operations are gated one by one.
        const refused = maintenanceGate(requestOf(incoming), path);
        if (refused) {
          void refuseUpgrade(socket, refused);
          return;
        }
        if (path === settings().graphqlPath) {
          sockets.handleUpgrade(incoming, socket, head, (ws) =>
            sockets.emit("connection", ws, incoming),
          );
          return;
        }
        const request = requestOf(incoming);
        let answer: ReturnType<ProductSockets>;
        try {
          answer = product().sockets?.(request, path);
        } catch (error) {
          log.error("socket route failed", { error: String(error), path });
          answer = Response.json({ error: "internal" }, { status: 500 });
        }
        if (typeof answer === "function") {
          const accept = answer;
          productSockets.handleUpgrade(incoming, socket, head, (ws) =>
            accept(ws, request),
          );
          return;
        }
        void refuseUpgrade(
          socket,
          answer ?? Response.json({ error: "not_mocked" }, { status: 404 }),
        );
      },
    );
  const http = await listen(
    upgrade(createHttpServer(listener("http"))),
    port,
    host,
  );
  const https = tls
    ? await listen(
        upgrade(
          createHttpsServer(
            { cert: tls.cert, key: tls.key },
            listener("https"),
          ),
        ),
        tls.port,
        host,
      )
    : undefined;
  return {
    close: async () => {
      for (const client of [...sockets.clients, ...productSockets.clients])
        client.terminate();
      sockets.close();
      productSockets.close();
      await Promise.all([
        closeServer(http),
        ...(https ? [closeServer(https)] : []),
      ]);
    },
    http,
    https,
    port: (http.address() as AddressInfo).port,
  };
};
