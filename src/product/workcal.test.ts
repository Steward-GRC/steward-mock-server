// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The working-day calendar (steward-mock-server#227): the shared steward-workflow cases
// (testdata/workcal_cases.json, see workcal.SOURCE) through the mock's port, plus the validation
// and limits the Go package's own tests cover.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  addWorkingDays,
  type Calendar,
  DEFAULT_CALENDAR,
  dueIn,
  isWorkingDay,
  MAX_HOLIDAYS,
  MAX_WORKING_DAYS,
  validateCalendar,
  WorkcalError,
} from "#product/workcal.ts";

interface Fixture {
  add_working_days: {
    calendar: string;
    from: string;
    n: number;
    name: string;
    want: string;
  }[];
  calendars: Record<
    string,
    { holidays: string[]; timezone: string; weekdays: number[] }
  >;
  is_working_day: { calendar: string; date: string; want: boolean }[];
}

const folder = new URL("testdata/", import.meta.url);
const raw = readFileSync(new URL("workcal_cases.json", folder));
const fixture = JSON.parse(raw.toString("utf8")) as Fixture;

const calendarNamed = (name: string): Calendar => {
  const found = fixture.calendars[name];
  assert.ok(found, `unknown calendar ${name}`);
  return {
    holidays: found.holidays,
    timezone: found.timezone,
    weekdays: found.weekdays,
  };
};

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof WorkcalError, String(error));
    return error.code;
  }
  return undefined;
};

describe("the shared working-day cases", () => {
  it("are the copy workcal.SOURCE names", () => {
    const source = readFileSync(new URL("workcal.SOURCE", folder), "utf8");
    const line = (key: string) =>
      new RegExp(`^${key}: (.+)$`, "m").exec(source)?.[1];
    assert.match(line("commit") ?? "", /^[\da-f]{40}$/);
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      line("sha256"),
    );
    assert.ok(fixture.add_working_days.length >= 54);
    assert.ok(fixture.is_working_day.length >= 16);
  });

  it("every named calendar is valid", () => {
    for (const name of Object.keys(fixture.calendars))
      validateCalendar(calendarNamed(name));
  });

  for (const row of fixture.add_working_days)
    it(`add_working_days: ${row.name}`, () => {
      const got = addWorkingDays(
        calendarNamed(row.calendar),
        new Date(row.from),
        row.n,
      );
      assert.equal(got.toISOString(), new Date(row.want).toISOString());
    });

  for (const row of fixture.is_working_day)
    it(`is_working_day: ${row.calendar} ${row.date}`, () => {
      assert.equal(
        isWorkingDay(calendarNamed(row.calendar), row.date),
        row.want,
      );
    });
});

describe("addWorkingDays beyond the fixture", () => {
  const from = new Date("2026-11-12T09:00:00Z");

  it("returns from for n <= 0, even for an unusable calendar", () => {
    const empty: Calendar = { holidays: [], timezone: "UTC", weekdays: [] };
    assert.equal(addWorkingDays(empty, from, 0).getTime(), from.getTime());
    assert.equal(addWorkingDays(empty, from, -3).getTime(), from.getTime());
  });

  it("refuses n over the limit and accepts the limit", () => {
    addWorkingDays(DEFAULT_CALENDAR, from, MAX_WORKING_DAYS);
    assert.equal(
      codeOf(() =>
        addWorkingDays(DEFAULT_CALENDAR, from, MAX_WORKING_DAYS + 1),
      ),
      "too_many_days",
    );
  });

  it("refuses a calendar with no working weekday", () => {
    const empty: Calendar = { holidays: [], timezone: "UTC", weekdays: [] };
    assert.equal(
      codeOf(() => addWorkingDays(empty, from, 1)),
      "no_weekday",
    );
  });

  it("ends when every working weekday for a year is a holiday", () => {
    const holidays: string[] = [];
    for (let index = 0; index < 52; index += 1)
      holidays.push(
        new Date(Date.UTC(2026, 10, 18 + 7 * index)).toISOString().slice(0, 10),
      );
    const got = addWorkingDays(
      { holidays, timezone: "UTC", weekdays: [3] },
      new Date("2026-11-16T10:00:00Z"),
      1,
    );
    assert.equal(got.toISOString(), "2027-11-18T00:00:00.000Z");
  });

  it("keeps sub-second input and lands on local midnight, strictly increasing", () => {
    const cal: Calendar = {
      holidays: [],
      timezone: "America/New_York",
      weekdays: [1, 2, 3, 4, 5],
    };
    const start = new Date("2026-03-01T15:00:00.123Z");
    let previous = start.getTime();
    for (let n = 1; n <= 120; n += 1) {
      const got = addWorkingDays(cal, start, n);
      assert.ok(got.getTime() > previous, `n=${String(n)}`);
      previous = got.getTime();
      const local = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        minute: "numeric",
        second: "numeric",
        timeZone: "America/New_York",
      }).format(got);
      assert.equal(local, "00:00:00", `n=${String(n)}`);
    }
  });

  it("does not change the calendar it is given", () => {
    const cal: Calendar = {
      holidays: ["2026-11-16"],
      timezone: "UTC",
      weekdays: [1, 2, 3, 4, 5],
    };
    const before = JSON.stringify(cal);
    addWorkingDays(cal, new Date("2026-11-13T22:00:00Z"), 3);
    assert.equal(JSON.stringify(cal), before);
  });
});

