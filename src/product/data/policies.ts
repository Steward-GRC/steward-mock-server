// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The policies and procedures, their versions, what each links to, the approval runs and the
// acknowledgements. Between them they cover every state the library and the reader show: a
// published policy with an earlier version and a pending acknowledgement, a sensitive draft, a
// draft in review waiting on an approver, a retired policy, a withdrawn draft, a published
// procedure and a rejected one.

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

/** steward-core's rendered number for the seeded Expense Claims policy. */
export const EXPENSE_CLAIMS_NUMBER = "POL-REIMBU-000001";

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
    homeCategoryId: "category-reimbursement",
    id: "policy-1",
    number: EXPENSE_CLAIMS_NUMBER,
    templateId: "template-1",
    templateNone: false,
    title: "Expense Claims",
    updatedAt: "2026-08-12T00:00:00Z",
  }),
  policy({
    createdAt: "2026-09-02T00:00:00Z",
    currentDraftVersionId: "version-3",
    homeCategoryId: "category-usage",
    id: "policy-2",
    number: "POL-USAGE-000001",
    sensitivity: "SENSITIVE",
    title: "Acceptable Use",
    updatedAt: "2026-09-02T00:00:00Z",
  }),
  policy({
    createdAt: "2026-09-13T14:30:00Z",
    currentDraftVersionId: "version-4",
    homeCategoryId: "category-data-governance",
    id: "policy-3",
    number: "POL-DATAGO-000001",
    sensitivity: "SENSITIVE",
    title: "Data Classification",
    updatedAt: "2026-09-20T00:00:00Z",
  }),
  policy({
    createdAt: "2026-04-20T09:15:00Z",
    currentPublishedVersionId: "version-5",
    homeCategoryId: "category-workplace",
    id: "policy-4",
    number: "POL-WORKPL-000001",
    retiredAt: "2026-09-01T00:00:00Z",
    title: "Remote Work",
    updatedAt: "2026-09-01T00:00:00Z",
  }),
  policy({
    createdAt: "2026-02-10T00:00:00Z",
    currentDraftVersionId: "version-6",
    homeCategoryId: "category-due-diligence",
    id: "policy-5",
    number: "POL-DUEDIL-000001",
    ownerUserId: "user-alice",
    title: "Vendor Onboarding",
    updatedAt: "2026-03-18T00:00:00Z",
  }),
  policy({
    createdAt: "2026-09-20T00:00:00Z",
    currentPublishedVersionId: "version-7",
    documentType: "PROCEDURE",
    homeCategoryId: "category-operations",
    id: "policy-6",
    number: "PRC-OPERAT-000001",
    templateId: "template-2",
    templateNone: false,
    title: "Incident Response Runbook",
    updatedAt: "2026-09-28T00:00:00Z",
  }),
  policy({
    createdAt: "2026-06-25T09:15:00Z",
    currentDraftVersionId: "version-8",
    documentType: "PROCEDURE",
    homeCategoryId: "category-ethics",
    id: "policy-7",
    number: "PRC-ETHICS-000001",
    title: "Gift Disclosure",
    updatedAt: "2026-07-09T00:00:00Z",
  }),
  policy({
    createdAt: "2026-05-04T00:00:00Z",
    currentPublishedVersionId: "version-9",
    homeCategoryId: "category-usage",
    id: "policy-8",
    number: "POL-USAGE-000002",
    sensitivity: "SENSITIVE",
    title: "Privileged Access",
    updatedAt: "2026-05-04T00:00:00Z",
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
        "Claims are paid at the rate set for the country the cost was incurred in, within 30 days of a complete claim.",
      ],
    ),
    createdAt: "2026-07-29T09:15:00Z",
    id: "version-2",
    policyId: "policy-1",
    publishedAt: "2026-08-12T00:00:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-1",
    versionNo: 2,
  }),
  version({
    appendices: [
      {
        contentJson: JSON.stringify({
          text: "Reviewed annually by IT Security.",
        }),
        id: "appendix-2",
        letter: "A",
        orderIndex: 0,
        policyVersionId: "version-3",
        title: "Review notes",
      },
      {
        contentJson: JSON.stringify({ text: "Laptops, phones and tablets." }),
        id: "appendix-3",
        letter: "B",
        orderIndex: 1,
        policyVersionId: "version-3",
        title: "Covered devices",
      },
    ],
    contentJson: lexical(
      [
        "Purpose",
        "This policy sets out how organisation-owned systems may be used.",
      ],
      ["Scope", ""],
    ),
    createdAt: "2026-09-02T00:00:00Z",
    id: "version-3",
    policyId: "policy-2",
  }),
  version({
    contentJson: sections(
      ["purpose", "Purpose", "How information is labelled by sensitivity."],
      [
        "policy-statement",
        "Policy statement",
        "Every record is Public, Internal, Confidential or Restricted.",
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
      "Staff may work remotely up to three days a week with their manager's agreement.",
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
      "New vendors pass due diligence before their first order.",
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
        "Contain the incident, tell the security lead, then preserve evidence.",
      ],
      [
        "rollback",
        "Rollback",
        "Restore from the last known-good backup once the cause is found.",
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
      "Disclose any gift worth more than a modest amount.",
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
        "Who may hold administrator access, and how it is granted.",
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
        name: "Board review",
        quorum: "majority",
        seats: [seat("task-1", "user-charlie"), seat("task-2", "user-alice")],
      },
      {
        name: "Final sign-off",
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
        name: "Approval",
        quorum: "one",
        seats: [
          seat("task-4", "user-charlie", {
            at: "2026-07-09T00:00:00Z",
            comment: "Needs the disclosure threshold spelled out.",
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
];
