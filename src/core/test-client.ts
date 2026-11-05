// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Helpers the tests share: a running mock on a free port, and the calls a client makes.

import { WebSocket } from "ws";

import { type Product, settings, useProduct } from "#core/product.ts";
import { type RunningMockServer, startMockServer } from "#core/server.ts";
import { fixture } from "#core/test-fixture.ts";

export interface Signed {
  cookie: string;
  csrf: string;
  token?: string;
}

export const GOOD_CODE = "123456";

/** Hand the core a product (the test fixture unless a test names another) and start it on a free port. */
export const startForTests = async (
  product: Product = fixture,
): Promise<{
  base: string;
  server: RunningMockServer;
}> => {
  useProduct(product);
  const server = await startMockServer({ port: 0 });
  return { base: `http://127.0.0.1:${String(server.port)}`, server };
};

export const post = (
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

/**
 * Sign in with a password and, when asked, the second factor. The seeds give each person the
 * password `<username>-password`.
 */
export const signIn = async (
  base: string,
  username: string,
  token = false,
  password = `${username}-password`,
): Promise<Signed> => {
  let answer = await post(base, "/auth/login", {
    password,
    token,
    username,
  });
  let body = (await answer.json()) as Record<string, string>;
  if (body.mfaRequired) {
    answer = await post(base, "/auth/verify", {
      code: GOOD_CODE,
      pendingId: body.pendingId,
      token,
    });
    body = (await answer.json()) as Record<string, string>;
  }
  const cookie =
    (answer.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  return { cookie, csrf: body.csrfToken ?? "", token: body.accessToken };
};

export const headersFor = (signed: Signed): Record<string, string> =>
  signed.token
    ? { authorization: `Bearer ${signed.token}` }
    : { cookie: signed.cookie, "x-csrf-token": signed.csrf };

export const query = async (
  base: string,
  text: string,
  signed?: Signed,
  variables?: Record<string, unknown>,
) => {
  const answer = await post(
    base,
    settings().graphqlPath,
    { query: text, variables },
    signed ? headersFor(signed) : {},
  );
  return {
    body: (await answer.json()) as {
      data?: Record<string, unknown>;
      errors?: { extensions: { code: string } }[];
    },
    status: answer.status,
  };
};

export const control = async (base: string, body: Record<string, unknown>) =>
  (await post(base, "/_mock/controls", body)).json() as Promise<
    Record<string, unknown>
  >;

/** An open websocket that queues what the server sends. */
export const openSocket = async (
  base: string,
  protocol: string,
  headers: Record<string, string> = {},
) => {
  const socket = new WebSocket(
    `${base.replace("http", "ws")}${settings().graphqlPath}`,
    protocol,
    { headers },
  );
  const inbox: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (raw) => {
    inbox.push(JSON.parse(String(raw)) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<number>((done) =>
    socket.on("close", (code) => done(code)),
  );
  await new Promise((ready, failed) => {
    socket.once("open", ready);
    socket.once("error", failed);
  });
  /** The next message of a type, waiting for it when it hasn't come yet. */
  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (;;) {
      const at = inbox.findIndex((m) => m.type === type);
      if (at !== -1) return inbox.splice(at, 1)[0] as Record<string, unknown>;
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  const send = (message: object) => socket.send(JSON.stringify(message));
  return { closed, next, send, socket };
};

export { WRONG_CODE } from "#core/auth.ts";
export { startFresh } from "#core/state.ts";
