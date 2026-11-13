// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The site work calendar (steward-mock-server#227), declared in schema-pending.graphql ahead of
// the gateway: GlobalSettings.workCalendar (weekdays, timezone, holidays) set through
// setGlobalSettings by a site admin, absent in the input meaning unchanged; and a stage's due
// date counted in working days on the calendar pinned when the run was submitted.

import assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { stewardData } from "#product/data.ts";
import {
  control,
  query,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});
afterEach(() => {
  mock.timers.reset();
});

const as = (user: string) => signInAs(base, `user-${user}`);

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const CALENDAR = `workCalendar { weekdays timezone holidays { date label } }`;
const READ = `query { globalSettings { announcement { enabled message } ${CALENDAR} } }`;
const SET = `mutation ($input: GlobalSettingsInput!) {
  setGlobalSettings(input: $input) { announcement { enabled level message } maintenance { enabled message } ${CALENDAR} }
}`;
const AUDIT = `query { auditLog(pageSize: 500) { records { action subject } } }`;

interface Calendar {
  holidays: { date: string; label: string }[];
  timezone: string;
  weekdays: number[];
}

const banners = {
  announcement: { enabled: false, level: "info", message: "" },
  maintenance: { enabled: false, message: "" },
};

const save = (signed: Signed, workCalendar?: unknown, extra = {}) =>
  ask(signed, SET, {
    input: {
      ...banners,
      ...extra,
      ...(workCalendar === undefined ? {} : { workCalendar }),
    },
  });

const calendarNow = async (signed: Signed) =>
  (await ask(signed, READ)).data.globalSettings as {
    workCalendar: Calendar;
  };

const auditActions = async (signed: Signed) =>
  (
    (await ask(signed, AUDIT)).data.auditLog as {
      records: { action: string; subject: string }[];
    }
  ).records.map((r) => `${r.action} ${r.subject}`);

const MON_FRI: Calendar = {
  holidays: [],
  timezone: "UTC",
  weekdays: [1, 2, 3, 4, 5],
};

