// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What the mock answers for each field of steward-gateway's schema, merged from one module per
// domain in resolvers/. Resolvers read and change mockState.data, refuse with the gateway's
// codes, and write each change to the audit trail, which publishes it to every open liveEvents
// subscription from every client. Fields with no resolver answer null, or an error where the
// schema says non-null.

import { GraphQLError } from "graphql";

import { subscribe } from "#core/events.ts";
import { type Context, type Resolvers, signedIn } from "#core/graphql.ts";
import { impersonationOf } from "#product/impersonation.ts";
import { accountResolvers } from "#product/resolvers/accounts.ts";
import { adminResolvers } from "#product/resolvers/admin.ts";
import { aiResolvers } from "#product/resolvers/ai.ts";
import { caseResolvers } from "#product/resolvers/cases.ts";
import { complianceResolvers } from "#product/resolvers/compliance.ts";
import { libraryResolvers } from "#product/resolvers/library.ts";
import { policyResolvers } from "#product/resolvers/policies.ts";
import { raciResolvers } from "#product/resolvers/raci.ts";
import { searchResolvers } from "#product/resolvers/search.ts";
import {
  LIVE_EVENTS,
  type LiveEvent,
  refuse,
} from "#product/resolvers/shared.ts";
import { userResolvers } from "#product/resolvers/users.ts";
import { workflowResolvers } from "#product/resolvers/workflow.ts";

export { announce, type LiveEvent } from "#product/resolvers/shared.ts";
export { asUser, permissionsOf } from "#product/resolvers/users.ts";

/** The roles steward-authz grants audit.read, which liveEvents needs. */
const AUDIT_READERS = new Set(["compliance-admin", "site-admin"]);

const liveResolvers: Resolvers = {
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
          throw refuse(
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

const domains: Resolvers[] = [
  accountResolvers,
  adminResolvers,
  aiResolvers,
  caseResolvers,
  complianceResolvers,
  libraryResolvers,
  liveResolvers,
  policyResolvers,
  raciResolvers,
  searchResolvers,
  userResolvers,
  workflowResolvers,
];

/** Every domain's fields, by type; a field two domains both answer is a mistake. */
const merge = (maps: Resolvers[]): Resolvers => {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const map of maps)
    for (const [type, fields] of Object.entries(map)) {
      const into = (merged[type] ??= {});
      for (const [field, resolver] of Object.entries(fields ?? {})) {
        if (field in into)
          throw new Error(`two resolver modules answer ${type}.${field}`);
        into[field] = resolver;
      }
    }
  return merged as Resolvers;
};

/**
 * steward-gateway's impersonation denylist (internal/resolvers/impersonation_denylist.go): the
 * high-risk mutations refused while the request acts as another person.
 */
const IMPERSONATION_DENYLIST = [
  "resetUserPassword",
  "enrollTotpBegin",
  "enrollTotpConfirm",
  "sendEnrollEmailOtp",
  "verifyEnrollEmailOtp",
  "webauthnRegisterBegin",
  "webauthnRegisterFinish",
  "removeFactor",
  "removeWebauthnCredential",
  "renameMfaMethod",
  "removeUserMfaFactor",
  "renameUserMfaFactor",
  "disableUser",
  "enableUser",
  "deleteOrganization",
  "deleteGroupMapping",
  "grantRole",
  "revokeRole",
  "setUserPolicyOverride",
  "addUserToGroup",
  "removeUserFromGroup",
  "revokeUserSessions",
  "revokeMagicLink",
  "createLocalUser",
  "recordAck",
  "shredAuditSubject",
  "createAuditLegalHold",
  "releaseAuditLegalHold",
  "startImpersonation",
];

type FieldResolver = (
  root: unknown,
  given: unknown,
  context: Context,
  info: unknown,
) => unknown;

/** Refuse a denylisted mutation while the request acts as someone, as the gateway's middleware does. */
const guarded = (map: Resolvers): Resolvers => {
  const mutations = (map.Mutation ?? {}) as Record<string, unknown>;
  for (const field of IMPERSONATION_DENYLIST) {
    const resolve = mutations[field];
    if (typeof resolve !== "function") continue;
    mutations[field] = (
      root: unknown,
      given: unknown,
      context: Context,
      info: unknown,
    ) => {
      if (impersonationOf(context))
        throw new GraphQLError(
          `not allowed while acting as another user: "${field}" is a high-risk operation`,
          { extensions: { code: "IMPERSONATION_DENIED", field } },
        );
      return (resolve as FieldResolver)(root, given, context, info);
    };
  }
  return map;
};

export const resolvers: Resolvers = guarded(merge(domains));
