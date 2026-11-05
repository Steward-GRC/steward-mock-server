// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What every domain's resolvers share: the gateway's refusals, the signed-in person, new ids,
// and the audit trail, which every domain change writes to and announces on liveEvents.

import { GraphQLError } from "graphql";

import type { AuditAction } from "#product/audit-actions.ts";

import { publish } from "#core/events.ts";
import { type Context, signedIn } from "#core/graphql.ts";
import { stewardData } from "#product/data.ts";
import { chained } from "#product/data/admin.ts";
import { asSteward, type StewardPerson } from "#product/data/people.ts";
import { actingAs } from "#product/impersonation.ts";

export const LIVE_EVENTS = "live-events";

export interface LiveEvent {
  actorUserId: null | string;
  at: string;
  entityId: null | string;
  groupId: null | string;
  type: string;
}

/**
 * Why the mock refuses, by kind. Each goes on the wire with the code steward-gateway puts in
 * extensions.code: a service's refusal is relayed with its gRPC status name
 * (internal/server/errors.go, presentStatus), and a gateway fault is INTERNAL.
 */
export type RefusalCode =
  | "ALREADY_EXISTS"
  | "BAD_USER_INPUT"
  | "FAILED_PRECONDITION"
  | "FORBIDDEN"
  | "INTERNAL"
  | "NOT_FOUND";

const GATEWAY_CODES: Record<RefusalCode, string> = {
  ALREADY_EXISTS: "AlreadyExists",
  BAD_USER_INPUT: "InvalidArgument",
  FAILED_PRECONDITION: "FailedPrecondition",
  FORBIDDEN: "PermissionDenied",
  INTERNAL: "INTERNAL",
  NOT_FOUND: "NotFound",
};

export const refuse = (code: RefusalCode, message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: GATEWAY_CODES[code] } });

export const forbidden = (): GraphQLError =>
  refuse("FORBIDDEN", "You don't have permission to do that.");

export const notFound = (what: string): GraphQLError =>
  refuse("NOT_FOUND", `${what} not found`);

/**
 * The person a request acts for, as Steward's directory keeps them: the signed-in person, or the
 * person they act as while impersonating (the gateway swaps the principal the same way).
 */
export const caller = (context: Context): StewardPerson => {
  const real = signedIn(context);
  return asSteward(actingAs(context) ?? real);
};

/** The signed-in person themselves, even while they act as someone else. */
export const realCaller = (context: Context): StewardPerson =>
  asSteward(signedIn(context));

export const isSiteAdmin = (person: StewardPerson): boolean =>
  person.roles.includes("site-admin");

/** The caller when they hold any of `roles` (site-admin holds every permission), else FORBIDDEN. */
export const withAnyRole = (
  context: Context,
  ...roles: string[]
): StewardPerson => {
  const person = caller(context);
  if (isSiteAdmin(person) || roles.some((role) => person.roles.includes(role)))
    return person;
  throw forbidden();
};

export const siteAdmin = (context: Context): StewardPerson =>
  withAnyRole(context);

export const data = () => stewardData();

export const people = (): StewardPerson[] =>
  stewardData().people.map(asSteward);

export const personOf = (id: null | string | undefined) =>
  id ? people().find((p) => p.id === id) : undefined;

/** A new record's id: the kind and a number past every seeded one. */
export const newId = (kind: string): string => {
  const next = stewardData().next[kind] ?? 100;
  stewardData().next[kind] = next + 1;
  return `${kind}-${String(next)}`;
};

export const now = (): string => new Date().toISOString();

/** Find a record or answer NOT_FOUND. */
export const found = <T>(record: T | undefined, what: string): T => {
  if (record === undefined) throw notFound(what);
  return record;
};

/** Publish a domain event, as the gateway does for each audit entry. */
export const announce = (
  type: string,
  actor: { id: string } | null | StewardPerson,
  entityId: null | string = null,
  groupId: null | string = null,
): void => {
  const event: LiveEvent = {
    actorUserId: actor?.id ?? null,
    at: now(),
    entityId,
    groupId,
    type,
  };
  publish(LIVE_EVENTS, event);
};

/** What an audit entry is about: `kind:id` and the label the log shows for it. */
export interface Subject {
  groupId?: string;
  groupName?: null | string;
  id: string;
  kind: string;
  label: null | string;
}

/** Write an audit entry with the action name its service writes, and announce it. */
export const record = (
  action: AuditAction,
  actor: StewardPerson,
  subject: Subject,
): void => {
  const trail = stewardData().audit;
  trail.push(
    chained(trail, {
      action,
      actorName: actor.name,
      actorUserId: actor.id,
      groupId: subject.groupId ?? "",
      groupName: subject.groupName ?? null,
      legalBasisExempt: false,
      occurredAt: now(),
      subject: `${subject.kind}:${subject.id}`,
      subjectLabel: subject.label,
      tier: "audit",
    }),
  );
  announce(action, actor, subject.id, subject.groupId ?? null);
};
