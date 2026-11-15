// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The caller's notification settings and the notification type catalog, as steward-gateway
// answers them from steward-obligations' NotifPrefService: the notifprefs service resolves the
// stored choices over the notifpolicy taxonomy's defaults and refuses OFF for a required category
// or type with its registry symbol.

import { GraphQLError } from "graphql";

import type { Notice } from "#product/data/notices.ts";
import type {
  NotifCadence,
  NotificationPrefs,
} from "#product/data/notifications.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { knownTimezone } from "#product/notification-delivery.ts";
import { caller, data, notFound, refuse } from "#product/resolvers/shared.ts";

type NotifCategory =
  | "COMPLIANCE"
  | "INFORMATIONAL"
  | "SECURITY"
  | "TRANSACTIONAL"
  | "WORKFLOW";

type NotifDelivery =
  | "DIGEST_PREFERRED"
  | "IMMEDIATE_ONLY"
  | "IMMEDIATE_OR_DIGEST"
  | "REMINDER_SCHEDULE";

type NotifSeverity = "critical" | "high" | "low" | "normal";

/** notifpolicy's AllCategories, in its order. */
const CATEGORIES: NotifCategory[] = [
  "COMPLIANCE",
  "SECURITY",
  "TRANSACTIONAL",
  "WORKFLOW",
  "INFORMATIONAL",
];

/** notifpolicy's CategoryMandatory: these can't be turned off. */
const MANDATORY = new Set<NotifCategory>([
  "COMPLIANCE",
  "SECURITY",
  "TRANSACTIONAL",
]);

/** notifpolicy's taxonomy (internal/notifpolicy/taxonomy.go): each kind's category, severity and delivery. */
const TAXONOMY: Record<string, [NotifCategory, NotifSeverity, NotifDelivery]> =
  {
    "access-granted": ["INFORMATIONAL", "normal", "DIGEST_PREFERRED"],
    "ack-required": ["COMPLIANCE", "high", "IMMEDIATE_ONLY"],
    "assigned-as-owner": ["WORKFLOW", "high", "IMMEDIATE_OR_DIGEST"],
    "break-glass-alert": ["SECURITY", "critical", "IMMEDIATE_ONLY"],
    "break-glass-read-alert": ["SECURITY", "critical", "IMMEDIATE_ONLY"],
    "domain-verification-instructions": [
      "TRANSACTIONAL",
      "normal",
      "IMMEDIATE_ONLY",
    ],
    "domain-verified": ["TRANSACTIONAL", "normal", "IMMEDIATE_ONLY"],
    "email-verification": ["TRANSACTIONAL", "high", "IMMEDIATE_ONLY"],
    "idp-test-failed": ["INFORMATIONAL", "high", "IMMEDIATE_OR_DIGEST"],
    "kratos-recovery": ["SECURITY", "critical", "IMMEDIATE_ONLY"],
    "mfa-setup": ["SECURITY", "high", "IMMEDIATE_ONLY"],
    otp: ["SECURITY", "critical", "IMMEDIATE_ONLY"],
    "policy-ack-reminder": ["COMPLIANCE", "high", "REMINDER_SCHEDULE"],
    "policy-escalation": ["COMPLIANCE", "critical", "IMMEDIATE_ONLY"],
    "policy-published": ["INFORMATIONAL", "normal", "DIGEST_PREFERRED"],
    "policy-retired": ["INFORMATIONAL", "normal", "DIGEST_PREFERRED"],
    "raci-permission-granted": ["INFORMATIONAL", "normal", "DIGEST_PREFERRED"],
    "review-due": ["COMPLIANCE", "high", "REMINDER_SCHEDULE"],
    "sp-cert-rotated": ["SECURITY", "high", "IMMEDIATE_ONLY"],
    "sso-account-welcome": ["TRANSACTIONAL", "high", "IMMEDIATE_ONLY"],
    "sso-activated": ["INFORMATIONAL", "normal", "IMMEDIATE_OR_DIGEST"],
    "sso-disabled": ["INFORMATIONAL", "normal", "IMMEDIATE_OR_DIGEST"],
    "welcome-account": ["TRANSACTIONAL", "high", "IMMEDIATE_ONLY"],
    "workflow-assigned": ["WORKFLOW", "high", "IMMEDIATE_OR_DIGEST"],
    "workflow-awaiting-approval": ["WORKFLOW", "high", "IMMEDIATE_OR_DIGEST"],
    "workflow-denied": ["WORKFLOW", "high", "IMMEDIATE_OR_DIGEST"],
    "workflow-started": ["WORKFLOW", "normal", "DIGEST_PREFERRED"],
  };

