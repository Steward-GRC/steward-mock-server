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

export interface RunStage {
  name: string;
  quorum: string;
  seats: Seat[];
}

/** One approver's seat on a stage of a run. */
export interface Seat {
  comment: null | string;
  decidedAt: null | string;
  /** pending, approved, rejected, or cancelled once the run ends without them. */
  state: string;
  taskId: string;
  userId: string;
}

/** steward-core's rendered number for the seeded Expense Claims Policy. */
export const EXPENSE_CLAIMS_NUMBER = "POL-EXPENSES-000002";

/** steward-core's rendered number for the seeded Travel Booking Procedure, the draft in review. */
export const TRAVEL_BOOKING_NUMBER = "PRC-TRAVEL-000003";

/** A version's content as the reader reads it: one entry per section, in order. */
const sections = (...entries: [string, string, string][]): string =>
  JSON.stringify(
    entries.map(([sectionKey, title, text]) => ({ sectionKey, text, title })),
  );

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

/** A draft's content as the editor writes it: a Lexical document, a heading per section. */
const lexical = (...entries: [string, string][]): string =>
  JSON.stringify({
    root: {
      children: entries.flatMap(([heading, paragraph]) => [
        block("heading", heading, { tag: "h1" }),
        block("paragraph", paragraph, { textFormat: 0, textStyle: "" }),
      ]),
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });

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
    ownerUserId: "user-alice",
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
    contentJson: sections(
      ["purpose", "Purpose", "How staff claim back business expenses."],
      ["scope", "Scope", "Everyone who travels or buys for the organisation."],
      [
        "policy-statement",
        "Policy statement",
        "Claims are paid in US dollars only.",
      ],
    ),
    createdAt: "2025-06-02T09:00:00Z",
    id: "version-1",
    policyId: "policy-1",
    publishedAt: "2025-06-20T00:00:00Z",
    status: "SUPERSEDED",
    templateVersionId: "template-version-1",
    versionNo: 1,
  }),
  version({
    contentJson: sections(
      ["purpose", "Purpose", "How staff claim back business expenses."],
      ["scope", "Scope", "Everyone who travels or buys for the organisation."],
      [
        "policy-statement",
        "Policy statement",
        "File a claim within 60 days of spending the money and post the original receipts to Finance.",
      ],
    ),
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
    contentJson: sections(
      ["purpose", "Purpose", "How staff claim back business expenses."],
      ["scope", "Scope", "Everyone who travels or buys for the organisation."],
      [
        "policy-statement",
        "Policy statement",
        "File your claim within 30 days of spending the money, using the expenses page. Attach a clear photo of each receipt; you don't need to post the originals. Claims are paid at the rate set for the country the cost was incurred in.",
      ],
    ),
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
  }),
  version({
    contentJson: sections(
      [
        "steps",
        "Steps",
        "Book trains, flights and hotels on the travel booking site at least 14 days ahead.",
      ],
      [
        "afterwards",
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
    contentJson: sections([
      "policy-statement",
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
    contentJson: sections([
      "policy-statement",
      "Policy statement",
      "Mileage in a private car is paid at the rate Finance sets each April.",
    ]),
    createdAt: "2026-02-10T00:00:00Z",
    id: "version-6",
    policyId: "policy-5",
    status: "WITHDRAWN",
  }),
  version({
    contentJson: sections(
      [
        "steps",
        "Steps",
        "Tell the IT Service Desk as soon as you notice the device is missing, then change your password from another device.",
      ],
      [
        "afterwards",
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
    contentJson: sections([
      "policy-statement",
      "Policy statement",
      "Declare any gift or hospitality worth more than a modest amount.",
    ]),
    createdAt: "2026-06-25T09:15:00Z",
    id: "version-8",
    policyId: "policy-7",
    status: "REJECTED",
  }),
  version({
    contentJson: sections(
      [
        "purpose",
        "Purpose",
        "Who may hold administrator access to stored records, and how it is granted.",
      ],
      [
        "policy-statement",
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
    contentJson: sections(
      ["purpose", "Purpose", "How staff book a desk in the office."],
      ["scope", "Scope", "Everyone who works from an organisation office."],
      [
        "policy-statement",
        "Policy statement",
        "Book a desk up to two weeks ahead on the booking page. Cancel the booking by 10:00 if your plans change, so a colleague can use the desk.",
      ],
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
    contentJson: sections(
      ["purpose", "Purpose", "How visitors are welcomed and kept safe."],
      ["scope", "Scope", "Everyone who invites a visitor to an office."],
      [
        "policy-statement",
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
): Seat => ({
  comment: decided?.comment ?? null,
  decidedAt: decided?.at ?? null,
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
];

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
];
