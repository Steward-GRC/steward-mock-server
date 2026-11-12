// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Acknowledgements and the audit trail. Anyone acknowledges for themselves; the roster, the
// completion report and the export need compliance.report (compliance admins, site admins); the
// audit log needs audit.read, or answers a group manager only their own groups' records.

import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { ackTriggersOf, viewerCan } from "#product/access.ts";
import { managedGroupIdsOf, membershipsOf } from "#product/groups.ts";
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * steward-obligations' dueAt: the version's publish time plus the configured days, as ISO-8601;
 * null when due dates are off (0 days) or the version has no publish time.
 */
const dueAtOf = (version: { publishedAt: null | string }): null | string => {
  const days = data().ackDueDays;
  if (days === 0 || !version.publishedAt) return null;
  return new Date(
    Date.parse(version.publishedAt) + days * DAY_MS,
  ).toISOString();
};

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
      (!groupId || membershipsOf(p).some((m) => m.groupId === groupId)),
  );

/** Case-insensitive first, then exact, so "ops" and "Ops" always fall in the same order. */
const byName = (a: string, b: string) => {
  const folded = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  if (folded !== 0) return folded;
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** The platform group names the person belongs to (identity's ListUserGroupNames), sorted. */
const groupNamesOf = (person: StewardPerson): string[] =>
  membershipsOf(person)
    .flatMap(
      (m) => data().platformGroups.find((g) => g.id === m.groupId)?.name ?? [],
    )
    .toSorted(byName);

const entry = (
  p: StewardPerson,
  ackedAt: null | string,
  dueAt: null | string = null,
) => ({
  ackedAt,
  dueAt,
  email: p.email,
  groups: groupNamesOf(p),
  userId: p.id,
  userName: p.name,
});

const roster = (policyVersionId: string, groupId?: null | string) => {
  const acks = data().acknowledgements.filter(
    (a) => a.policyVersionId === policyVersionId,
  );
  const dueAt = dueAtOf(versionFor(policyVersionId));
  const acked = [];
  const pending = [];
  for (const person of audience(groupId)) {
    const ack = acks.find((a) => a.userId === person.id);
    if (ack) acked.push(entry(person, ack.ackedAt));
    else pending.push(entry(person, null, dueAt));
  }
  return { acked, pending };
};

/** myAcknowledgments' default page, and the most it ever answers (steward-gateway#56). */
const RECENT_DEFAULT = 10;
const RECENT_MAX = 100;

/**
 * The person's own acknowledgements, newest first, each named by its policy and version. A
 * missing, zero or negative limit is the default; a large one is cut to the maximum.
 */
const recentAcknowledgments = (
  person: StewardPerson,
  limit?: null | number,
) => {
  const size =
    limit && limit > 0 ? Math.min(limit, RECENT_MAX) : RECENT_DEFAULT;
  return data()
    .acknowledgements.filter((a) => a.userId === person.id)
    .toSorted((a, b) => Date.parse(b.ackedAt) - Date.parse(a.ackedAt))
    .flatMap((a) => {
      const version = data().versions.find((v) => v.id === a.policyVersionId);
      const policy = data().policies.find((p) => p.id === version?.policyId);
      return version && policy
        ? [
            {
              ackedAt: a.ackedAt,
              number: policy.number,
              policyId: policy.id,
              policyVersionId: version.id,
              title: policy.title,
              versionNo: version.versionNo,
            },
          ]
        : [];
    })
    .slice(0, size);
};

/** May the person read the audit log, and for which groups (null for all)? */
const auditScope = (person: StewardPerson): null | string[] => {
  if (isSiteAdmin(person) || person.roles.includes("compliance-admin"))
    return null;
  const managed = managedGroupIdsOf(person);
  if (managed.length > 0) return managed;
  throw forbidden();
};

const recordsFor = (person: StewardPerson) => {
  const scope = auditScope(person);
  return data().audit.filter((r) => !scope || scope.includes(r.groupId));
};

/**
 * steward-obligations' view of one person: each currently obligating policy (published, not
 * retired, with an acknowledgement trigger) that obliges them, and whether they've cleared it. A
 * sensitive policy obliges only someone with the read-sensitive grant. ON_CHANGE is cleared by
 * acknowledging the published version, ON_PUBLISH by acknowledging any version.
 */
const obligationsOf = (person: StewardPerson) =>
  data()
    .policies.filter(
      (policy) =>
        policy.currentPublishedVersionId !== null &&
        policy.retiredAt === null &&
        (policy.sensitivity !== "SENSITIVE" || person.readSensitive) &&
        viewerCan(person, policy).ack,
    )
    .map((policy) => {
      const published = versionFor(policy.currentPublishedVersionId ?? "");
      const acked = new Set(
        data()
          .acknowledgements.filter((a) => a.userId === person.id)
          .map((a) => a.policyVersionId),
      );
      const cleared =
        ackTriggersOf(policy) === "ON_CHANGE"
          ? acked.has(published.id)
          : data().versions.some(
              (v) => v.policyId === policy.id && acked.has(v.id),
            );
      return {
        cleared,
        obligation: {
          dueAt: dueAtOf(published),
          number: policy.number,
          policyId: policy.id,
          policyVersionId: published.id,
          title: policy.title,
          version: String(published.versionNo),
        },
      };
    });

/**
 * steward-obligations' audienceFor: nobody when the policy asks for no acknowledgement, else the
 * enabled people it obliges (the same rule myObligations applies).
 */
const ackAudience = (policyId: string): StewardPerson[] => {
  const policy = data().policies.find((p) => p.id === policyId);
  if (!policy || ackTriggersOf(policy) === "NONE") return [];
  return people().filter(
    (person) =>
      !person.deletedAt &&
      !person.disabled &&
      (policy.sensitivity !== "SENSITIVE" || person.readSensitive) &&
      viewerCan(person, policy).ack,
  );
};

/**
 * steward-obligations' CompletionMetrics: the people in the version's acknowledgement audience who
 * ever viewed it and haven't acknowledged it. The group is ignored, as obligations ignores it.
 */
const viewedNotAcked = (policyVersionId: string): number => {
  const version = data().versions.find((v) => v.id === policyVersionId);
  if (!version) return 0;
  const audience = new Set(ackAudience(version.policyId).map((p) => p.id));
  const acked = new Set(
    data()
      .acknowledgements.filter((a) => a.policyVersionId === policyVersionId)
      .map((a) => a.userId),
  );
  const viewers = new Set(
    data()
      .policyViews.filter((v) => v.policyVersionId === policyVersionId)
      .map((v) => v.userId),
  );
  return [...viewers].filter((id) => audience.has(id) && !acked.has(id)).length;
};

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * steward-obligations' Activity: a day per entry from `days - 1` days ago through today (UTC),
 * oldest first, empty days included. Acks counts every acknowledgement of the version that day;
 * views counts the distinct audience members who viewed it that day. The group is ignored.
 */
const activity = (policyVersionId: string, window: number) => {
  const version = data().versions.find((v) => v.id === policyVersionId);
  if (!version)
    throw refuse(
      "INTERNAL",
      "Something went wrong on our side. Please try again.",
    );
  const days = window > 0 ? window : 30;
  const now = Date.now();
  const since = Date.parse(`${utcDate(now - (days - 1) * DAY_MS)}T00:00:00Z`);
  const acks = new Map<string, number>();
  for (const ack of data().acknowledgements)
    if (
      ack.policyVersionId === policyVersionId &&
      Date.parse(ack.ackedAt) >= since
    ) {
      const day = utcDate(Date.parse(ack.ackedAt));
      acks.set(day, (acks.get(day) ?? 0) + 1);
    }
  const audience = new Set(ackAudience(version.policyId).map((p) => p.id));
  const viewers = new Map<string, Set<string>>();
  for (const view of data().policyViews)
    if (
      view.policyVersionId === policyVersionId &&
      audience.has(view.userId) &&
      Date.parse(view.viewedAt) >= since
    ) {
      const day = utcDate(Date.parse(view.viewedAt));
      viewers.set(day, (viewers.get(day) ?? new Set()).add(view.userId));
    }
  return Array.from({ length: days }, (_, index) => {
    const date = utcDate(now - (days - 1 - index) * DAY_MS);
    return {
      acks: acks.get(date) ?? 0,
      date,
      views: viewers.get(date)?.size ?? 0,
    };
  });
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
        // steward-obligations files an acknowledgement under its own id.
        record("ack.recorded", person, {
          groupId: policy?.homeCategoryId,
          id: `${ack.policyVersionId}:${ack.userId}`,
          kind: "acknowledgment",
          label: policy?.title ?? null,
        });
      }
      return { ...ack, id: `${ack.policyVersionId}:${ack.userId}` };
    },
    /** steward-obligations' RecordView: one more view row for the caller, every time. */
    recordView: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      data().policyViews.push({
        policyVersionId: given.policyVersionId,
        userId: person.id,
        viewedAt: now(),
      });
      return true;
    },
  },
  Query: {
    ackActivity: (
      _root,
      given: { days: number; groupId?: null | string; policyVersionId: string },
      context: Context,
    ) => {
      reporter(context);
      return activity(given.policyVersionId, given.days);
    },
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
      return {
        avgDaysToAck:
          days.length === 0
            ? 0
            : Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) /
              10,
        completionPct:
          total === 0 ? 0 : Math.round((acked.length / total) * 100),
        // As steward-obligations lists it: every audience member without an acknowledgement,
        // whatever the version's age. The due date, not a mock-side age gate, says who is late.
        overdue: pending.map(({ dueAt, email, userId, userName }) => ({
          dueAt,
          email,
          userId,
          userName,
        })),
        totalAcked: acked.length,
        totalAudience: total,
        viewedNotAckedCount: viewedNotAcked(version.id),
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
    myAcknowledgments: (
      _root,
      given: { limit?: null | number },
      context: Context,
    ) => recentAcknowledgments(caller(context), given.limit),
    myAckSummary: (_root, _given, context: Context) => {
      const all = obligationsOf(caller(context));
      return {
        done: all.filter((o) => o.cleared).length,
        required: all.length,
      };
    },
    myObligations: (_root, _given, context: Context) =>
      obligationsOf(caller(context))
        .filter((o) => !o.cleared)
        .map((o) => o.obligation),
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