export const classOf = (kind: string) => {
  const entry = TAXONOMY[kind];
  if (!entry) return;
  const [category, severity, delivery] = entry;
  return {
    category,
    delivery,
    kind,
    mandatory: MANDATORY.has(category),
    severity,
  };
};

/** notifpolicy's AllClasses: by category, then kind. */
const catalog = CATEGORIES.flatMap((category) =>
  Object.keys(TAXONOMY)
    .filter((kind) => TAXONOMY[kind]?.[0] === category)
    .toSorted()
    .map((kind) => classOf(kind)),
);

/** obligations' errcodes registry, as the gateway presents a user-safe refusal. */
const MANDATORY_OFF = () =>
  new GraphQLError(
    "This category is required for compliance and can't be turned off — choose a digest instead.",
    { extensions: { code: "NOTIFY_PREF_MANDATORY_OFF" } },
  );
const INVALID = () =>
  new GraphQLError(
    "That notification preference isn't valid — check the value and try again.",
    { extensions: { code: "NOTIFY_PREF_INVALID" } },
  );

const prefsOf = (userId: string): NotificationPrefs => {
  const all = data().notificationPrefs;
  all[userId] ??= { categories: {}, overrides: {} };
  return all[userId];
};

/** notifprefs' Service.Get: stored choices over the defaults, COMPLIANCE floored at DAILY. */
const settingsOf = (userId: string) => {
  const prefs = data().notificationPrefs[userId];
  return {
    categories: CATEGORIES.map((category) => {
      const stored = prefs?.categories[category];
      const cadence =
        stored ?? (category === "INFORMATIONAL" ? "DAILY" : "IMMEDIATE");
      return {
        cadence:
          cadence === "OFF" && category === "COMPLIANCE" ? "DAILY" : cadence,
        category,
        mandatory: MANDATORY.has(category),
      };
    }),
    channels: {
      email: true,
      inApp: true,
      push: false,
      ...prefs?.channels,
      userId,
    },
    digest: prefs?.digest ?? { dailyHour: 8, weeklyDow: 1 },
    overrides: Object.entries(prefs?.overrides ?? {}).map(
      ([kind, cadence]) => ({ ...classOf(kind), cadence, kind }),
    ),
    quietHours: prefs?.quietHours ?? null,
  };
};

const DEFAULT_PAGE = 20;

const validHour = (h: null | number | undefined): h is number =>
  Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23;

interface NoticeFilter {
  category?: NotifCategory | null;
  needsAction?: boolean | null;
  unread?: boolean | null;
}

/** A notice as the gateway answers it: the kind's category comes from the catalog. */
const present = (notice: Notice) => ({
  ...notice,
  category: classOf(notice.kind)?.category ?? "INFORMATIONAL",
});

/** The caller's notices, newest first (the id breaks a tie, later made first). */
const noticesOf = (userId: string) =>
  data()
    .notices.filter((n) => n.userId === userId)
    .toSorted(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );

const unreadOf = (userId: string) =>
  noticesOf(userId).filter((n) => n.readAt === null);

const badPage = () =>
  refuse("BAD_USER_INPUT", "That page isn't valid — check first and after.");

