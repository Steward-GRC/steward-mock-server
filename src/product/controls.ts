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
// The product's own buttons on the /_mock page and kinds for POST /_mock/controls, beside the
// core's (reset, fresh, fail-next, expire-session, sign-in). Each changes the shared state the
// way something happening elsewhere would, so every client sees it, and open subscriptions hear it.

import type { Action, ControlBody, ProductControl } from "#core/controls.ts";
import type { Item } from "#product/data.ts";

import { newId } from "#core/http.ts";
import { mockState } from "#core/state.ts";
import { announceItem } from "#product/resolvers.ts";

const addItem = (body: ControlBody) => {
  const item: Item = {
    id: newId("item"),
    ownerId: typeof body.ownerId === "string" ? body.ownerId : "person-bob",
    status: "OPEN",
    title:
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : "An item from the controls",
    updatedAt: new Date().toISOString(),
  };
  mockState.data.items.push(item);
  announceItem(item, "CREATED");
  return { id: item.id };
};

const finishAll = () => {
  for (const item of mockState.data.items.filter(
    (index) => index.status === "OPEN",
  )) {
    Object.assign(item, {
      status: "DONE",
      updatedAt: new Date().toISOString(),
    });
    announceItem(item, "UPDATED");
  }
};

export const productActions: ({ run: ProductControl } & Action)[] = [
  {
    hint: "Bob adds it; every open client hears it.",
    kind: "add-item",
    label: "Add an item",
    run: addItem,
    section: "Items",
  },
  {
    kind: "finish-items",
    label: "Mark every item done",
    run: finishAll,
    section: "Items",
  },
];

/** The counts the controls page shows under Data. */
export const productSummary = (): Record<string, number> => ({
  doneItems: mockState.data.items.filter((index) => index.status === "DONE")
    .length,
  openItems: mockState.data.items.filter((index) => index.status === "OPEN")
    .length,
  people: mockState.data.people.length,
});
