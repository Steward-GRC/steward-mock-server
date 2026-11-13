// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Working days against the site work calendar (steward-mock-server#227): a port of
// steward-workflow's internal/workcal (steward-workflow#65), whose shared cases
// (testdata/workcal_cases.json) the tests run through this module. Pure: no state, no clock.
//
// AddWorkingDays(from, n) is the exclusive end of the nth working day after the day of entry:
//  - the day of entry is the civil date of `from` in the calendar's zone, and is never counted,
//    whatever the time of day or whether it works;
//  - each following date whose ISO weekday (1 Monday .. 7 Sunday) works and which is not a
//    holiday counts as one; the nth is the due date;
//  - the result is the instant of local midnight that starts the next civil date, so a task is
//    late from that instant on;
//  - civil dates are stepped in UTC (a day is one step there), and only the final midnight is
//    built in the zone, so a 23, 24, 24.5 or 25 hour day still counts as one;
//  - n <= 0 returns `from`; n over 365 and a calendar with no working weekday are errors.

/** The calendar as the site setting keeps it: ISO weekdays, an IANA zone, YYYY-MM-DD holidays. */
export interface Calendar {
  holidays: readonly string[];
  timezone: string;
  weekdays: readonly number[];
}

export type WorkcalErrorCode =
  | "duplicate_holiday"
  | "invalid_holiday"
  | "invalid_timezone"
  | "invalid_weekday"
  | "no_weekday"
  | "too_many_days"
  | "too_many_holidays";

/** A refusal with a stable code, so a caller can map it to the gateway's InvalidArgument. */
export class WorkcalError extends Error {
  readonly code: WorkcalErrorCode;

  constructor(code: WorkcalErrorCode, message: string) {
    super(message);
    this.name = "WorkcalError";
    this.code = code;
  }
}

/** The largest n addWorkingDays accepts. */
export const MAX_WORKING_DAYS = 365;
/** The most holidays a calendar may list. */
export const MAX_HOLIDAYS = 366;

/** Monday to Friday, no holidays, UTC. */
export const DEFAULT_CALENDAR: Calendar = {
  holidays: [],
  timezone: "UTC",
  weekdays: [1, 2, 3, 4, 5],
};

const DAY_MS = 86_400_000;

/** A strict real YYYY-MM-DD date as UTC midnight milliseconds, or null. */
const parseDate = (text: string): null | number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (year < 1) return null;
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(0, 0, 0, 0);
  const ok =
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day;
  return ok ? at.getTime() : null;
};

const dateText = (utcMidnight: number): string =>
  new Date(utcMidnight).toISOString().slice(0, 10);

/** ISO weekday (1 Monday .. 7 Sunday) of a UTC-midnight civil date. */
const isoWeekday = (utcMidnight: number): number =>
  new Date(utcMidnight).getUTCDay() || 7;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string): Intl.DateTimeFormat => {
  let found = formatters.get(timezone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      second: "numeric",
      timeZone: timezone,
      year: "numeric",
    });
    formatters.set(timezone, found);
  }
  return found;
};

/** The wall clock of an instant in the zone, read back as if it were UTC (milliseconds). */
const wallClock = (timezone: string, instant: number): number => {
  const seconds = Math.floor(instant / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(seconds))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  const at = new Date(0);
  at.setUTCFullYear(parts.year!, parts.month! - 1, parts.day!);
  at.setUTCHours(parts.hour!, parts.minute!, parts.second!, 0);
  return at.getTime();
};

/** The zone's offset from UTC at the instant, in milliseconds. */
const offsetAt = (timezone: string, instant: number): number =>
  wallClock(timezone, instant) - Math.floor(instant / 1000) * 1000;

/**
 * The instant of local midnight starting the civil date (given as UTC midnight). Resolved the way
 * Go's time.Date does: take the offset at the wall time read as UTC, and look the offset up again
 * at the instant that gives when it falls in a different period, so a midnight inside a
 * daylight saving gap resolves the same way in both implementations.
 */
