// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The policies and procedures, their versions, what each links to, the approval runs and the
// acknowledgements. The design brief's five documents are here, in the states its frames show
// where the flows allow; the others are in the same style. Between them they cover every state the library and the reader
// show: a published policy with earlier versions and a pending acknowledgement, mandatory-read
// policies, a sensitive draft, a draft in review waiting on an approver, a retired policy, a
// withdrawn draft, a published procedure and a rejected one.

export interface Acknowledgement {
  ackedAt: string;
  policyVersionId: string;
  userId: string;
}

export interface Appendix {
  contentJson: string;
  id: string;
  letter: string;
  orderIndex: number;
  policyVersionId: string;
  title: string;
}

export interface Policy {
  ackAudienceOverride: null | string[];
  ackTriggers: "NONE" | "ON_CHANGE" | "ON_PUBLISH" | null;
  createdAt: string;
  currentDraftVersionId: null | string;
  currentPublishedVersionId: null | string;
  documentType: "POLICY" | "PROCEDURE";
  homeCategoryId: string;
  id: string;
  number: string;
  ownerUserId: string;
  retiredAt: null | string;
  sensitivity: "SENSITIVE" | "STANDARD";
  templateId: null | string;
  templateNone: boolean;
  title: string;
  updatedAt: string;
  /** The workflow this policy uses instead of its category's, when it has one. */
  workflowDefId: null | string;
}

/** What a policy links to from the libraries, and the policies it names as related. */
export interface PolicyLinks {
  contactBlockIds: string[];
  definitionIds: string[];
  referenceIds: string[];
  relatedPolicyIds: string[];
}

export interface PolicyVersion {
  appendices: Appendix[];
  contentJson: string;
  createdAt: string;
  id: string;
  policyId: string;
  publishedAt: null | string;
  /** DRAFT, IN_REVIEW, APPROVED, PUBLISHED, SUPERSEDED, REJECTED or WITHDRAWN. */
  status: string;
  templateVersionId: string;
  /** 0 until published, as steward-core numbers a version when it publishes. */
  versionNo: number;
}

/** An approval run of one policy version through a workflow. */
export interface Run {
  currentStageIdx: number;
  id: string;
  policyId: string;
  policyVersionId: string;
  stages: RunStage[];
  /** An ApprovalStatus value. */
  status: string;
  submittedAt: string;
  submittedBy: string;
  workflowDefId: string;
}

/** One approve-as-group unit: it is satisfied once `required` of its members approve. */
export interface RunGroup {
  id: string;
  name: string;
  quorum: string;
  required: number;
}

export interface RunStage {
  /** Approve-as-group units on the stage; their members are the seats with that `groupId`. */
  groups?: RunGroup[];
  name: string;
  /** The rule for the stage's individual seats (those with no `groupId`). */
  quorum: string;
  seats: Seat[];
}

/** One approver's seat on a stage of a run. */
export interface Seat {
  comment: null | string;
  decidedAt: null | string;
  /** The group whose seat this is; absent or null for an individual seat. */
  groupId?: null | string;
  /** pending, approved, rejected, or cancelled once the run ends without them. */
  state: string;
  taskId: string;
  userId: string;
}

/** steward-core's rendered number for the seeded Expense Claims Policy. */
export const EXPENSE_CLAIMS_NUMBER = "POL-EXPENSES-000002";

/** steward-core's rendered number for the seeded Travel Booking Procedure, the draft in review. */
export const TRAVEL_BOOKING_NUMBER = "PRC-TRAVEL-000003";

const text = (value: string) => ({
  detail: 0,
  format: 0,
  mode: "normal",
  style: "",
  text: value,
  type: "text",
  version: 1,
});

const block = (type: string, value: string, extra: object = {}) => ({
  children: value ? [text(value)] : [],
  direction: null,
  format: "",
  indent: 0,
  type,
  version: 1,
  ...extra,
});

/** One top-level block of a document: a heading, a paragraph or a table. */
type Block = ReturnType<typeof block>;

const h1 = (value: string) => block("heading", value, { tag: "h1" });
const h2 = (value: string) => block("heading", value, { tag: "h2" });
const p = (value: string) =>
  block("paragraph", value, { textFormat: 0, textStyle: "" });

