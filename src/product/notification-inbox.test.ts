// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The in-app notification inbox and per-user quiet hours, as steward-gateway will carry them
// (steward-gateway#73 and #74). steward-obligations owns the notices; quiet hours hold only email
// and push, never an in-app notice and never a mandatory one.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { deliveryAt, inQuietHours } from "#product/notification-delivery.ts";
import {
  query,
  type Signed,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

// Parsed JSON answers are read loosely, as the other product tests do.
// oxlint-disable-next-line typescript/no-explicit-any
type Gql = any;

const at = (iso: string) => new Date(iso);

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

const ok = async (
  text: string,
  signed: Signed,
  variables?: Record<string, unknown>,
) => {
  const { body } = await query(base, text, signed, variables);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data as Record<string, Gql>;
};

const refusal = async (
  text: string,
  signed: Signed,
  variables?: Record<string, unknown>,
) => {
  const { body } = await query(base, text, signed, variables);
  assert.ok(body.errors?.length, "expected a refusal");
  const error = body.errors[0] as { extensions?: { code?: string } };
  return error.extensions?.code;
};

const LIST = `query ($filter: NotificationFilter, $first: Int, $after: String) {
  myNotifications(filter: $filter, first: $first, after: $after) {
    items { id kind category title line needsAction link { kind ref } createdAt readAt }
    endCursor
    hasMore
  }
}`;
const COUNT = "query { myUnreadNotificationCount }";

const list = async (signed: Signed, variables: Record<string, unknown> = {}) =>
  (await ok(LIST, signed, variables)).myNotifications;

describe("myNotifications", () => {
  it("lists the caller's notices newest first, with the catalog's category", async () => {
    const page = await list(await signInAs(base, "user-erin"));
    assert.ok(page.items.length >= 3);
    const times = page.items.map((n: { createdAt: string }) => n.createdAt);
    assert.deepEqual(times, [...times].toSorted().toReversed());
    const ack = page.items.find(
      (n: { kind: string }) => n.kind === "ack-required",
    );
    assert.equal(ack.category, "COMPLIANCE");
    assert.equal(ack.needsAction, true);
    assert.equal(ack.readAt, null);
    assert.equal(ack.link.kind, "POLICY");
    assert.equal(page.hasMore, false);
    assert.equal(page.endCursor, null);
  });

  it("returns only the caller's own notices", async () => {
    const erin = await list(await signInAs(base, "user-erin"));
    const alice = await list(await signInAs(base, "user-alice"));
    const erinIds = new Set(erin.items.map((n: { id: string }) => n.id));
    for (const n of alice.items) assert.ok(!erinIds.has(n.id));
    const nobody = await list(await signInAs(base, "user-grace"));
    assert.deepEqual(nobody.items, []);
  });

  it("filters to what needs action, to updates, to unread, and by category", async () => {
    const erin = await signInAs(base, "user-erin");
    const needs = await list(erin, { filter: { needsAction: true } });
    assert.ok(needs.items.length > 0);
    assert.ok(
      needs.items.every((n: { needsAction: boolean }) => n.needsAction),
    );
    const updates = await list(erin, { filter: { needsAction: false } });
    assert.ok(updates.items.length > 0);
    assert.ok(
      updates.items.every((n: { needsAction: boolean }) => !n.needsAction),
    );
    const all = await list(erin);
    assert.equal(needs.items.length + updates.items.length, all.items.length);

    const unread = await list(erin, { filter: { unread: true } });
    assert.ok(unread.items.every((n: { readAt: null }) => n.readAt === null));
    assert.ok(unread.items.length < all.items.length);

    const compliance = await list(erin, { filter: { category: "COMPLIANCE" } });
    assert.ok(compliance.items.length > 0);
    assert.ok(
      compliance.items.every(
        (n: { category: string }) => n.category === "COMPLIANCE",
      ),
    );
  });

  it("pages with first and after, newest first, without repeating or skipping", async () => {
    const erin = await signInAs(base, "user-erin");
    const all = (await list(erin)).items.map((n: { id: string }) => n.id);
    const seen: string[] = [];
    let after: null | string = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: {
        endCursor: null | string;
        hasMore: boolean;
        items: { id: string }[];
      } = await list(erin, { after, first: 2 });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((n) => n.id));
      if (!page.hasMore) {
        assert.equal(page.endCursor, null);
        break;
      }
      assert.ok(page.endCursor);
      after = page.endCursor;
    }
    assert.deepEqual(seen, all);
  });

  it("refuses a page size below one and a cursor it did not hand out", async () => {
    const erin = await signInAs(base, "user-erin");
    assert.equal(await refusal(LIST, erin, { first: 0 }), "InvalidArgument");
    assert.equal(
      await refusal(LIST, erin, { after: "nonsense" }),
      "InvalidArgument",
    );
  });

  it("needs a signed-in caller", async () => {
    const { body } = await query(base, LIST, {
      cookie: "",
      csrf: "",
      token: undefined,
    } as Signed);
    assert.ok(body.errors?.length);
  });
});

