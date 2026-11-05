// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What the mock answers for each field of steward-gateway's schema. Resolvers read and change
// mockState.data, throw MockError with the gateway's codes, and publish live events so every
// open liveEvents subscription, from every client, hears them. Fields with no resolver answer
// null, or an error where the schema says non-null.

import type { Person } from "#core/state.ts";
import type { GlobalSettings } from "#product/data.ts";

import { publish, subscribe } from "#core/events.ts";
import {
  type Context,
  MockError,
  type Resolvers,
  signedIn,
  withRole,
} from "#core/graphql.ts";
import { mockState } from "#core/state.ts";

const LIVE_EVENTS = "live-events";

/** The roles steward-authz grants audit.read, which liveEvents needs. */
const AUDIT_READERS = new Set(["compliance-admin", "site-admin"]);

export interface LiveEvent {
  actorUserId: null | string;
  at: string;
  entityId: null | string;
  groupId: null | string;
  type: string;
}

/** Publish a domain event, as the gateway does for each audit entry. */
export const announce = (
  type: string,
  actor: null | Person,
  entityId: null | string = null,
) => {
  const event: LiveEvent = {
    actorUserId: actor?.id ?? null,
    at: new Date().toISOString(),
    entityId,
    groupId: null,
    type,
  };
  publish(LIVE_EVENTS, event);
};

const firstAndLast = (name: string) => {
  const [first = "", ...rest] = name.split(" ");
  return { firstName: first, lastName: rest.join(" ") };
};

/** A person as the gateway's User type, for the fields the mock knows so far. */
const asUser = (person: Person) => ({
  ...firstAndLast(person.name),
  email: person.email,
  enabled: !person.disabled,
  name: person.name,
  roles: person.roles,
  userId: person.id,
  username: person.username,
});

export const resolvers: Resolvers = {
  Mutation: {
    setGlobalSettings: (
      _root,
      given: { input: GlobalSettings },
      context: Context,
    ) => {
      const admin = withRole(context, "site-admin");
      const { announcement, maintenance } = given.input;
      if (announcement.enabled && !announcement.message.trim())
        throw new MockError(
          "BAD_USER_INPUT",
          "An enabled announcement needs a message.",
        );
      mockState.data.settings = { announcement, maintenance };
      announce("settings.updated", admin);
      return mockState.data.settings;
    },
  },
  Query: {
    globalSettings: () => mockState.data.settings,
    me: (_root, _arguments, context: Context) => asUser(signedIn(context)),
  },
  Subscription: {
    liveEvents: {
      resolve: (event) => event,
      subscribe: (
        _root,
        given: { topics?: null | string[] },
        context: Context,
      ) => {
        const person = signedIn(context);
        if (!person.roles.some((role) => AUDIT_READERS.has(role)))
          throw new MockError(
            "FORBIDDEN",
            "Live updates need the audit log's read permission.",
          );
        const topics = given.topics ?? [];
        const events = subscribe<LiveEvent>(LIVE_EVENTS);
        if (topics.length === 0) return events;
        return (async function* () {
          try {
            for await (const event of events)
              if (topics.some((prefix) => event.type.startsWith(prefix)))
                yield event;
          } finally {
            await events.return?.();
          }
        })();
      },
    },
  },
};
