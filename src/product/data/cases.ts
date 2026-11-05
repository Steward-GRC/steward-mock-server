// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Privacy reports in the officers' queue: a fresh anonymous report with nothing recorded yet, a
// named report an officer is working (a thread, a note, an assignee), and a case through its risk
// assessment with notices tracking the notification deadlines.

export interface CaseNote {
  authorUserId: string;
  body: string;
  createdAt: string;
  id: string;
}

export interface CaseNotice {
  daysAllowed: number;
  dueOn: string;
  id: string;
  label: string;
  method: string;
  recipient: string;
  sentOn: null | string;
  status: string;
}

export interface ReportCase {
  assessment: null | RiskAssessment;
  assigneeUserId: null | string;
  attachments: {
    contentType: string;
    filename: string;
    id: string;
    metadataStripped: boolean;
    sizeBytes: number;
  }[];
  caseCode: string;
  closedAt: null | string;
  correctiveActions: { description: string; policyId: null | string }[];
  details: {
    informationKinds: string[];
    location: string;
    occurred: string;
    stillHappening: null | string;
    whatHappened: string;
  };
  discoveredOn: null | string;
  id: string;
  kind: "ANONYMOUS" | "NAMED";
  notes: CaseNote[];
  notices: CaseNotice[];
  outcome: null | string;
  receivedAt: string;
  reporterUserId: null | string;
  status: string;
  thread: ThreadMessage[];
}

export interface RiskAssessment {
  decidedAt: string;
  decidedByUserId: string;
  decision: null | string;
  factors: {
    information: string[];
    mitigation: null | string;
    recipient: null | string;
    viewed: null | string;
  };
  reason: string;
  suggestion: null | string;
}

export interface ThreadMessage {
  author: "OFFICER" | "REPORTER";
  body: string;
  createdAt: string;
  id: string;
  officerUserId: null | string;
}

/** A case's empty fields, with lists made fresh on each call so no two cases share one. */
const blank = () => ({
  assessment: null,
  assigneeUserId: null,
  attachments: [],
  closedAt: null,
  correctiveActions: [],
  discoveredOn: null,
  notes: [],
  notices: [],
  outcome: null,
  reporterUserId: null,
  thread: [],
});

export const reportCases = (): ReportCase[] => [
  {
    ...blank(),
    caseCode: "K7Q4-M2X9",
    details: {
      informationKinds: ["CONTACT"],
      location: "Finance, 3rd floor",
      occurred: "yesterday afternoon",
      stillHappening: "NOT_SURE",
      whatHappened:
        "A shared drive folder with client contact lists looked open to everyone.",
    },
    id: "case-1",
    kind: "ANONYMOUS",
    receivedAt: "2026-04-01T09:00:00Z",
    status: "NEW",
  },
  {
    ...blank(),
    assigneeUserId: "user-mhamilton",
    caseCode: "P3D8-W6N1",
    details: {
      informationKinds: ["HEALTH"],
      location: "HR office",
      occurred: "this morning",
      stillHappening: "NO",
      whatHappened:
        "An email with an employee's medical leave details went to the whole team by mistake.",
    },
    discoveredOn: "2026-04-05",
    id: "case-2",
    kind: "NAMED",
    notes: [
      {
        authorUserId: "user-mhamilton",
        body: "The email reached 14 people; asking IT whether it can still be recalled.",
        createdAt: "2026-04-05T10:05:00Z",
        id: "case-note-1",
      },
    ],
    receivedAt: "2026-04-05T09:40:00Z",
    reporterUserId: "user-ghopper",
    status: "IN_REVIEW",
    thread: [
      {
        author: "OFFICER",
        body: "Thank you for the report. Roughly how many people received the email?",
        createdAt: "2026-04-05T10:00:00Z",
        id: "case-message-1",
        officerUserId: "user-mhamilton",
      },
    ],
  },
  {
    ...blank(),
    assessment: {
      decidedAt: "2026-03-21T11:00:00Z",
      decidedByUserId: "user-mhamilton",
      decision: "REPORTABLE",
      factors: {
        information: ["FINANCIAL", "CONTACT"],
        mitigation: "NOT_AT_ALL",
        recipient: "UNKNOWN_PEOPLE",
        viewed: "PROBABLY",
      },
      reason:
        "The laptop was unencrypted and not recovered; a vendor payment list is sensitive.",
      suggestion: "NOTIFICATION_LIKELY_REQUIRED",
    },
    assigneeUserId: "user-mhamilton",
    caseCode: "F5T2-H8R4",
    details: {
      informationKinds: ["FINANCIAL", "CONTACT"],
      location: "Remote, a lost laptop",
      occurred: "last week",
      stillHappening: "NO",
      whatHappened:
        "An unencrypted laptop holding a vendor payment list was lost in transit.",
    },
    discoveredOn: "2026-03-20",
    id: "case-3",
    kind: "ANONYMOUS",
    notices: [
      {
        daysAllowed: 60,
        dueOn: "2026-05-19",
        id: "case-notice-1",
        label: "Affected people",
        method: "Email",
        recipient: "AFFECTED_PEOPLE",
        sentOn: null,
        status: "NOT_SENT",
      },
      {
        daysAllowed: 60,
        dueOn: "2026-05-19",
        id: "case-notice-2",
        label: "Regulator",
        method: "Letter",
        recipient: "REGULATOR",
        sentOn: null,
        status: "DRAFT",
      },
    ],
    receivedAt: "2026-03-20T14:00:00Z",
    status: "NOTIFICATION_DUE",
  },
];
