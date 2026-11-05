// Copyright 2026 The template-node-mock-server Authors
// SPDX-License-Identifier: Apache-2.0
// The sample product's own tests: its schema, resolvers and controls, served through the core. A
// product replaces these with tests for what it fills in; the core's tests need no change.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import {
  control,
  openSocket,
  query,
  signIn,
  startForTests,
  startFresh,
} from "#core/test-client.ts";
import { example } from "#product/product.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests(example));
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});

describe("the sample product", () => {
  it("serves its public server info at /query before sign-in", async () => {
    const { body } = await query(
      base,
      "{ serverInfo { name version needsSetup } }",
    );
    assert.deepEqual(body.data, {
      serverInfo: {
        name: "Example",
        needsSetup: false,
        version: "v0.1.0-mock",
      },
    });
  });

  it("lists the items, filtered by status", async () => {
    const bob = await signIn(base, "bob");
    const { body } = await query(
      base,
      "{ items(status: DONE) { id owner { username } } }",
      bob,
    );
    assert.deepEqual(body.data, {
      items: [{ id: "item-3", owner: { username: "bob" } }],
    });
  });

  it("lets admins delete an item and nobody else", async () => {
    const bob = await signIn(base, "bob");
    assert.equal(
      (await query(base, 'mutation { deleteItem(id: "item-1") }', bob)).body
        .errors?.[0]?.extensions.code,
      "FORBIDDEN",
    );
    const alice = await signIn(base, "alice");
    assert.deepEqual(
      (await query(base, 'mutation { deleteItem(id: "item-1") }', alice)).body
        .data,
      { deleteItem: true },
    );
  });

  it("tells every open client when an item changes", async () => {
    const carol = await signIn(base, "carol", true);
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ payload: { authToken: carol.token }, type: "connection_init" });
    await ws.next("connection_ack");
    ws.send({
      id: "1",
      payload: {
        query: "subscription { itemChanged { kind item { title } } }",
      },
      type: "subscribe",
    });
    await new Promise((settle) => setTimeout(settle, 50));
    await control(base, { kind: "finish-items" });
    const message = await ws.next("next");
    assert.equal(
      (message.payload as { data: { itemChanged: { kind: string } } }).data
        .itemChanged.kind,
      "UPDATED",
    );
    ws.socket.close();
  });

  it("counts its items on the controls page", async () => {
    const state = await control(base, {
      kind: "add-item",
      title: "From the page",
    });
    assert.deepEqual(state.summary, { doneItems: 1, openItems: 4, people: 4 });
  });
});