/** A table whose first row is its header. */
const table = (...rows: string[][]) => ({
  children: rows.map((cells, index) => ({
    children: cells.map((cell) => ({
      children: [p(cell)],
      headerState: index === 0 ? 1 : 0,
      type: "tablecell",
      version: 1,
    })),
    type: "tablerow",
    version: 1,
  })),
  type: "table",
  version: 1,
});

/**
 * A version's content as the editor writes it and steward-core reads it: a Lexical document,
 * whose top-level headings name its sections (src/product/sections.ts derives their keys).
 */
const document = (...children: (Block | ReturnType<typeof table>)[]): string =>
  JSON.stringify({
    root: {
      children,
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });

/** A section per heading, each with its paragraphs. */
const lexical = (...entries: [string, ...string[]][]): string =>
  document(
    ...entries.flatMap(([heading, ...paragraphs]) => [
      h1(heading),
      ...(paragraphs.length > 0 ? paragraphs : [""]).map((text) => p(text)),
    ]),
  );

/** Expense Claims' purpose and scope, the same in every version. */
const EXPENSES_PURPOSE: [string, string] = [
  "Purpose",
  "How staff claim back business expenses.",
];
const EXPENSES_SCOPE: [string, string] = [
  "Scope",
  "Everyone who travels or buys for the organisation.",
];

const policy = (
  given: Partial<Policy> &
    Pick<
      Policy,
      "createdAt" | "homeCategoryId" | "id" | "number" | "title" | "updatedAt"
    >,
): Policy => ({
  ackAudienceOverride: null,
  ackTriggers: null,
  currentDraftVersionId: null,
  currentPublishedVersionId: null,
  documentType: "POLICY",
  ownerUserId: "user-bob",
  retiredAt: null,
  sensitivity: "STANDARD",
  templateId: null,
  templateNone: true,
  workflowDefId: null,
  ...given,
});

export const policies = (): Policy[] => [
  policy({
    ackTriggers: "ON_PUBLISH",
    createdAt: "2025-06-02T09:00:00Z",
    currentPublishedVersionId: "version-2",
    homeCategoryId: "category-expenses",
    id: "policy-1",
    number: EXPENSE_CLAIMS_NUMBER,
    templateId: "template-1",
    templateNone: false,
    title: "Expense Claims Policy",
    updatedAt: "2026-08-12T00:00:00Z",
  }),
  policy({
    createdAt: "2026-09-02T00:00:00Z",
    currentDraftVersionId: "version-3",
    homeCategoryId: "category-records",
    id: "policy-2",
    number: "POL-RECORDS-000001",
    sensitivity: "SENSITIVE",
    title: "Records Retention Policy",
    updatedAt: "2026-09-02T00:00:00Z",
  }),
  policy({
    createdAt: "2026-09-13T14:30:00Z",
    currentDraftVersionId: "version-4",
    documentType: "PROCEDURE",
    homeCategoryId: "category-travel",
    id: "policy-3",
    number: TRAVEL_BOOKING_NUMBER,
    sensitivity: "SENSITIVE",
    title: "Travel Booking Procedure",
    updatedAt: "2026-09-20T00:00:00Z",
    workflowDefId: "workflow-2",
  }),
  policy({
    createdAt: "2026-04-20T09:15:00Z",
    currentPublishedVersionId: "version-5",
    homeCategoryId: "category-leave",
    id: "policy-4",
    number: "POL-LEAVE-000001",
    retiredAt: "2026-09-01T00:00:00Z",
    title: "Annual Leave Policy",
    updatedAt: "2026-09-01T00:00:00Z",
  }),
  policy({
    createdAt: "2026-02-10T00:00:00Z",
    currentDraftVersionId: "version-6",
    homeCategoryId: "category-travel",
    id: "policy-5",
    number: "POL-TRAVEL-000001",
    ownerUserId: "user-jon",
    title: "Car Mileage Policy",
    updatedAt: "2026-03-18T00:00:00Z",
  }),
  policy({
    createdAt: "2026-09-20T00:00:00Z",
    currentPublishedVersionId: "version-7",
    documentType: "PROCEDURE",
    homeCategoryId: "category-devices",
    id: "policy-6",
    number: "PRC-DEVICES-000001",
    templateId: "template-2",
    templateNone: false,
    title: "Lost Device Procedure",
    updatedAt: "2026-09-28T00:00:00Z",
  }),
  policy({
    createdAt: "2026-06-25T09:15:00Z",
    currentDraftVersionId: "version-8",
    documentType: "PROCEDURE",
    homeCategoryId: "category-conduct",
    id: "policy-7",
    number: "PRC-CONDUCT-000001",
    title: "Gifts and Hospitality Procedure",
    updatedAt: "2026-07-09T00:00:00Z",
  }),
  policy({
    createdAt: "2026-05-04T00:00:00Z",
    currentPublishedVersionId: "version-9",
    homeCategoryId: "category-records",
    id: "policy-8",
    number: "POL-RECORDS-000002",
    sensitivity: "SENSITIVE",
    title: "Archive Access Policy",
    updatedAt: "2026-05-04T00:00:00Z",
  }),
  policy({
    ackTriggers: "ON_PUBLISH",
    createdAt: "2026-09-15T10:00:00Z",
    currentPublishedVersionId: "version-11",
    homeCategoryId: "category-facilities",
    id: "policy-9",
    number: "POL-FACILITIES-000001",
    templateId: "template-1",
    templateNone: false,
    title: "Desk Booking Policy",
    updatedAt: "2026-10-02T14:02:00Z",
  }),
  policy({
    ackTriggers: "ON_PUBLISH",
    createdAt: "2026-09-01T09:00:00Z",
    currentPublishedVersionId: "version-12",
    homeCategoryId: "category-facilities",
    id: "policy-10",
    number: "POL-FACILITIES-000004",
    templateId: "template-1",
    templateNone: false,
    title: "Visitor Sign-in Policy",
    updatedAt: "2026-09-29T00:00:00Z",
  }),
];

const version = (
  given: Partial<PolicyVersion> &
    Pick<PolicyVersion, "contentJson" | "createdAt" | "id" | "policyId">,
): PolicyVersion => ({
  appendices: [],
  publishedAt: null,
  status: "DRAFT",
  templateVersionId: "",
  versionNo: 0,
  ...given,
});

export const versions = (): PolicyVersion[] => [
  version({
    contentJson: lexical(EXPENSES_PURPOSE, EXPENSES_SCOPE, [
      "Policy statement",
      "File your claim within 90 days of spending the money.",
      "Attach a receipt for every item. Post the original to the finance team. Claims are paid in US dollars only.",
    ]),
    createdAt: "2025-06-02T09:00:00Z",
    id: "version-1",
    policyId: "policy-1",
    publishedAt: "2025-06-20T00:00:00Z",
    status: "SUPERSEDED",
    templateVersionId: "template-version-1",
    versionNo: 1,
  }),
  version({
    contentJson: lexical(EXPENSES_PURPOSE, EXPENSES_SCOPE, [
      "Policy statement",
      "File your claim within 60 days of spending the money, using the expenses page.",
      "Attach a receipt for every item. Post the original to the finance team.",
    ]),
    createdAt: "2025-11-03T09:00:00Z",
    id: "version-10",
    policyId: "policy-1",
    publishedAt: "2025-11-20T00:00:00Z",
    status: "SUPERSEDED",
    templateVersionId: "template-version-1",
    versionNo: 2,
  }),
  version({
    appendices: [
      {
        contentJson: JSON.stringify({
          text: "Per-diem rates by country, reviewed annually by Finance.",
        }),
        id: "appendix-1",
        letter: "A",
        orderIndex: 0,
        policyVersionId: "version-2",
        title: "Per-diem rates",
      },
    ],
    contentJson: lexical(EXPENSES_PURPOSE, EXPENSES_SCOPE, [
      "Policy statement",
      "File your claim within 30 days of spending the money, using the expenses page.",
      "Attach a receipt for every item. A clear photo of the receipt is enough.",
    ]),
    createdAt: "2026-07-29T09:15:00Z",
    id: "version-2",
    policyId: "policy-1",
    publishedAt: "2026-08-12T00:00:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-1",
    versionNo: 3,
  }),
  version({
    appendices: [
      {
        contentJson: JSON.stringify({
          text: "Reviewed annually by the records owner.",
        }),
        id: "appendix-2",
        letter: "A",
        orderIndex: 0,
        policyVersionId: "version-3",
        title: "Review notes",
      },
      {
        contentJson: JSON.stringify({
          text: "Contracts, invoices and personnel files.",
        }),
        id: "appendix-3",
        letter: "B",
        orderIndex: 1,
        policyVersionId: "version-3",
        title: "Covered records",
      },
    ],
    contentJson: lexical(
      [
        "Purpose",
        "This policy sets out how long the organisation keeps its records.",
      ],
      ["Scope", ""],
    ),
    createdAt: "2026-09-02T00:00:00Z",
    id: "version-3",
    policyId: "policy-2",
    status: "IN_REVIEW",
  }),
  version({
    contentJson: lexical(
      [
        "Steps",
        "Book trains, flights and hotels on the travel booking site at least 14 days ahead.",
      ],
      [
        "Afterwards",
        "Business-class fares are restricted to journeys over six hours.",
      ],
    ),
    createdAt: "2026-09-13T14:30:00Z",
    id: "version-4",
    policyId: "policy-3",
    status: "IN_REVIEW",
  }),
  version({
    contentJson: lexical([
      "Policy statement",
      "Staff may carry over up to five days of unused leave with their manager's agreement.",
    ]),
    createdAt: "2026-04-20T09:15:00Z",
    id: "version-5",
    policyId: "policy-4",
    publishedAt: "2026-05-01T00:00:00Z",
    status: "PUBLISHED",
    versionNo: 1,
  }),
  version({
    contentJson: lexical([
      "Policy statement",
      "Mileage in a private car is paid at the rate Finance sets each April.",
    ]),
    createdAt: "2026-02-10T00:00:00Z",
    id: "version-6",
    policyId: "policy-5",
    status: "WITHDRAWN",
  }),
  version({
    contentJson: lexical(
      [
        "Steps",
        "Report it straight away: tell the service desk within one hour of noticing the device is missing.",
        "Change your password from another device.",
      ],
      [
        "Afterwards",
        "If it turns up, bring it to the service desk to be checked before you use it again.",
      ],
    ),
    createdAt: "2026-09-20T00:00:00Z",
    id: "version-7",
    policyId: "policy-6",
    publishedAt: "2026-09-28T00:00:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-2",
    versionNo: 1,
  }),
  version({
    contentJson: lexical([
      "Policy statement",
      "Declare any gift or hospitality worth more than a modest amount.",
    ]),
    createdAt: "2026-06-25T09:15:00Z",
    id: "version-8",
    policyId: "policy-7",
    status: "REJECTED",
  }),
  version({
    contentJson: lexical(
      [
        "Purpose",
        "Who may hold administrator access to stored records, and how it is granted.",
      ],
      [
        "Policy statement",
        "Administrator access is granted for a named task and reviewed every quarter.",
      ],
    ),
    createdAt: "2026-05-04T00:00:00Z",
    id: "version-9",
    policyId: "policy-8",
    publishedAt: "2026-05-10T00:00:00Z",
    status: "PUBLISHED",
    versionNo: 1,
  }),
  version({
    appendices: [
      {
        contentJson: JSON.stringify({
          text: "Quiet zone, team zone and drop-in zone, with the floors each one covers.",
        }),
        id: "appendix-4",
        letter: "A",
        orderIndex: 0,
        policyVersionId: "version-11",
        title: "Desk zones",
      },
    ],
    // The design's reader frame (U7): its sections, the sub-section and the table.
    contentJson: document(
      h1("Purpose"),
      p(
        "This policy explains how staff book a desk in a shared office, how long a booking lasts, and what to do when plans change.",
      ),
      h1("Scope"),
      p(
        "It applies to everyone who works from an Example Organisation office, including contractors and visitors who are given a desk for the day.",
      ),
      h1("Booking a desk"),
      p(
        "Book a shared desk through the booking page within the booking window. A booking holds the desk until 10:00 on the day.",
      ),
      h2("Changing a booking"),
      p("Cancel a booking you no longer need so a colleague can use the desk."),
      h1("Responsibilities"),
      table(
        ["Role", "Responsibility"],
        ["Staff", "Book ahead, and cancel when plans change."],
        ["Facilities team", "Keep the booking page and desk zones up to date."],
      ),
    ),
    createdAt: "2026-09-15T10:00:00Z",
    id: "version-11",
    policyId: "policy-9",
    publishedAt: "2026-10-02T14:02:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-1",
    versionNo: 1,
  }),
  version({
    contentJson: lexical(
      ["Purpose", "How visitors are welcomed and kept safe."],
      ["Scope", "Everyone who invites a visitor to an office."],
      [
        "Policy statement",
        "Every visitor signs in at the front desk, wears a visitor badge and is met by their host. The host signs them out when they leave.",
      ],
    ),
    createdAt: "2026-09-01T09:00:00Z",
    id: "version-12",
    policyId: "policy-10",
    publishedAt: "2026-09-29T00:00:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-1",
    versionNo: 1,
  }),
];

export const links = (): Record<string, PolicyLinks> => ({
  "policy-1": {
    contactBlockIds: ["contact-block-3", "contact-block-1"],
    definitionIds: ["definition-4"],
    referenceIds: ["reference-1", "reference-4"],
    relatedPolicyIds: ["policy-7"],
  },
  "policy-6": {
    contactBlockIds: ["contact-block-1"],
    definitionIds: ["definition-1"],
    referenceIds: [],
    relatedPolicyIds: [],
  },
});

const seat = (
  taskId: string,
  userId: string,
  decided?: { at: string; comment: string; state: string },
  groupId: null | string = null,
): Seat => ({
  comment: decided?.comment ?? null,
  decidedAt: decided?.at ?? null,
  groupId,
  state: decided?.state ?? "pending",
  taskId,
  userId,
});

export const runs = (): Run[] => [
  {
    currentStageIdx: 0,
    id: "run-1",
    policyId: "policy-3",
    policyVersionId: "version-4",
    stages: [
      {
        name: "Review",
        quorum: "majority",
        seats: [seat("task-1", "user-charlie"), seat("task-2", "user-alice")],
      },
      {
        name: "Final approval",
        quorum: "one",
        seats: [seat("task-3", "user-alice")],
      },
    ],
    status: "APPROVAL_STATUS_IN_REVIEW",
    submittedAt: "2026-09-20T00:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-2",
  },
  {
    currentStageIdx: 0,
    id: "run-2",
    policyId: "policy-7",
    policyVersionId: "version-8",
    stages: [
      {
        name: "Finance sign-off",
        quorum: "one",
        seats: [
          seat("task-4", "user-charlie", {
            at: "2026-07-09T00:00:00Z",
            comment: "Needs the value threshold spelled out.",
            state: "rejected",
          }),
        ],
      },
    ],
    status: "APPROVAL_STATUS_REJECTED",
    submittedAt: "2026-06-25T09:15:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-1",
  },
  // Records Retention: a review that mixes one user with two groups (one half-voted, one not yet
  // voted in), then a parallel step of two users, so the approval flow shows every box shape.
  {
    currentStageIdx: 0,
    id: "run-3",
    policyId: "policy-2",
    policyVersionId: "version-3",
    stages: [
      {
        groups: [
          {
            id: "group-finance",
            name: "Finance team",
            quorum: "majority",
            required: 2,
          },
          {
            id: "group-facilities",
            name: "Facilities team",
            quorum: "all",
            required: 2,
          },
        ],
        name: "Review",
        quorum: "one",
        seats: [
          seat("task-5", "user-dave"),
          seat(
            "task-6",
            "user-grace",
            {
              at: "2026-11-04T10:00:00Z",
              comment: "The retention periods match finance's.",
              state: "approved",
            },
            "group-finance",
          ),
          seat("task-7", "user-heidi", undefined, "group-finance"),
          seat("task-8", "user-erin", undefined, "group-finance"),
          seat("task-9", "user-alice", undefined, "group-facilities"),
          seat("task-10", "user-charlie", undefined, "group-facilities"),
        ],
      },
      {
        name: "Compliance check",
        quorum: "all",
        seats: [seat("task-11", "user-heidi"), seat("task-12", "user-charlie")],
      },
    ],
    status: "APPROVAL_STATUS_IN_REVIEW",
    submittedAt: "2026-11-03T09:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-2",
  },
];

/** An instant `days` days before now at `hour`:00 UTC, so recent activity stays recent. */
const daysAgo = (days: number, hour = 10): string => {
  const at = new Date(Date.now() - days * 86_400_000);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
};

/** An acknowledgement some days ago, by someone whose obligations no test pins down. */
const ackedAgo = (
  policyVersionId: string,
  userId: string,
  days: number,
): Acknowledgement => ({ ackedAt: daysAgo(days), policyVersionId, userId });

/**
 * The fixed acknowledgements the reader screens show (Erin's Desk Booking on 3 Oct 2026, as the
 * design's frame has it), then recent ones from Alice, Dave, Grace and Heidi on the three obligating
 * policies, spread over the last 90 days, so the completion chart (A14) has bars at 30 and 90 days.
 * Erin, Bob and Charlie keep exactly the obligations myObligations reports for them.
 */
export const acknowledgements = (): Acknowledgement[] => [
  {
    ackedAt: "2026-08-14T10:00:00Z",
    policyVersionId: "version-2",
    userId: "user-charlie",
  },
  {
    ackedAt: "2026-08-15T09:30:00Z",
    policyVersionId: "version-2",
    userId: "user-bob",
  },
  {
    ackedAt: "2026-05-03T10:00:00Z",
    policyVersionId: "version-5",
    userId: "user-erin",
  },
  {
    ackedAt: "2026-10-03T09:00:00Z",
    policyVersionId: "version-11",
    userId: "user-erin",
  },
  ackedAgo("version-11", "user-heidi", 4),
  ackedAgo("version-11", "user-grace", 11),
  ackedAgo("version-11", "user-alice", 18),
  ackedAgo("version-11", "user-dave", 52),
  ackedAgo("version-12", "user-heidi", 2),
  ackedAgo("version-12", "user-grace", 8),
  ackedAgo("version-12", "user-alice", 24),
  ackedAgo("version-12", "user-dave", 45),
  ackedAgo("version-2", "user-heidi", 6),
  ackedAgo("version-2", "user-grace", 27),
  ackedAgo("version-2", "user-alice", 38),
  ackedAgo("version-2", "user-dave", 66),
  // The duplicate accounts to merge (bug log #110): both gave the version-12 acknowledgement, so a
  // merge counts it once; only Jon gave the version-11 one.
  ackedAgo("version-11", "user-jon", 9),
  ackedAgo("version-12", "user-jon", 7),
  ackedAgo("version-12", "user-jonathan", 3),
];

/** A view of a version: steward-obligations' policy_views row (recordView writes one). */
export interface PolicyView {
  policyVersionId: string;
  userId: string;
  viewedAt: string;
}

/**
 * Views over the last 90 days: everyone who acknowledged viewed it that day, and a few people
 * came back to read without acknowledging, so the chart's views run ahead of its acks.
 */
export const policyViews = (): PolicyView[] => [
  ...acknowledgements()
    .filter((a) =>
      ["version-11", "version-12", "version-2"].includes(a.policyVersionId),
    )
    .filter((a) => Date.parse(a.ackedAt) > Date.now() - 90 * 86_400_000)
    .map((a) => ({
      policyVersionId: a.policyVersionId,
      userId: a.userId,
      viewedAt: a.ackedAt,
    })),
  ...(
    [
      ["version-12", "user-erin", [1, 7, 15, 33, 60]],
      ["version-12", "user-bob", [3, 19, 48]],
      ["version-11", "user-bob", [5, 14, 40]],
      ["version-11", "user-charlie", [3, 21, 70]],
      ["version-2", "user-erin", [10, 29, 55, 80]],
      ["version-2", "user-heidi", [12, 36]],
    ] as const
  ).flatMap(([policyVersionId, userId, days]) =>
    days.map((days) => ({
      policyVersionId,
      userId,
      viewedAt: daysAgo(days, 14),
    })),
  ),
];