export const notificationResolvers: Resolvers = {
  Mutation: {
    markAllNotificationsRead: (_root, _given, context: Context) => {
      const person = caller(context);
      const unread = unreadOf(person.id);
      const at = new Date().toISOString();
      for (const notice of unread) notice.readAt = at;
      return unread.length;
    },
    markNotificationRead: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const notice = data().notices.find(
        (n) => n.id === given.id && n.userId === person.id,
      );
      if (!notice) throw notFound("Notification");
      notice.readAt ??= new Date().toISOString();
      return present(notice);
    },
    setCategoryCadence: (
      _root,
      given: { cadence: NotifCadence; category: NotifCategory },
      context: Context,
    ) => {
      const person = caller(context);
      if (given.cadence === "OFF" && MANDATORY.has(given.category))
        throw MANDATORY_OFF();
      prefsOf(person.id).categories[given.category] = given.cadence;
      return settingsOf(person.id);
    },
    setDigestWindow: (
      _root,
      given: { dailyHour: number; weeklyDow: number },
      context: Context,
    ) => {
      const person = caller(context);
      const { dailyHour, weeklyDow } = given;
      if (dailyHour < 0 || dailyHour > 23 || weeklyDow < 1 || weeklyDow > 7)
        throw INVALID();
      prefsOf(person.id).digest = { dailyHour, weeklyDow };
      return settingsOf(person.id);
    },
    setNotificationChannels: (
      _root,
      given: { input: { email: boolean; inApp: boolean; push: boolean } },
      context: Context,
    ) => {
      const person = caller(context);
      const { email, inApp, push } = given.input;
      prefsOf(person.id).channels = { email, inApp, push };
      return settingsOf(person.id);
    },
    setQuietHours: (
      _root,
      given: {
        end?: null | number;
        start?: null | number;
        timezone?: null | string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const { end, start } = given;
      if (start == null && end == null) {
        delete prefsOf(person.id).quietHours;
        return settingsOf(person.id);
      }
      const timezone = given.timezone ?? "UTC";
      if (
        !validHour(start) ||
        !validHour(end) ||
        start === end ||
        !knownTimezone(timezone)
      )
        throw INVALID();
      prefsOf(person.id).quietHours = { end, start, timezone };
      return settingsOf(person.id);
    },
    setTypeCadence: (
      _root,
      given: { cadence: NotifCadence; kind: string },
      context: Context,
    ) => {
      const person = caller(context);
      const type = classOf(given.kind);
      if (!type) throw INVALID();
      if (given.cadence === "OFF" && type.mandatory) throw MANDATORY_OFF();
      prefsOf(person.id).overrides[given.kind] = given.cadence;
      return settingsOf(person.id);
    },
  },
  Query: {
    myNotifications: (
      _root,
      given: {
        after?: null | string;
        filter?: NoticeFilter | null;
        first?: null | number;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const first = given.first ?? DEFAULT_PAGE;
      if (!Number.isInteger(first) || first < 1) throw badPage();
      let offset = 0;
      if (given.after != null) {
        if (!/^\d+$/.test(given.after)) throw badPage();
        offset = Number(given.after);
      }
      const filter = given.filter ?? {};
      const matching = noticesOf(person.id)
        .map((n) => present(n))
        .filter(
          (n) =>
            (filter.needsAction == null ||
              n.needsAction === filter.needsAction) &&
            (!filter.unread || n.readAt === null) &&
            (filter.category == null || n.category === filter.category),
        );
      const items = matching.slice(offset, offset + first);
      const hasMore = offset + first < matching.length;
      return {
        endCursor: hasMore ? String(offset + first) : null,
        hasMore,
        items,
      };
    },
    myUnreadNotificationCount: (_root, _given, context: Context) =>
      unreadOf(caller(context).id).length,
    notificationSettings: (_root, _given, context: Context) =>
      settingsOf(caller(context).id),
    notificationTypeCatalog: (_root, _given, context: Context) => {
      caller(context);
      return catalog;
    },
  },
};
