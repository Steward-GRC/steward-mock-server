// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The notification choices people saved, as steward-obligations stores them: channel switches,
// a cadence per category, a cadence per notification type, and the digest window. A missing
// entry is no choice saved, and the settings answer obligations' defaults for it.

export type NotifCadence = "DAILY" | "IMMEDIATE" | "OFF" | "WEEKLY";

/** One person's saved choices; each part is absent until they save it. */
export interface NotificationPrefs {
  categories: Record<string, NotifCadence>;
  channels?: { email: boolean; inApp: boolean; push: boolean };
  digest?: { dailyHour: number; weeklyDow: number };
  /** By kind, in the order they were first saved. */
  overrides: Record<string, NotifCadence>;
  /** Absent when quiet hours are off. */
  quietHours?: QuietHours;
}

/**
 * A window of local hours in which email and push are held: start is the first hour held, end the
 * first hour not held, and end below start crosses midnight.
 */
export interface QuietHours {
  end: number;
  start: number;
  /** An IANA name. */
  timezone: string;
}

/** Alice moved workflow mail to the daily digest but keeps approvals immediate. */
export const notificationPrefs = (): Record<string, NotificationPrefs> => ({
  "user-alice": {
    categories: { WORKFLOW: "DAILY" },
    channels: { email: true, inApp: true, push: true },
    digest: { dailyHour: 7, weeklyDow: 1 },
    overrides: { "workflow-awaiting-approval": "IMMEDIATE" },
  },
});
