// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock as a network server: plain HTTP, and HTTPS too when given a certificate (an iOS app
// refuses plain HTTP outside its exceptions). Both share one state and one websocket server.

import type { AddressInfo, Server } from "node:net";

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { handle } from "#core/handle.ts";
import { settings } from "#core/product.ts";
import { createWebSocketServer } from "#core/websocket.ts";

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

/** Start the mock gateway on a port. */
export const startMockServer = async ({
  host = "127.0.0.1",
  port = settings().port,
  tls,
}: MockServerOptions = {}): Promise<RunningMockServer> => {
  const sockets = createWebSocketServer();
  const upgrade = (server: Server) =>
    server.on("upgrade", (incoming: IncomingMessage, socket, head) => {
      if (
        new URL(incoming.url ?? "/", "https://mock.invalid").pathname !==
        settings().graphqlPath
      ) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(incoming, socket, head, (ws) =>
        sockets.emit("connection", ws, incoming),
      );
    });
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
      for (const client of sockets.clients) client.terminate();
      sockets.close();
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
