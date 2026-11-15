// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The in-app notices steward-obligations keeps for each person: what the bell and the inbox list.
// A notice's category is its kind's, from the notification type catalog, and is not stored.

export interface Notice {
  createdAt: string;
  id: string;
  kind: string;
  line: string;
  link: NoticeLink | null;
  needsAction: boolean;
  /** RFC 3339; null while unread. */
  readAt: null | string;
  title: string;
  userId: string;
}

export interface NoticeLink {
  kind: "APPROVAL" | "CASE" | "POLICY";
  ref: string;
}

const notice = (
  id: number,
  userId: string,
  kind: string,
  createdAt: string,
  title: string,
  line: string,
  needsAction: boolean,
  link: NoticeLink | null,
  readAt: null | string = null,
): Notice => ({
  createdAt,
  id: `notice-${id}`,
  kind,
  line,
  link,
  needsAction,
  readAt,
  title,
  userId,
});

/** Alice has an approval waiting; Erin has two acknowledgements to give and one update read. */
export const notices = (): Notice[] => [
  notice(
    1,
    "user-alice",
    "workflow-awaiting-approval",
    "2026-11-10T15:20:00Z",
    "Approval needed",
    "A policy version is waiting for your approval.",
    true,
    { kind: "APPROVAL", ref: "version-2" },
  ),
  notice(
    2,
    "user-alice",
    "policy-published",
    "2026-11-09T09:05:00Z",
    "Policy published",
    "Records Retention Policy is now published.",
    false,
    { kind: "POLICY", ref: "POL-RECORDS-000001" },
    "2026-11-09T10:00:00Z",
  ),
  notice(
    3,
    "user-erin",
    "ack-required",
    "2026-11-10T08:00:00Z",
    "Acknowledgement required",
    "Please read and acknowledge the Leave Policy.",
    true,
    { kind: "POLICY", ref: "POL-LEAVE-000001" },
  ),
  notice(
    4,
    "user-erin",
    "policy-ack-reminder",
    "2026-11-08T08:00:00Z",
    "Acknowledgement reminder",
    "The Travel Policy is still waiting for your acknowledgement.",
    true,
    { kind: "POLICY", ref: "POL-TRAVEL-000001" },
  ),
  notice(
    5,
    "user-erin",
    "policy-published",
    "2026-11-05T12:30:00Z",
    "Policy published",
    "Records Retention Policy is now published.",
    false,
    { kind: "POLICY", ref: "POL-RECORDS-000001" },
    "2026-11-05T13:00:00Z",
  ),
];
