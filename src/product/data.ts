// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The invented data the mock serves, made fresh on every reset. Every name, address and record
// here is made up; example.org never delivers mail. A product replaces the items with its own
// records and keeps the people's shape, which the sign-in routes read.

import type { Person } from "#core/state.ts";

export interface Item {
  id: string;
  ownerId: string;
  status: "DONE" | "OPEN";
  title: string;
  updatedAt: string;
}

export interface ProductData {
  items: Item[];
  people: Person[];
}

const MINUTE = 60_000;

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * MINUTE).toISOString();

export const seed = (): ProductData => ({
  items: [
    {
      id: "item-1",
      ownerId: "person-alice",
      status: "OPEN",
      title: "Check the backups ran",
      updatedAt: ago(5),
    },
    {
      id: "item-2",
      ownerId: "person-bob",
      status: "OPEN",
      title: "Renew the test certificate",
      updatedAt: ago(42),
    },
    {
      id: "item-3",
      ownerId: "person-bob",
      status: "DONE",
      title: "Rotate the demo keys",
      updatedAt: ago(180),
    },
    {
      id: "item-4",
      ownerId: "person-carol",
      status: "OPEN",
      title: "Walk the new office floor",
      updatedAt: ago(600),
    },
  ],
  people: [
    {
      email: "alice@example.org",
      id: "person-alice",
      name: "Alice Admin",
      roles: ["ADMIN", "STAFF"],
      secondFactor: true,
      username: "alice",
    },
    {
      email: "bob@example.org",
      id: "person-bob",
      name: "Bob Staff",
      roles: ["STAFF"],
      secondFactor: true,
      username: "bob",
    },
    {
      email: "carol@example.org",
      id: "person-carol",
      name: "Carol Mobile",
      roles: ["STAFF"],
      secondFactor: false,
      username: "carol",
    },
    {
      disabled: true,
      email: "dave@example.org",
      id: "person-dave",
      name: "Dave Disabled",
      roles: ["STAFF"],
      secondFactor: false,
      username: "dave",
    },
  ],
});
