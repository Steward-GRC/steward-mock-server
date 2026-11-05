// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What the mock answers for each field of the product's schema. Resolvers read and change
// mockState.data, and publish changes so every open subscription, from every client, hears them.
// A product replaces these with resolvers for its own schema; src/core wires them in by name.

import type { Item } from "#product/data.ts";

import { publish, subscribe } from "#core/events.ts";
import {
  type Context,
  MockError,
  type Resolvers,
  signedIn,
  withRole,
} from "#core/graphql.ts";
import { newId } from "#core/http.ts";
import { mockState, personById } from "#core/state.ts";
import { product } from "#product/product.ts";

const ITEM_CHANGED = "item-changed";

interface ItemChange {
  item: Item;
  kind: "CREATED" | "DELETED" | "UPDATED";
}

const itemById = (id: string): Item => {
  const item = mockState.data.items.find((candidate) => candidate.id === id);
  if (!item) throw new MockError("NOT_FOUND", "That item doesn't exist.");
  return item;
};

const changed = (change: ItemChange) => {
  publish(ITEM_CHANGED, change);
  return change.item;
};

export const resolvers: Resolvers = {
  Item: {
    owner: (item) => personById((item as Item).ownerId),
  },
  Mutation: {
    createItem: (
      _root,
      given: { input: { title: string } },
      context: Context,
    ) => {
      const person = signedIn(context);
      const title = given.input.title.trim();
      if (!title)
        throw new MockError("BAD_USER_INPUT", "Give the item a title.");
      const item: Item = {
        id: newId("item"),
        ownerId: person.id,
        status: "OPEN",
        title,
        updatedAt: new Date().toISOString(),
      };
      mockState.data.items.push(item);
      return changed({ item, kind: "CREATED" });
    },
    deleteItem: (_root, given: { id: string }, context: Context) => {
      withRole(context, "ADMIN");
      const item = itemById(given.id);
      mockState.data.items = mockState.data.items.filter(
        (kept) => kept.id !== item.id,
      );
      changed({ item, kind: "DELETED" });
      return true;
    },
    setItemStatus: (
      _root,
      given: { id: string; status: Item["status"] },
      context: Context,
    ) => {
      signedIn(context);
      const item = itemById(given.id);
      Object.assign(item, {
        status: given.status,
        updatedAt: new Date().toISOString(),
      });
      return changed({ item, kind: "UPDATED" });
    },
  },
  Query: {
    item: (_root, given: { id: string }, context: Context) => {
      signedIn(context);
      return mockState.data.items.find((item) => item.id === given.id) ?? null;
    },
    items: (_root, given: { status?: Item["status"] }, context: Context) => {
      signedIn(context);
      return mockState.data.items.filter(
        (item) => !given.status || item.status === given.status,
      );
    },
    people: (_root, _arguments, context: Context) => {
      signedIn(context);
      return mockState.data.people.filter((p) => !p.disabled);
    },
    serverInfo: () => ({
      name: product.name,
      needsSetup: mockState.needsSetup,
      version: product.version,
    }),
    viewer: (_root, _arguments, context: Context) => signedIn(context),
  },
  Subscription: {
    itemChanged: {
      resolve: (change) => change,
      subscribe: (_root, _arguments, context: Context) => {
        signedIn(context);
        return subscribe<ItemChange>(ITEM_CHANGED);
      },
    },
  },
};

/** Publish an item change from outside a resolver (the product's controls). */
export const announceItem = (item: Item, kind: ItemChange["kind"]): void => {
  publish(ITEM_CHANGED, { item, kind });
};
