// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Acknowledgements and the audit trail. Anyone acknowledges for themselves; the roster, the
// completion report and the export need compliance.report (compliance admins, site admins); the
// audit log needs audit.read, or answers a group manager only their own groups' records.

import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  notFound,
  now,
  people,
  record,
  refuse,
  withAnyRole,
} from "#product/resolvers/shared.ts";

/** A pending acknowledgement counts as overdue this long after publishing. */
const OVERDUE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const versionFor = (id: string) =>
  found(
    data().versions.find((v) => v.id === id),
    "policy version",
  );

const reporter = (context: Context) => withAnyRole(context, "compliance-admin");

/** Everyone the acknowledgement is asked of: every active account, or one group's members. */
const audience = (groupId?: null | string): StewardPerson[] =>
  people().filter(
    (p) =>
      !p.deletedAt &&
      !p.disabled &&
      (!groupId || p.memberships.some((m) => m.groupId === groupId)),
  );

const entry = (p: StewardPerson, ackedAt: null | string) => ({
  ackedAt,
  email: p.email,
  userId: p.id,
  userName: p.name,
});

const roster = (policyVersionId: string, groupId?: null | string) => {
  const acks = data().acknowledgements.filter(
    (a) => a.policyVersionId === policyVersionId,
  );
  const acked = [];
  const pending = [];
  for (const person of audience(groupId)) {
    const ack = acks.find((a) => a.userId === person.id);
    if (ack) acked.push(entry(person, ack.ackedAt));
    else pending.push(entry(person, null));
  }
  return { acked, pending };
};

/** May the person read the audit log, and for which groups (null for all)? */
const auditScope = (person: StewardPerson): null | string[] => {
  if (isSiteAdmin(person) || person.roles.includes("compliance-admin"))
    return null;
  if (person.managedGroupIds.length > 0) return person.managedGroupIds;
  throw forbidden();
};

const recordsFor = (person: StewardPerson) => {
  const scope = auditScope(person);
  return data().audit.filter((r) => !scope || scope.includes(r.groupId));
};

export const complianceResolvers: Resolvers = {
  Mutation: {
    recordAck: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const version = versionFor(given.policyVersionId);
      let ack = data().acknowledgements.find(
        (a) => a.policyVersionId === version.id && a.userId === person.id,
      );
      if (!ack) {
        ack = {
          ackedAt: now(),
          policyVersionId: version.id,
          userId: person.id,
        };
        data().acknowledgements.push(ack);
        const policy = data().policies.find((p) => p.id === version.policyId);
        record("policy.acknowledged", person, {
          groupId: policy?.homeCategoryId,
          id: version.policyId,
          kind: "policy",
          label: policy?.title ?? null,
        });
      }
      return { ...ack, id: `${ack.policyVersionId}:${ack.userId}` };
    },
  },
  Query: {
    ackRoster: (
      _root,
      given: { groupId?: null | string; policyVersionId: string },
      context: Context,
    ) => {
      reporter(context);
      versionFor(given.policyVersionId);
      return roster(given.policyVersionId, given.groupId);
    },
    ackStatus: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const ack = data().acknowledgements.find(
        (a) =>
          a.policyVersionId === given.policyVersionId && a.userId === person.id,
      );
      return { ackedAt: ack?.ackedAt ?? null, acknowledged: Boolean(ack) };
    },
    auditLog: (
      _root,
      given: {
        actorUserId?: null | string;
        groupId?: null | string;
        pageSize?: null | number;
        pageToken?: null | string;
        subject?: null | string;
        tier?: null | string;
      },
      context: Context,
    ) => {
      const matching = recordsFor(caller(context))
        .filter((r) => !given.tier || r.tier === given.tier)
        .filter((r) => !given.groupId || r.groupId === given.groupId)
        .filter(
          (r) => !given.actorUserId || r.actorUserId === given.actorUserId,
        )
        .filter((r) => !given.subject || r.subject === given.subject)
        .toReversed();
      const start = Number(given.pageToken || 0);
      const size = given.pageSize && given.pageSize > 0 ? given.pageSize : 50;
      const end = start + size;
      return {
        nextPageToken: end < matching.length ? String(end) : "",
        records: matching.slice(start, end),
      };
    },
    completionReport: (
      _root,
      given: { groupId?: null | string; policyVersionId: string },
      context: Context,
    ) => {
      reporter(context);
      const version = versionFor(given.policyVersionId);
      const { acked, pending } = roster(version.id, given.groupId);
      const total = acked.length + pending.length;
      const published = version.publishedAt
        ? Date.parse(version.publishedAt)
        : Date.now();
      const days = acked.map(
        (a) => (Date.parse(a.ackedAt ?? "") - published) / DAY_MS,
      );
      const overdue = Date.now() - published > OVERDUE_DAYS * DAY_MS;
      return {
        avgDaysToAck:
          days.length === 0
            ? 0
            : Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) /
              10,
        completionPct:
          total === 0 ? 0 : Math.round((acked.length / total) * 100),
        overdue: overdue
          ? pending.map(({ email, userId, userName }) => ({
              email,
              userId,
              userName,
            }))
          : [],
        totalAcked: acked.length,
        totalAudience: total,
        viewedNotAckedCount: 0,
      };
    },
    exportAcks: (
      _root,
      given: { format: string; policyVersionId: string },
      context: Context,
    ) => {
      reporter(context);
      if (given.format !== "csv")
        throw refuse("BAD_USER_INPUT", "Acknowledgements export as csv.");
      const { acked, pending } = roster(versionFor(given.policyVersionId).id);
      const rows = [
        "userId,email,userName,ackedAt",
        ...[...acked, ...pending].map(
          (r) => `${r.userId},${r.email},${r.userName},${r.ackedAt ?? ""}`,
        ),
      ];
      return {
        contentType: "text/csv",
        data: Buffer.from(rows.join("\n"), "utf8").toString("base64"),
        filename: `acknowledgements-${newId("export")}.csv`,
      };
    },
    verifyAuditChain: (
      _root,
      given: { fromRecordId: string; toRecordId: string },
      context: Context,
    ) => {
      const records = recordsFor(caller(context));
      const from = Number(given.fromRecordId);
      const to = Number(given.toRecordId);
      const ids = new Set(records.map((r) => Number(r.id)));
      if (!ids.has(from) || !ids.has(to)) throw notFound("audit record");
      const [low, high] = from <= to ? [from, to] : [to, from];
      const segment = data().audit.filter(
        (r) => Number(r.id) >= low && Number(r.id) <= high,
      );
      const errors = segment
        .slice(1)
        .filter((r, index) => r.prevHash !== segment[index]?.recordHash)
        .map((r) => `record ${r.id} does not chain from the one before it`);
      return {
        errors,
        recordsChecked: segment.length,
        valid: errors.length === 0,
      };
    },
  },
};