const base = (): Calendar => ({
  holidays: [],
  timezone: "UTC",
  weekdays: [1, 2, 3, 4, 5],
});

const days = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
  );

describe("validateCalendar", () => {
  it("accepts the default", () => validateCalendar(DEFAULT_CALENDAR));

  it("needs a working weekday", () =>
    assert.equal(
      codeOf(() => validateCalendar({ ...base(), weekdays: [] })),
      "no_weekday",
    ));

  it("rejects out-of-range and repeated weekdays", () => {
    for (const weekdays of [[0], [8], [-1], [1, 1], [1.5]])
      assert.equal(
        codeOf(() => validateCalendar({ ...base(), weekdays })),
        "invalid_weekday",
        JSON.stringify(weekdays),
      );
  });

  it("accepts any order of weekdays", () =>
    validateCalendar({ ...base(), weekdays: [7, 1, 2, 3, 4] }));

  it("rejects an unloadable time zone, the empty one and Local", () => {
    for (const timezone of [
      "",
      " ",
      "Local",
      "Not/AZone",
      "../etc/passwd",
      "/etc/localtime",
      "america/new_york ",
      "america/new_york",
      "+01:00",
    ])
      assert.equal(
        codeOf(() => validateCalendar({ ...base(), timezone })),
        "invalid_timezone",
        JSON.stringify(timezone),
      );
  });

  it("accepts IANA names", () => {
    for (const timezone of [
      "UTC",
      "America/New_York",
      "Asia/Kolkata",
      "Australia/Lord_Howe",
      "Europe/London",
    ])
      validateCalendar({ ...base(), timezone });
  });

  it("rejects holidays that are not strict real dates", () => {
    for (const day of [
      "",
      "2026-2-3",
      "2026-02-30",
      "2027-02-29",
      "2026-13-01",
      "2026-00-10",
      "26-11-12",
      " 2026-11-12",
      "2026-11-12 ",
      "2026/11/12",
      "2026-11-12T00:00:00Z",
      "12-11-2026",
      "2026-11-1",
      "+2026-11-12",
    ])
      assert.equal(
        codeOf(() => validateCalendar({ ...base(), holidays: [day] })),
        "invalid_holiday",
        JSON.stringify(day),
      );
  });

  it("accepts a leap day", () =>
    validateCalendar({ ...base(), holidays: ["2028-02-29"] }));

  it("rejects a repeated holiday", () =>
    assert.equal(
      codeOf(() =>
        validateCalendar({ ...base(), holidays: ["2026-12-25", "2026-12-25"] }),
      ),
      "duplicate_holiday",
    ));

  it("allows 366 holidays and refuses 367", () => {
    validateCalendar({ ...base(), holidays: days(MAX_HOLIDAYS) });
    assert.equal(
      codeOf(() =>
        validateCalendar({ ...base(), holidays: days(MAX_HOLIDAYS + 1) }),
      ),
      "too_many_holidays",
    );
  });
});

describe("dueIn", () => {
  const now = new Date("2026-11-12T09:00:00Z");
  it("is the time left, never negative", () => {
    assert.equal(
      dueIn(now, new Date(now.getTime() + 90 * 60_000)),
      90 * 60_000,
    );
    assert.equal(dueIn(now, now), 0);
    assert.equal(dueIn(now, new Date(now.getTime() - 3_600_000)), 0);
    assert.equal(dueIn(now, new Date(0)), 0);
  });

  it("from a Friday evening deadline is 74 hours", () => {
    const friday = new Date("2026-11-13T22:00:00Z");
    assert.equal(
      dueIn(friday, addWorkingDays(DEFAULT_CALENDAR, friday, 1)),
      74 * 3_600_000,
    );
  });
});