describe("myUnreadNotificationCount", () => {
  it("counts the caller's unread notices", async () => {
    const erin = await signInAs(base, "user-erin");
    const unread = (await list(erin, { filter: { unread: true } })).items
      .length;
    assert.ok(unread > 0);
    assert.equal((await ok(COUNT, erin)).myUnreadNotificationCount, unread);
  });

  it("is zero for someone with no notices", async () => {
    const data = await ok(COUNT, await signInAs(base, "user-grace"));
    assert.equal(data.myUnreadNotificationCount, 0);
  });
});

describe("markNotificationRead", () => {
  const MARK = `mutation ($id: ID!) { markNotificationRead(id: $id) { id readAt } }`;

  it("marks one read, lowers the count and keeps the first read time", async () => {
    const erin = await signInAs(base, "user-erin");
    const before = (await ok(COUNT, erin)).myUnreadNotificationCount;
    const target = (await list(erin, { filter: { unread: true } })).items[0];
    const marked = (await ok(MARK, erin, { id: target.id }))
      .markNotificationRead;
    assert.equal(marked.id, target.id);
    assert.ok(marked.readAt);
    assert.equal((await ok(COUNT, erin)).myUnreadNotificationCount, before - 1);

    const again = (await ok(MARK, erin, { id: target.id }))
      .markNotificationRead;
    assert.equal(again.readAt, marked.readAt);
    assert.equal((await ok(COUNT, erin)).myUnreadNotificationCount, before - 1);
  });

  it("answers someone else's notice as not found and changes nothing", async () => {
    const erin = await signInAs(base, "user-erin");
    const alice = await signInAs(base, "user-alice");
    const theirs = (await list(alice, { filter: { unread: true } })).items[0];
    const before = (await ok(COUNT, alice)).myUnreadNotificationCount;
    assert.equal(await refusal(MARK, erin, { id: theirs.id }), "NotFound");
    assert.equal((await ok(COUNT, alice)).myUnreadNotificationCount, before);
  });

  it("answers an unknown id as not found", async () => {
    const erin = await signInAs(base, "user-erin");
    assert.equal(await refusal(MARK, erin, { id: "no-such" }), "NotFound");
  });
});

describe("markAllNotificationsRead", () => {
  const ALL = "mutation { markAllNotificationsRead }";

  it("marks every unread notice of the caller and says how many", async () => {
    const erin = await signInAs(base, "user-erin");
    const alice = await signInAs(base, "user-alice");
    const unread = (await ok(COUNT, erin)).myUnreadNotificationCount;
    const aliceUnread = (await ok(COUNT, alice)).myUnreadNotificationCount;
    assert.ok(unread > 0 && aliceUnread > 0);

    assert.equal((await ok(ALL, erin)).markAllNotificationsRead, unread);
    assert.equal((await ok(COUNT, erin)).myUnreadNotificationCount, 0);
    assert.equal(
      (await ok(COUNT, alice)).myUnreadNotificationCount,
      aliceUnread,
    );
    assert.equal((await ok(ALL, erin)).markAllNotificationsRead, 0);
  });
});