const localMidnight = (timezone: string, civil: number): number => {
  const first = offsetAt(timezone, civil);
  const guess = civil - first;
  const second = offsetAt(timezone, guess);
  return second === first ? guess : civil - second;
};

const zoneIsKnown = (timezone: string): boolean => {
  if (timezone === "" || timezone === "Local" || /^[+-]/.test(timezone))
    return false;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  // Intl matches names case-insensitively; a database lookup (and Go's) does not.
  return (
    canonical.toLowerCase() !== timezone.toLowerCase() || canonical === timezone
  );
};

/** Check the calendar the way steward-workflow's Validate and New do; throws a WorkcalError. */
export const validateCalendar = (calendar: Calendar): void => {
  if (calendar.weekdays.length === 0)
    throw new WorkcalError(
      "no_weekday",
      "at least one working weekday is required",
    );
  const seen = new Set<number>();
  for (const day of calendar.weekdays) {
    if (!Number.isInteger(day) || day < 1 || day > 7)
      throw new WorkcalError(
        "invalid_weekday",
        `weekday must be 1 (Monday) to 7 (Sunday), once each: ${String(day)}`,
      );
    if (seen.has(day))
      throw new WorkcalError(
        "invalid_weekday",
        `weekday must be 1 (Monday) to 7 (Sunday), once each: ${String(day)} listed twice`,
      );
    seen.add(day);
  }
  if (!zoneIsKnown(calendar.timezone))
    throw new WorkcalError(
      "invalid_timezone",
      `time zone is not a known IANA name: ${JSON.stringify(calendar.timezone)}`,
    );
  if (calendar.holidays.length > MAX_HOLIDAYS)
    throw new WorkcalError(
      "too_many_holidays",
      `too many holidays: ${String(calendar.holidays.length)} (limit ${String(MAX_HOLIDAYS)})`,
    );
  const days = new Set<string>();
  for (const day of calendar.holidays) {
    if (parseDate(day) === null)
      throw new WorkcalError(
        "invalid_holiday",
        `holiday is not a valid YYYY-MM-DD date: ${JSON.stringify(day)}`,
      );
    if (days.has(day))
      throw new WorkcalError(
        "duplicate_holiday",
        `holiday dates must be unique: ${day}`,
      );
    days.add(day);
  }
};

/** Whether the civil date (YYYY-MM-DD) counts: a working weekday that is not a holiday. */
export const isWorkingDay = (calendar: Calendar, date: string): boolean => {
  const at = parseDate(date);
  if (at === null) return false;
  return (
    calendar.weekdays.includes(isoWeekday(at)) &&
    !calendar.holidays.includes(date)
  );
};

/** The deadline n working days after `from`; see the file comment for the rules. */
export const addWorkingDays = (
  calendar: Calendar,
  from: Date,
  n: number,
): Date => {
  if (n <= 0) return from;
  if (n > MAX_WORKING_DAYS)
    throw new WorkcalError(
      "too_many_days",
      `too many working days requested: ${String(n)} (limit ${String(MAX_WORKING_DAYS)})`,
    );
  const working = new Set(calendar.weekdays.filter((d) => d >= 1 && d <= 7));
  if (working.size === 0)
    throw new WorkcalError(
      "no_weekday",
      "at least one working weekday is required",
    );
  const holidays = new Set(calendar.holidays);
  const entry = wallClock(calendar.timezone, from.getTime());
  let cursor = entry - (((entry % DAY_MS) + DAY_MS) % DAY_MS);
  for (let counted = 0; counted < n;) {
    cursor += DAY_MS;
    if (working.has(isoWeekday(cursor)) && !holidays.has(dateText(cursor)))
      counted += 1;
  }
  return new Date(localMidnight(calendar.timezone, cursor + DAY_MS));
};

/** The time left in milliseconds from now to the deadline; never negative. */
export const dueIn = (now: Date, deadline: Date): number =>
  Math.max(0, deadline.getTime() - now.getTime());
