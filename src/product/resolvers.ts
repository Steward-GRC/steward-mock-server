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

/**
 * steward-authz's role grants, as steward-web mirrors them (packages/auth/src/catalog.ts).
 * Reader is implicit: everyone who can sign in may read.
 */
const ALL_PERMISSIONS = [
  "admin.manage",
  "audit.read",
  "compliance.manage",
  "group.manage",
  "policy.approve",
  "policy.author",
  "policy.read",
  "policy.read_sensitive",
  "reporting.manage",
  "session.manage",
  "settings.manage",
  "template.manage",
  "user.manage",
];
const ROLE_GRANTS: Record<string, readonly string[]> = {
  approver: ["policy.read", "policy.approve"],
  author: ["policy.read", "policy.author"],
  "compliance-admin": ["policy.read", "compliance.manage", "audit.read"],
  "privacy-officer": ["policy.read", "reporting.manage"],
  "site-admin": ALL_PERMISSIONS,
  "template-admin": ["policy.read", "template.manage"],
};

/** The permissions a set of roles grants, reader's included, in grant order. */
export const permissionsOf = (roles: readonly string[]): string[] => [
  ...new Set([
    "policy.read",
    ...roles.flatMap((role) => ROLE_GRANTS[role] ?? []),
  ]),
];

/** A person as the gateway's User type. */
export const asUser = (person: Person) => ({
  ...firstAndLast(person.name),
  deletedAt: null,
  email: person.email,
  enabled: !person.disabled,
  groupIds: [],
  idpGroups: [],
  isRoot: person.id === mockState.data.people[0]?.id,
  localAccount: true,
  locale: "en",
  managedGroupIds: [],
  memberships: [],
  mergedIntoUserId: null,
  name: person.name,
  needsOnboarding: false,
  permissions: permissionsOf(person.roles),
  policyOverrides: [],
  roles: person.roles,
  scopes: { approver: [], author: [] },
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
