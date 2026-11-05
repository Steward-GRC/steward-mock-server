// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A small product that exists only for the core tests. The core tests hand the core this product
// and never the one in src/product, so they pass unchanged in every product that cloned the
// template, whatever its own schema and data are. It differs from the sample on purpose (other
// names, other records, another GraphQL path), so a core test that leaned on the sample would fail
// here first.

import type { WebSocket } from "ws";

import type { ControlBody } from "#core/controls.ts";
import type { Product, ProductData } from "#core/product.ts";

import { sessionOf, sessionOfCookie } from "#core/auth.ts";
import { publish, subscribe } from "#core/events.ts";
import { type Context, MockError, signedIn, withRole } from "#core/graphql.ts";
import { json, newId } from "#core/http.ts";
import { maintenance, maintenanceAnswer } from "#core/maintenance.ts";
import { mockState, personById } from "#core/state.ts";

export interface Note {
  authorId: string;
  id: string;
  text: string;
}

interface FixtureData extends ProductData {
  notes: Note[];
}

const NOTE_ADDED = "fixture:note-added";

/** The fixture's websocket relay: the sockets open on each room, by room name. */
const rooms = new Map<string, Set<WebSocket>>();

const data = () => mockState.data as FixtureData;

const addNote = (authorId: string, text: string): Note => {
  const note = { authorId, id: newId("note"), text };
  data().notes.push(note);
  publish(NOTE_ADDED, note);
  return note;
};

const SCHEMA = `
type Query {
  status: Status!
  me: Person!
  notes: [Note!]!
  note(id: ID!): Note
}
type Mutation {
  addNote(text: String!): Note!
  removeNote(id: ID!): Boolean!
}
type Subscription {
  noteAdded: Note!
}
type Status { name: String! version: String! }
type Person { id: ID! username: String! name: String! }
type Note { id: ID! text: String! author: Person! }
`;

/** Schema the fixture serves ahead of its "real gateway", kept in a file of its own. */
const PENDING_SCHEMA = `
extend type Query {
  noteCount: Int!
}
`;

/** The fixture's maintenance banner query, which keeps answering while maintenance is on. */
const MAINTENANCE_SCHEMA = `
type MaintenanceInfo {
  state: String!
  message: String
  startsAt: String
  endsAt: String
}
extend type Query {
  maintenance: MaintenanceInfo!
}
`;

export const FIXTURE_VERSION = "v9.9.9-fixture";

export const fixture: Product = {
  actions: [
    {
      kind: "add-note",
      label: "Add a note",
      run: (body: ControlBody) => ({
        id: addNote(
          "person-ben",
          typeof body.text === "string" ? body.text : "From the controls",
        ).id,
      }),
      section: "Notes",
    },
  ],
  // Its banner query keeps answering during maintenance, and its refusal carries a header of its
  // own on top of the core's default answer.
  maintenance: {
    allow: (_request, session) =>
      session !== null &&
      (personById(session.personId)?.roles.includes("ADMIN") ?? false),
    answer: (_request, _path, window) => {
      const answer = maintenanceAnswer(window);
      answer.headers.set("x-fixture-maintenance", "on");
      return answer;
    },
    fields: ["maintenance"],
  },
  resolvers: {
    Mutation: {
      addNote: (_root, given: { text: string }, context: Context) => {
        const person = signedIn(context);
        if (!given.text.trim())
          throw new MockError("BAD_USER_INPUT", "Write something.");
        return addNote(person.id, given.text.trim());
      },
      removeNote: (_root, given: { id: string }, context: Context) => {
        withRole(context, "ADMIN");
        const before = data().notes.length;
        data().notes = data().notes.filter((note) => note.id !== given.id);
        if (data().notes.length === before)
          throw new MockError("NOT_FOUND", "No such note.");
        return true;
      },
    },
    Note: {
      author: (note) => personById((note as Note).authorId),
    },
    Query: {
      maintenance: () => maintenance(),
      me: (_root, _given, context: Context) => signedIn(context),
      note: (_root, given: { id: string }, context: Context) => {
        signedIn(context);
        return data().notes.find((note) => note.id === given.id) ?? null;
      },
      noteCount: (_root, _given, context: Context) => {
        signedIn(context);
        return data().notes.length;
      },
      notes: (_root, _given, context: Context) => {
        signedIn(context);
        return data().notes;
      },
      status: () => ({ name: "Fixture", version: FIXTURE_VERSION }),
    },
    Subscription: {
      noteAdded: {
        resolve: (note) => note,
        subscribe: (_root, _given, context: Context) => {
          signedIn(context);
          return subscribe<Note>(NOTE_ADDED);
        },
      },
    },
  },
  routes: (request, path) => {
    if (request.method === "GET" && path === "/fixture/whoami") {
      return json({ personId: sessionOf(request)?.personId ?? null });
    }
    // A sign-in path the core doesn't know: it must reach the product, not the core's 404.
    if (request.method === "GET" && path === "/auth/fixture-start") {
      return new Response(null, {
        headers: { location: "/signed-in" },
        status: 302,
      });
    }
    if (path === "/fixture/boom") throw new Error("a product route failed");
    // The core keeps its own paths: this never answers.
    if (path === "/livez") return new Response(null, { status: 418 });
    return;
  },
  schema: [SCHEMA, PENDING_SCHEMA, MAINTENANCE_SCHEMA],
  seed: (): FixtureData => ({
    notes: [
      { authorId: "person-ada", id: "note-1", text: "First note" },
      { authorId: "person-ben", id: "note-2", text: "Second note" },
    ],
    people: [
      {
        email: "ada@example.org",
        id: "person-ada",
        name: "Ada Admin",
        roles: ["ADMIN"],
        secondFactor: true,
        username: "ada",
      },
      {
        email: "ben@example.org",
        id: "person-ben",
        name: "Ben Staff",
        roles: ["STAFF"],
        secondFactor: true,
        username: "ben",
      },
      {
        email: "cy@example.org",
        id: "person-cy",
        name: "Cy Phone",
        roles: ["STAFF"],
        secondFactor: false,
        username: "cy",
      },
      {
        disabled: true,
        email: "dot@example.org",
        id: "person-dot",
        name: "Dot Disabled",
        roles: ["STAFF"],
        secondFactor: false,
        username: "dot",
      },
    ],
  }),
  settings: {
    graphqlPath: "/gql",
    name: "Fixture",
    port: 5999,
    publicFields: ["status", "maintenance"],
    sessionCookie: "fixture_session",
    version: FIXTURE_VERSION,
    versionHeader: "Fixture-Version",
  },
  // A relay between the clients on one room, signed in by cookie, the way a gateway proxies an
  // editor's collaboration socket.
  sockets: (request, path) => {
    const room = /^\/fixture\/relay\/([^/]+)$/.exec(path)?.[1];
    if (!room) return;
    if (!sessionOfCookie(request)) {
      return new Response("unauthorized", {
        headers: { "content-type": "text/plain" },
        status: 401,
      });
    }
    return (socket) => {
      const peers = rooms.get(room) ?? new Set<WebSocket>();
      peers.add(socket);
      rooms.set(room, peers);
      socket.on("message", (data, isBinary) => {
        for (const peer of peers) {
          if (peer !== socket && peer.readyState === peer.OPEN)
            peer.send(data, { binary: isBinary });
        }
      });
      socket.on("close", () => peers.delete(socket));
    };
  },
  summary: () => ({ notes: data().notes.length }),
};