describe("the site work calendar setting", () => {
  it("defaults to Monday to Friday, UTC, no holidays, readable by anyone signed in", async () => {
    const answer = await calendarNow(await as("bob"));
    assert.deepEqual(answer.workCalendar, MON_FRI);
  });

  it("is saved by a site admin and read back by everyone", async () => {
    const calendar: Calendar = {
      holidays: [
        { date: "2026-12-25", label: "Christmas Day" },
        { date: "2026-12-26", label: "Boxing Day" },
      ],
      timezone: "Europe/London",
      weekdays: [7, 1, 2, 3, 4],
    };
    const saved = await save(await as("alice"), calendar);
    assert.equal(saved.code, undefined, saved.message);
    assert.deepEqual(
      (saved.data.setGlobalSettings as { workCalendar: Calendar }).workCalendar,
      calendar,
    );
    assert.deepEqual(
      (await calendarNow(await as("bob"))).workCalendar,
      calendar,
    );
  });

  it("leaves the calendar unchanged when the input has none", async () => {
    const calendar: Calendar = {
      holidays: [{ date: "2026-12-25", label: "Christmas Day" }],
      timezone: "Asia/Kolkata",
      weekdays: [1, 2, 3],
    };
    const admin = await as("alice");
    assert.equal((await save(admin, calendar)).code, undefined);
    const again = await save(admin, undefined, {
      announcement: { enabled: true, level: "info", message: "Hello." },
    });
    assert.equal(again.code, undefined, again.message);
    const now = await calendarNow(admin);
    assert.deepEqual(now.workCalendar, calendar);
    assert.equal(
      (now as unknown as { announcement: { message: string } }).announcement
        .message,
      "Hello.",
    );
  });

  it("keeps the calendar through a planned maintenance window", async () => {
    const admin = await as("alice");
    const calendar = { ...MON_FRI, weekdays: [2, 3] };
    assert.equal((await save(admin, calendar)).code, undefined);
    // The controls announce a window; globalSettings then reports it as the announcement.
    const hour = 3_600_000;
    await control(base, {
      endsAt: new Date(Date.now() + 2 * hour).toISOString(),
      kind: "maintenance-announce",
      startsAt: new Date(Date.now() + hour).toISOString(),
    });
    const now = (await ask(admin, READ)).data.globalSettings as {
      announcement: { enabled: boolean };
    };
    assert.equal(now.announcement.enabled, true);
    assert.deepEqual((await calendarNow(admin)).workCalendar, calendar);
  });

  it("refuses anyone but a site admin with PermissionDenied and changes nothing", async () => {
    const refused = await save(await as("bob"), {
      ...MON_FRI,
      weekdays: [1],
    });
    assert.equal(refused.code, "PermissionDenied");
    assert.deepEqual(
      (await calendarNow(await as("bob"))).workCalendar,
      MON_FRI,
    );
  });

  const bad: [string, unknown][] = [
    ["no weekday", { ...MON_FRI, weekdays: [] }],
    ["weekday 0", { ...MON_FRI, weekdays: [0] }],
    ["weekday 8", { ...MON_FRI, weekdays: [8] }],
    ["repeated weekday", { ...MON_FRI, weekdays: [1, 1] }],
    ["empty time zone", { ...MON_FRI, timezone: "" }],
    ["Local", { ...MON_FRI, timezone: "Local" }],
    ["unknown time zone", { ...MON_FRI, timezone: "Not/AZone" }],
    [
      "impossible holiday",
      { ...MON_FRI, holidays: [{ date: "2026-02-30", label: "x" }] },
    ],
    [
      "loose holiday",
      { ...MON_FRI, holidays: [{ date: "2026-2-3", label: "x" }] },
    ],
    [
      "repeated holiday",
      {
        ...MON_FRI,
        holidays: [
          { date: "2026-12-25", label: "a" },
          { date: "2026-12-25", label: "b" },
        ],
      },
    ],
    [
      "367 holidays",
      {
        ...MON_FRI,
        holidays: Array.from({ length: 367 }, (_, index) => ({
          date: new Date(Date.UTC(2026, 0, 1 + index))
            .toISOString()
            .slice(0, 10),
          label: "day",
        })),
      },
    ],
    [
      "empty label",
      { ...MON_FRI, holidays: [{ date: "2026-12-25", label: " " }] },
    ],
    [
      "label over 80 characters",
      { ...MON_FRI, holidays: [{ date: "2026-12-25", label: "x".repeat(81) }] },
    ],
  ];
  for (const [name, calendar] of bad)
    it(`refuses ${name} with InvalidArgument and saves nothing`, async () => {
      const admin = await as("alice");
      const refused = await save(admin, calendar, {
        announcement: { enabled: true, level: "info", message: "Not saved." },
      });
      assert.equal(refused.code, "InvalidArgument", refused.message);
      const now = (await ask(admin, READ)).data.globalSettings as {
        announcement: { enabled: boolean };
        workCalendar: Calendar;
      };
      assert.deepEqual(now.workCalendar, MON_FRI);
      assert.equal(now.announcement.enabled, false);
    });

  it("accepts 366 holidays and an 80 character label", async () => {
    const holidays = Array.from({ length: 366 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      label: "x".repeat(80),
    }));
    const saved = await save(await as("alice"), { ...MON_FRI, holidays });
    assert.equal(saved.code, undefined, saved.message);
  });

  it("audits a calendar change, and only when the calendar changed", async () => {
    const admin = await as("alice");
    const calendar = { ...MON_FRI, weekdays: [1, 2, 3, 4] };
    assert.equal((await save(admin, calendar)).code, undefined);
    const afterChange = await auditActions(admin);
    assert.equal(
      afterChange.filter((a) =>
        a.startsWith("global_settings.work_calendar_updated"),
      ).length,
      1,
    );
    assert.ok(
      afterChange.includes(
        "global_settings.work_calendar_updated settings:global",
      ),
    );
    // The same calendar again, and a save without one, add no calendar entry.
    assert.equal((await save(admin, calendar)).code, undefined);
    assert.equal((await save(admin)).code, undefined);
    const afterRepeat = await auditActions(admin);
    assert.equal(
      afterRepeat.filter((a) =>
        a.startsWith("global_settings.work_calendar_updated"),
      ).length,
      1,
    );
    // A refused change is not audited either.
    assert.equal(
      (await save(admin, { ...MON_FRI, weekdays: [] })).code,
      "InvalidArgument",
    );
    assert.equal(
      (await auditActions(admin)).filter((a) =>
        a.startsWith("global_settings.work_calendar_updated"),
      ).length,
      1,
    );
  });
});

