// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Which channels a notice goes out on right now: the person's channel switches, less email and
// push while quiet hours are on. In-app notices are never held. Email and push for security and
// transactional kinds, and for any critical-severity kind (policy-escalation among the compliance
// ones), go out regardless; the other compliance kinds (ack-required, policy-ack-reminder,
// review-due) are held like any optional kind. A held message is not sent later. This is
// notifpolicy's Class.BypassQuietHours plus the resolver's critical-severity bypass.

import type { QuietHours } from "#product/data/notifications.ts";

import { classOf } from "#product/resolvers/notifications.ts";

export interface Channels {
  email: boolean;
  inApp: boolean;
  push: boolean;
}

/** The hour of day (0 to 23) at an instant in an IANA timezone. */
const hourIn = (timezone: string, at: Date): number => {
  const part = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone: timezone,
  })
    .formatToParts(at)
    .find((p) => p.type === "hour");
  return Number(part?.value ?? 0) % 24;
};

/** Whether an instant falls inside the window, which may cross midnight. */
export const inQuietHours = (window: QuietHours, at: Date): boolean => {
  const hour = hourIn(window.timezone, at);
  return window.start < window.end
    ? hour >= window.start && hour < window.end
    : hour >= window.start || hour < window.end;
};

/** Whether the zone is one the runtime knows. */
export const knownTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

/** Whether a kind ignores quiet hours: security, transactional or critical severity. */
export const bypassesQuietHours = (kind: string): boolean => {
  const class_ = classOf(kind);
  return (
    class_?.category === "SECURITY" ||
    class_?.category === "TRANSACTIONAL" ||
    class_?.severity === "critical"
  );
};

/** The channels a notice of this kind goes out on at this instant. */
export const deliveryAt = (
  kind: string,
  channels: Channels,
  quiet: null | QuietHours | undefined,
  at: Date,
): Channels => {
  const held = quiet && !bypassesQuietHours(kind) && inQuietHours(quiet, at);
  return held ? { ...channels, email: false, push: false } : { ...channels };
};