describe("quiet hours", () => {
  const QUIET =
    "query { notificationSettings { quietHours { start end timezone } } }";
  const SET = `mutation ($start: Int, $end: Int, $timezone: String) {
    setQuietHours(start: $start, end: $end, timezone: $timezone) {
      quietHours { start end timezone }
      channels { email inApp push }
    }
  }`;

  it("is off until saved", async () => {
    const data = await ok(QUIET, await signInAs(base, "user-erin"));
    assert.equal(data.notificationSettings.quietHours, null);
  });

  it("stores a window in the person's timezone, beside the other settings", async () => {
    const erin = await signInAs(base, "user-erin");
    const set = (
      await ok(SET, erin, { end: 7, start: 22, timezone: "America/New_York" })
    ).setQuietHours;
    assert.deepEqual(set.quietHours, {
      end: 7,
      start: 22,
      timezone: "America/New_York",
    });
    assert.deepEqual(set.channels, { email: true, inApp: true, push: false });
    const read = await ok(QUIET, erin);
    assert.deepEqual(read.notificationSettings.quietHours, set.quietHours);
    const other = await ok(QUIET, await signInAs(base, "user-alice"));
    assert.equal(other.notificationSettings.quietHours, null);
  });

  it("takes UTC when no timezone is given, and clears with no start and end", async () => {
    const erin = await signInAs(base, "user-erin");
    const set = (await ok(SET, erin, { end: 6, start: 23 })).setQuietHours;
    assert.equal(set.quietHours.timezone, "UTC");
    const cleared = (await ok(SET, erin, {})).setQuietHours;
    assert.equal(cleared.quietHours, null);
  });

  it("refuses an hour out of range, half a window, an empty window and an unknown timezone", async () => {
    const erin = await signInAs(base, "user-erin");
    for (const bad of [
      { end: 7, start: 24 },
      { end: -1, start: 22 },
      { start: 22 },
      { end: 7 },
      { end: 22, start: 22 },
      { end: 7, start: 22, timezone: "Mars/Olympus" },
    ]) {
      assert.equal(await refusal(SET, erin, bad), "NOTIFY_PREF_INVALID");
    }
    assert.equal((await ok(QUIET, erin)).notificationSettings.quietHours, null);
  });
});

describe("what quiet hours hold", () => {
  const night = { end: 7, start: 22, timezone: "UTC" };

  it("knows a window inside a day and one across midnight", () => {
    const day = { end: 17, start: 9, timezone: "UTC" };
    assert.equal(inQuietHours(day, at("2026-11-11T09:00:00Z")), true);
    assert.equal(inQuietHours(day, at("2026-11-11T16:59:00Z")), true);
    assert.equal(inQuietHours(day, at("2026-11-11T17:00:00Z")), false);
    assert.equal(inQuietHours(night, at("2026-11-11T22:00:00Z")), true);
    assert.equal(inQuietHours(night, at("2026-11-11T03:00:00Z")), true);
    assert.equal(inQuietHours(night, at("2026-11-11T07:00:00Z")), false);
    assert.equal(inQuietHours(night, at("2026-11-11T12:00:00Z")), false);
  });

  it("reads the hour in the person's timezone", () => {
    const eastern = { end: 7, start: 22, timezone: "America/New_York" };
    // 03:00 UTC on 12 Nov is 22:00 on 11 Nov in New York (EST, UTC-5).
    assert.equal(inQuietHours(eastern, at("2026-11-12T03:00:00Z")), true);
    assert.equal(inQuietHours(eastern, at("2026-11-12T13:00:00Z")), false);
  });

  const allOn = { email: true, inApp: true, push: true };

  it("holds email and push for a non-mandatory notice, and keeps the in-app notice", () => {
    assert.deepEqual(
      deliveryAt(
        "workflow-awaiting-approval",
        allOn,
        night,
        at("2026-11-11T23:00:00Z"),
      ),
      {
        email: false,
        inApp: true,
        push: false,
      },
    );
    assert.deepEqual(
      deliveryAt(
        "workflow-awaiting-approval",
        allOn,
        night,
        at("2026-11-11T12:00:00Z"),
      ),
      allOn,
    );
  });

  it("never holds a mandatory notice", () => {
    for (const kind of ["ack-required", "otp", "welcome-account"]) {
      assert.deepEqual(
        deliveryAt(kind, allOn, night, at("2026-11-11T23:00:00Z")),
        allOn,
      );
    }
  });

  it("changes nothing without quiet hours, and still honors the channel switches", () => {
    const off = { email: false, inApp: true, push: true };
    assert.deepEqual(
      deliveryAt("policy-published", off, null, at("2026-11-11T23:00:00Z")),
      off,
    );
    assert.deepEqual(
      deliveryAt("policy-published", off, night, at("2026-11-11T23:00:00Z")),
      {
        email: false,
        inApp: true,
        push: false,
      },
    );
  });
});
