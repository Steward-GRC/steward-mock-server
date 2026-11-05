// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Acting as another person, as steward-gateway keeps it (internal/bff ImpersonationMiddleware and
// internal/resolvers/impersonation_resolver.go): the record lives on the admin's own session for
// 30 minutes, and while it's live every request on that session runs as the target. The real
// admin stays on the record, which impersonationStatus, stopImpersonation and the audit read.

import type { Context } from "#core/graphql.ts";

import { personById } from "#core/state.ts";

/** The gateway's impersonationTTL. */
const TTL_MS = 30 * 60_000;

export interface Impersonation {
  adminUserId: string;
  expiresAt: number;
  reason: string;
  startedAt: number;
  targetUserId: string;
}

/** Live records by session id. A session that ends takes its record with it. */
const records = new Map<string, Impersonation>();

/** The live record on the request's session, clearing an expired one. */
export const impersonationOf = (
  context: Context,
): Impersonation | undefined => {
  const sid = context.session?.id;
  if (!sid) return undefined;
  const record = records.get(sid);
  if (record && record.expiresAt <= Date.now()) {
    records.delete(sid);
    return undefined;
  }
  return record;
};

export const startImpersonating = (
  sessionId: string,
  adminUserId: string,
  targetUserId: string,
  reason: string,
): Impersonation => {
  const startedAt = Math.floor(Date.now() / 1000) * 1000;
  const record = {
    adminUserId,
    expiresAt: startedAt + TTL_MS,
    reason,
    startedAt,
    targetUserId,
  };
  records.set(sessionId, record);
  return record;
};

export const stopImpersonating = (
  sessionId: string,
): Impersonation | undefined => {
  const record = records.get(sessionId);
  records.delete(sessionId);
  return record;
};

/** The person the request acts as: the target while a record is live, else the signed-in one. */
export const actingAs = (context: Context) => {
  const record = impersonationOf(context);
  return record ? personById(record.targetUserId) : undefined;
};