const CONTENT = JSON.stringify({
  root: {
    children: [
      {
        children: [{ text: "Words.", type: "text", version: 1 }],
        type: "paragraph",
        version: 1,
      },
    ],
    direction: null,
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});
const STATUS = `query ($policyVersionId: ID!) {
  workflowStatus(policyVersionId: $policyVersionId) { stageProgress { dueAt } }
}`;
const SIGNAL = `mutation ($policyVersionId: ID!, $runId: ID!, $taskId: ID!, $signal: SignalType!, $comment: String!) {
  signalWorkflow(policyVersionId: $policyVersionId, runId: $runId, taskId: $taskId, signal: $signal, comment: $comment)
}`;

const FRIDAY_EVENING = Date.parse("2026-11-13T22:00:00Z");
const MONDAY_MORNING = Date.parse("2026-11-16T09:00:00Z");

/** policy-1 on a two-stage workflow with one approver each; slaDays per stage. */
const twoStages = (sla: [null | number, null | number]) => {
  const data = stewardData();
  const workflow = data.workflowDefs.find((w) => w.id === "workflow-2")!;
  for (const [index, stage] of workflow.stages.entries()) {
    stage.quorum = "one";
    stage.slaDays = sla[index] ?? null;
  }
  data.policies.find((p) => p.id === "policy-1")!.workflowDefId = "workflow-2";
};

/** Submit policy-1 at the given (mocked) time; the clock stays where the caller leaves it. */
const submitAt = async (when: number) => {
  const author = await as("bob");
  const draft = await ask(
    author,
    `mutation ($policyId: ID!, $contentJson: String!) { saveDraft(policyId: $policyId, contentJson: $contentJson) { id } }`,
    { contentJson: CONTENT, policyId: "policy-1" },
  );
  assert.equal(draft.code, undefined, draft.message);
  const versionId = (draft.data.saveDraft as { id: string }).id;
  mock.timers.enable({ apis: ["Date"], now: when });
  const sent = await ask(
    author,
    `mutation ($v: ID!, $p: ID!, $c: ID!) { submitWorkflow(policyVersionId: $v, policyId: $p, categoryId: $c, ancestorCategoryIds: []) { runId } }`,
    { c: "category-expenses", p: "policy-1", v: versionId },
  );
  assert.equal(sent.code, undefined, sent.message);
  return versionId;
};

const dueDates = async (versionId: string) =>
  (
    (await ask(await as("alice"), STATUS, { policyVersionId: versionId })).data
      .workflowStatus as { stageProgress: { dueAt: null | string }[] }
  ).stageProgress.map((s) => s.dueAt);

const approveFirst = async (versionId: string) => {
  const run = stewardData().runs.find((r) => r.policyVersionId === versionId)!;
  const seat = run.stages[run.currentStageIdx]!.seats[0]!;
  const done = await ask(await as(seat.userId.replace("user-", "")), SIGNAL, {
    comment: "Fine.",
    policyVersionId: versionId,
    runId: run.id,
    signal: "SIGNAL_TYPE_APPROVE",
    taskId: seat.taskId,
  });
  assert.equal(done.code, undefined, done.message);
};

describe("a stage's SLA in working days", () => {
  const UPDATE = `mutation ($id: ID!, $name: String!, $stages: [WorkflowStageInput!]!) {
    updateWorkflowDef(id: $id, name: $name, stages: $stages) { id stages { slaDays } }
  }`;
  const withSla = (slaDays: number) =>
    ask(adminOf(), UPDATE, {
      id: "workflow-1",
      name: "Finance sign-off",
      stages: [
        {
          approvers: ["user-charlie"],
          name: "Sign-off",
          quorum: "one",
          slaDays,
        },
      ],
    });
  let adminSigned: Signed;
  const adminOf = () => adminSigned;
  beforeEach(async () => {
    adminSigned = await as("alice");
  });

  it("allows up to 365 working days", async () => {
    const saved = await withSla(365);
    assert.equal(saved.code, undefined, saved.message);
  });

  for (const days of [366, -1])
    it(`refuses ${String(days)} with InvalidArgument`, async () => {
      assert.equal((await withSla(days)).code, "InvalidArgument");
    });
});

describe("stage deadlines in working days", () => {
  it("one working day from a Friday evening is the end of Monday", async () => {
    twoStages([1, null]);
    const due = await dueDates(await submitAt(FRIDAY_EVENING));
    assert.deepEqual(due, ["2026-11-17T00:00:00.000Z", null]);
  });

  it("five working days from a Friday evening skip the weekend", async () => {
    twoStages([5, null]);
    const due = await dueDates(await submitAt(FRIDAY_EVENING));
    assert.equal(due[0], "2026-11-21T00:00:00.000Z");
  });

  it("a stage with no SLA has no due date", async () => {
    twoStages([null, null]);
    assert.deepEqual(await dueDates(await submitAt(FRIDAY_EVENING)), [
      null,
      null,
    ]);
  });

  it("skips a holiday on the site calendar", async () => {
    twoStages([1, null]);
    const save1 = await save(await as("alice"), {
      ...MON_FRI,
      holidays: [{ date: "2026-11-16", label: "Day off" }],
    });
    assert.equal(save1.code, undefined, save1.message);
    const due = await dueDates(await submitAt(FRIDAY_EVENING));
    assert.equal(due[0], "2026-11-18T00:00:00.000Z");
  });

  it("reads the day in the site time zone", async () => {
    twoStages([1, null]);
    const set = await save(await as("alice"), {
      ...MON_FRI,
      timezone: "America/New_York",
    });
    assert.equal(set.code, undefined, set.message);
    // Friday 17:00 in New York: Monday is the working day, its end is Tuesday 00:00 EST.
    const due = await dueDates(await submitAt(FRIDAY_EVENING));
    assert.equal(due[0], "2026-11-17T05:00:00.000Z");
  });

  it("counts the next stage from the day it is entered", async () => {
    twoStages([1, 2]);
    const versionId = await submitAt(FRIDAY_EVENING);
    mock.timers.setTime(MONDAY_MORNING);
    await approveFirst(versionId);
    // Entered Monday: Tuesday and Wednesday count, due at the start of Thursday.
    assert.equal((await dueDates(versionId))[1], "2026-11-19T00:00:00.000Z");
  });

  it("keeps the calendar pinned at submit for the later stages of the run", async () => {
    twoStages([1, 2]);
    const versionId = await submitAt(FRIDAY_EVENING);
    const set = await save(await as("alice"), {
      ...MON_FRI,
      holidays: [{ date: "2026-11-17", label: "Added after submit" }],
    });
    assert.equal(set.code, undefined, set.message);
    mock.timers.setTime(MONDAY_MORNING);
    await approveFirst(versionId);
    assert.equal((await dueDates(versionId))[1], "2026-11-19T00:00:00.000Z");
  });

  it("uses a changed calendar for a run submitted afterwards", async () => {
    twoStages([2, null]);
    const set = await save(await as("alice"), {
      ...MON_FRI,
      weekdays: [2, 3, 4],
    });
    assert.equal(set.code, undefined, set.message);
    // Friday evening; the working days are Tue, Wed, Thu: the second is Wednesday.
    const due = await dueDates(await submitAt(FRIDAY_EVENING));
    assert.equal(due[0], "2026-11-19T00:00:00.000Z");
  });
});
