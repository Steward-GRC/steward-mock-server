// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The caller's notification settings and the notification type catalog, as steward-gateway
// answers them from steward-obligations' NotifPrefService: the notifprefs service resolves the
// stored choices over the notifpolicy taxonomy's defaults and refuses OFF for a required category
// or type with its registry symbol.

import { GraphQLError } from "graphql";

import type {
  NotifCadence,
  NotificationPrefs,
} from "#product/data/notifications.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { caller, data } from "#product/resolvers/shared.ts";

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

/** notifpolicy's taxonomy (internal/notifpolicy/taxonomy.go): each kind's category and delivery. */
const TAXONOMY: Record<string, [NotifCategory, NotifDelivery]> = {
  "access-granted": ["INFORMATIONAL", "DIGEST_PREFERRED"],
  "ack-required": ["COMPLIANCE", "IMMEDIATE_ONLY"],
  "assigned-as-owner": ["WORKFLOW", "IMMEDIATE_OR_DIGEST"],
  "break-glass-alert": ["SECURITY", "IMMEDIATE_ONLY"],
  "break-glass-read-alert": ["SECURITY", "IMMEDIATE_ONLY"],
  "domain-verification-instructions": ["TRANSACTIONAL", "IMMEDIATE_ONLY"],
  "domain-verified": ["TRANSACTIONAL", "IMMEDIATE_ONLY"],
  "email-verification": ["TRANSACTIONAL", "IMMEDIATE_ONLY"],
  "idp-test-failed": ["INFORMATIONAL", "IMMEDIATE_OR_DIGEST"],
  "kratos-recovery": ["SECURITY", "IMMEDIATE_ONLY"],
  "mfa-setup": ["SECURITY", "IMMEDIATE_ONLY"],
  otp: ["SECURITY", "IMMEDIATE_ONLY"],
  "policy-ack-reminder": ["COMPLIANCE", "REMINDER_SCHEDULE"],
  "policy-escalation": ["COMPLIANCE", "IMMEDIATE_ONLY"],
  "policy-published": ["INFORMATIONAL", "DIGEST_PREFERRED"],
  "policy-retired": ["INFORMATIONAL", "DIGEST_PREFERRED"],
  "raci-permission-granted": ["INFORMATIONAL", "DIGEST_PREFERRED"],
  "review-due": ["COMPLIANCE", "REMINDER_SCHEDULE"],
  "sp-cert-rotated": ["SECURITY", "IMMEDIATE_ONLY"],
  "sso-account-welcome": ["TRANSACTIONAL", "IMMEDIATE_ONLY"],
  "sso-activated": ["INFORMATIONAL", "IMMEDIATE_OR_DIGEST"],
  "sso-disabled": ["INFORMATIONAL", "IMMEDIATE_OR_DIGEST"],
  "welcome-account": ["TRANSACTIONAL", "IMMEDIATE_ONLY"],
  "workflow-assigned": ["WORKFLOW", "IMMEDIATE_OR_DIGEST"],
  "workflow-awaiting-approval": ["WORKFLOW", "IMMEDIATE_OR_DIGEST"],
  "workflow-denied": ["WORKFLOW", "IMMEDIATE_OR_DIGEST"],
  "workflow-started": ["WORKFLOW", "DIGEST_PREFERRED"],
};

const classOf = (kind: string) => {
  const entry = TAXONOMY[kind];
  if (!entry) return;
  const [category, delivery] = entry;
  return { category, delivery, kind, mandatory: MANDATORY.has(category) };
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
  };
};

export const notificationResolvers: Resolvers = {
  Mutation: {
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
    notificationSettings: (_root, _given, context: Context) =>
      settingsOf(caller(context).id),
    notificationTypeCatalog: (_root, _given, context: Context) => {
      caller(context);
      return catalog;
    },
  },
};
