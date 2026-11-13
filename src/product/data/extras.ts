// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// More seeded documents (bug log 214): policies and procedures in every state, appendices with
// formatted text, files attached, review threads and suggestions at different stages, a
// three-seat step, and a freeform policy. All of it is data, fixed on every reset.
//
// None of these asks for an acknowledgement (ackTriggers NONE) so the seeded obligations that
// the existing tests pin stay as they were.

import type { PolicyAppendix } from "#product/appendices.ts";
import type { Workflow } from "#product/data/library.ts";
import type { ReviewThread } from "#product/resolvers/review-threads.ts";

import { FILE_SIZES } from "#product/data/files.ts";
import {
  type Block,
  block,
  document,
  h1,
  h2,
  lexical,
  p,
  policy,
  type Policy,
  type PolicyVersion,
  type Run,
  seat,
  table,
  text,
  version,
} from "#product/data/policies.ts";

/** The seeded files' ids, in the order files.ts keeps their bytes. */
export const SEEDED_FILE_IDS = {
  image: "asset-seed-2",
  pdf: "asset-seed-1",
} as const;

/** A paragraph with some words in bold, italic or both. */
export const rich = (...parts: [string, number?][]): Block =>
  block("paragraph", "", {
    children: parts.map(([value, format]) => ({
      ...text(value),
      format: format ?? 0,
    })),
    textFormat: 0,
    textStyle: "",
  });

const item = (value: string, order: number) =>
  block("listitem", "", {
    children: [text(value)],
    value: order,
  });

/** A bulleted or numbered list. */
export const list = (kind: "bullet" | "number", ...items: string[]): Block =>
  block("list", "", {
    children: items.map((value, index) => item(value, index + 1)),
    listType: kind,
    start: 1,
    tag: kind === "bullet" ? "ul" : "ol",
  });

export const fileCard = (
  id: string,
  name: string,
  size: number,
  title: string,
): Block =>
  block("file", "", {
    fileCaption: "",
    fileName: name,
    fileSize: size,
    fileTitle: title,
    src: `/api/assets/${id}`,
  });

export const imageCard = (id: string, alt: string): Block =>
  block("image", "", {
    alt,
    caption: "",
    height: 1,
    src: `/api/assets/${id}`,
    width: 1,
  });

export const appendixText = (
  title: string,
  ...body: (Block | ReturnType<typeof table>)[]
): string => document(h1(title), ...body);

export const extraWorkflows = (): Workflow[] => [
  {
    archived: false,
    description:
      "A committee of three must all agree, then a majority of three signs off.",
    id: "workflow-4",
    name: "Policy committee",
    stages: [
      {
        approvers: ["user-charlie", "user-alice", "user-dave"],
        approversByCategory: [],
        groupUnits: [],
        id: "workflow-stage-5",
        name: "Committee review",
        pinnedLast: false,
        quorum: "all",
        quorumN: 0,
        rejectOnSlaBreach: false,
        slaDays: 7,
        vetoUserIds: [],
      },
      {
        approvers: ["user-charlie", "user-alice", "user-dave"],
        approversByCategory: [],
        groupUnits: [],
        id: "workflow-stage-6",
        name: "Sign-off",
        pinnedLast: true,
        quorum: "majority",
        quorumN: 0,
        rejectOnSlaBreach: false,
        slaDays: null,
        vetoUserIds: [],
      },
    ],
    version: 1,
  },
];

export const extraPolicies = (): Policy[] => [
  // Published with a history and three appendices.
  policy({
    ackTriggers: "NONE",
    createdAt: "2026-03-02T09:00:00Z",
    currentPublishedVersionId: "version-14",
    homeCategoryId: "category-finance",
    id: "policy-11",
    number: "POL-FINANCE-000003",
    templateId: "template-1",
    templateNone: false,
    title: "Procurement Policy",
    updatedAt: "2026-10-12T00:00:00Z",
  }),
  // A published procedure with a file and an appendix.
  policy({
    createdAt: "2026-04-14T09:00:00Z",
    currentPublishedVersionId: "version-15",
    documentType: "PROCEDURE",
    homeCategoryId: "category-finance",
    id: "policy-12",
    number: "PRC-FINANCE-000001",
    templateId: "template-2",
    templateNone: false,
    title: "Month-end Close Procedure",
    updatedAt: "2026-09-30T00:00:00Z",
  }),
  // A draft that has never been published, with every required section filled.
  policy({
    createdAt: "2026-10-20T09:00:00Z",
    currentDraftVersionId: "version-16",
    homeCategoryId: "category-people",
    id: "policy-13",
    number: "POL-PEOPLE-000001",
    templateId: "template-1",
    templateNone: false,
    title: "Remote Working Policy",
    updatedAt: "2026-10-22T00:00:00Z",
  }),
  // A procedure draft with required sections missing.
  policy({
    createdAt: "2026-10-25T09:00:00Z",
    currentDraftVersionId: "version-17",
    documentType: "PROCEDURE",
    homeCategoryId: "category-people",
    id: "policy-14",
    number: "PRC-PEOPLE-000001",
    templateId: "template-2",
    templateNone: false,
    title: "New Starter Procedure",
    updatedAt: "2026-10-26T00:00:00Z",
  }),
  // In review before a three-seat committee, with threads and suggestions.
  policy({
    createdAt: "2026-10-05T09:00:00Z",
    currentDraftVersionId: "version-18",
    homeCategoryId: "category-information",
    id: "policy-15",
    number: "POL-INFORMATION-000001",
    templateId: "template-1",
    templateNone: false,
    title: "Acceptable Use Policy",
    updatedAt: "2026-11-02T00:00:00Z",
    workflowDefId: "workflow-4",
  }),
  // A procedure in review with a one-seat step and a thread waiting on the author.
  policy({
    createdAt: "2026-10-08T09:00:00Z",
    currentDraftVersionId: "version-19",
    documentType: "PROCEDURE",
    homeCategoryId: "category-information",
    id: "policy-16",
    number: "PRC-INFORMATION-000001",
    templateId: "template-2",
    templateNone: false,
    title: "Access Request Procedure",
    updatedAt: "2026-11-03T00:00:00Z",
    workflowDefId: "workflow-1",
  }),
  // Rejected by a majority.
  policy({
    createdAt: "2026-08-10T09:00:00Z",
    currentDraftVersionId: "version-20",
    homeCategoryId: "category-people",
    id: "policy-17",
    number: "POL-PEOPLE-000002",
    templateId: "template-1",
    templateNone: false,
    title: "Dress Code Policy",
    updatedAt: "2026-09-18T00:00:00Z",
    workflowDefId: "workflow-4",
  }),
  // A procedure withdrawn from review.
  policy({
    createdAt: "2026-09-02T09:00:00Z",
    currentDraftVersionId: "version-21",
    documentType: "PROCEDURE",
    homeCategoryId: "category-facilities",
    id: "policy-18",
    number: "PRC-FACILITIES-000002",
    templateId: "template-2",
    templateNone: false,
    title: "Fire Drill Procedure",
    updatedAt: "2026-09-12T00:00:00Z",
  }),
  // Freeform: no template, written from a blank page.
  policy({
    createdAt: "2026-10-30T09:00:00Z",
    currentDraftVersionId: "version-22",
    homeCategoryId: "category-facilities",
    id: "policy-19",
    number: "POL-FACILITIES-000002",
    templateNone: true,
    title: "Quiet Hours Notes",
    updatedAt: "2026-10-30T00:00:00Z",
  }),
];

const procurement = (days: string, supplier: string): string =>
  document(
    h1("Purpose"),
    p("How the organisation buys goods and services."),
    h1("Scope"),
    p("Every purchase made on the organisation's behalf."),
    h1("Policy statement"),
    rich(
      ["Get ", 0],
      ["three quotes", 1],
      [` for any purchase over ${days}.`, 0],
    ),
    list(
      "bullet",
      "Raise a purchase request before you commit.",
      `Use ${supplier} where a framework agreement exists.`,
      "Keep the quotes with the request.",
    ),
  );

export const extraVersions = (): PolicyVersion[] => [
  version({
    contentJson: procurement("$2,000", "an approved supplier"),
    createdAt: "2026-03-02T09:00:00Z",
    id: "version-13",
    policyId: "policy-11",
    publishedAt: "2026-03-20T00:00:00Z",
    status: "SUPERSEDED",
    templateVersionId: "template-version-1",
    versionNo: 1,
  }),
  version({
    appendices: [
      {
        contentJson: appendixText(
          "Approval limits",
          p("Who can approve a purchase, by value."),
          table(
            ["Value", "Approver"],
            ["Up to $2,000", "Budget holder"],
            ["$2,001 to $20,000", "Head of department"],
            ["Over $20,000", "Finance director"],
          ),
        ),
        id: "appendix-4",
        letter: "A",
        orderIndex: 0,
        policyVersionId: "version-14",
        title: "Approval limits",
      },
      {
        contentJson: appendixText(
          "Quote checklist",
          rich(["Before you ask for a quote:", 1]),
          list(
            "number",
            "Write down what you need and when.",
            "Send the same brief to every supplier.",
            "Record each reply in the purchase request.",
          ),
          rich(["Never", 3], [" split a purchase to stay under a limit.", 0]),
        ),
        id: "appendix-5",
        letter: "B",
        orderIndex: 1,
        policyVersionId: "version-14",
        title: "Quote checklist",
      },
      {
        contentJson: appendixText(
          "Supplier terms",
          h2("Framework agreements"),
          p("Terms agreed with preferred suppliers, reviewed each year."),
          fileCard(
            SEEDED_FILE_IDS.pdf,
            "supplier-terms.pdf",
            FILE_SIZES[SEEDED_FILE_IDS.pdf] ?? 0,
            "Supplier terms",
          ),
        ),
        id: "appendix-6",
        letter: "C",
        orderIndex: 2,
        policyVersionId: "version-14",
        title: "Supplier terms",
      },
    ],
    contentJson: procurement("$5,000", "a framework supplier"),
    createdAt: "2026-09-25T09:00:00Z",
    id: "version-14",
    policyId: "policy-11",
    publishedAt: "2026-10-12T00:00:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-1",
    versionNo: 2,
  }),
  version({
    appendices: [
      {
        contentJson: appendixText(
          "Close calendar",
          p("The working days on which each step is due."),
          list(
            "bullet",
            "Day 1: accruals posted.",
            "Day 2: bank reconciliations done.",
            "Day 3: management accounts issued.",
          ),
        ),
        id: "appendix-7",
        letter: "A",
        orderIndex: 0,
        policyVersionId: "version-15",
        title: "Close calendar",
      },
    ],
    contentJson: lexical(
      [
        "Steps",
        "Post the month's accruals before the books close.",
        "Reconcile every bank account and sign the reconciliation.",
      ],
      ["Afterwards", "Send the management accounts to the finance director."],
    ).replace(
      /\]\}\}$/,
      `,${JSON.stringify(imageCard(SEEDED_FILE_IDS.image, "Close timeline"))}]}}`,
    ),
    createdAt: "2026-04-14T09:00:00Z",
    id: "version-15",
    policyId: "policy-12",
    publishedAt: "2026-09-30T00:00:00Z",
    status: "PUBLISHED",
    templateVersionId: "template-version-2",
    versionNo: 1,
  }),
  version({
    contentJson: lexical(
      ["Purpose", "When and how staff may work away from the office."],
      ["Scope", "Every employee whose role allows remote work."],
      [
        "Policy statement",
        "Agree your days with your manager. Keep your work on organisation devices.",
      ],
    ),
    createdAt: "2026-10-20T09:00:00Z",
    id: "version-16",
    policyId: "policy-13",
    status: "DRAFT",
    templateVersionId: "template-version-1",
  }),
  version({
    // "Steps" is required by the template and left empty; there is no Afterwards.
    contentJson: lexical(["Steps"]),
    createdAt: "2026-10-25T09:00:00Z",
    id: "version-17",
    policyId: "policy-14",
    status: "DRAFT",
    templateVersionId: "template-version-2",
  }),
  version({
    contentJson: lexical(
      [
        "Purpose",
        "What staff may and may not do with the organisation's systems.",
      ],
      ["Scope", "Everyone with an account."],
      [
        "Policy statement",
        "Use systems for work. Report anything suspicious to the service desk at once.",
      ],
    ),
    createdAt: "2026-10-05T09:00:00Z",
    id: "version-18",
    policyId: "policy-15",
    status: "IN_REVIEW",
    templateVersionId: "template-version-1",
  }),
  version({
    contentJson: lexical(
      [
        "Steps",
        "Ask your manager. The system owner grants access within two days.",
      ],
      ["Afterwards", "Access is reviewed every quarter."],
    ),
    createdAt: "2026-10-08T09:00:00Z",
    id: "version-19",
    policyId: "policy-16",
    status: "IN_REVIEW",
    templateVersionId: "template-version-2",
  }),
  version({
    contentJson: lexical(
      ["Purpose", "What staff wear to work."],
      ["Scope", "All offices."],
      ["Policy statement", "Dress for the day you have."],
    ),
    createdAt: "2026-08-10T09:00:00Z",
    id: "version-20",
    policyId: "policy-17",
    status: "REJECTED",
    templateVersionId: "template-version-1",
  }),
  version({
    contentJson: lexical([
      "Steps",
      "When the alarm sounds, leave by the nearest exit.",
    ]),
    createdAt: "2026-09-02T09:00:00Z",
    id: "version-21",
    policyId: "policy-18",
    status: "WITHDRAWN",
    templateVersionId: "template-version-2",
  }),
  version({
    contentJson: document(h1("Quiet hours"), p("")),
    createdAt: "2026-10-30T09:00:00Z",
    id: "version-22",
    policyId: "policy-19",
    status: "DRAFT",
  }),
];

export const extraRuns = (): Run[] => [
  {
    currentStageIdx: 0,
    id: "run-4",
    policyId: "policy-15",
    policyVersionId: "version-18",
    stages: [
      {
        name: "Committee review",
        quorum: "all",
        seats: [
          seat("task-13", "user-charlie", {
            at: "2026-11-03T10:00:00Z",
            comment: "Fine by me.",
            state: "approved",
          }),
          seat("task-14", "user-alice"),
          seat("task-15", "user-dave"),
        ],
      },
      {
        name: "Sign-off",
        quorum: "majority",
        seats: [
          seat("task-16", "user-charlie"),
          seat("task-17", "user-alice"),
          seat("task-18", "user-dave"),
        ],
      },
    ],
    status: "APPROVAL_STATUS_IN_REVIEW",
    submittedAt: "2026-11-02T09:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-4",
  },
  {
    currentStageIdx: 0,
    id: "run-5",
    policyId: "policy-16",
    policyVersionId: "version-19",
    stages: [
      {
        name: "Finance sign-off",
        quorum: "one",
        seats: [seat("task-19", "user-charlie")],
      },
    ],
    status: "APPROVAL_STATUS_IN_REVIEW",
    submittedAt: "2026-11-03T09:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-1",
  },
  {
    currentStageIdx: 0,
    id: "run-6",
    policyId: "policy-17",
    policyVersionId: "version-20",
    stages: [
      {
        name: "Committee review",
        quorum: "all",
        seats: [
          seat("task-20", "user-charlie", {
            at: "2026-09-16T10:00:00Z",
            comment: "This needs a safety exemption.",
            state: "rejected",
          }),
          seat("task-21", "user-alice", {
            at: "2026-09-17T10:00:00Z",
            comment: "Agree with Charlie.",
            state: "rejected",
          }),
          seat("task-22", "user-dave"),
        ],
      },
    ],
    status: "APPROVAL_STATUS_REJECTED",
    submittedAt: "2026-09-15T09:00:00Z",
    submittedBy: "user-bob",
    workflowDefId: "workflow-4",
  },
];

/** Threads at different stages, from different approvers; ids are fixed so reloads agree. */
export const extraThreads = (): ReviewThread[] => [
  // Charlie's open question, waiting on the author.
  {
    approverUserId: "user-charlie",
    createdAt: "2026-11-03T11:00:00Z",
    id: "thread-seed-1",
    messages: [
      {
        authorUserId: "user-charlie",
        body: "Which systems does this cover?",
        createdAt: "2026-11-03T11:00:00Z",
        id: "message-seed-1",
      },
    ],
    occurrence: 1,
    policyVersionId: "version-18",
    quote: "Use systems for work.",
    resolved: false,
    suggestion: null,
  },
  // A suggestion on the author's turn: Alice proposes new wording.
  {
    approverUserId: "user-alice",
    createdAt: "2026-11-04T09:00:00Z",
    id: "thread-seed-2",
    messages: [
      {
        authorUserId: "user-alice",
        body: "Say who to call.",
        createdAt: "2026-11-04T09:00:00Z",
        id: "message-seed-2",
      },
    ],
    occurrence: 1,
    policyVersionId: "version-18",
    quote: "Report anything suspicious to the service desk at once.",
    resolved: false,
    suggestion: {
      closedBy: null,
      closedText: null,
      outcome: null,
      reason: null,
      rounds: [
        {
          by: "REVIEWER",
          createdAt: "2026-11-04T09:00:00Z",
          text: "Report anything suspicious to the service desk (ext. 4400) at once.",
          userId: "user-alice",
        },
      ],
      text: "Report anything suspicious to the service desk (ext. 4400) at once.",
      turn: "AUTHOR",
    },
  },
  // A resolved thread on the one-seat procedure, closed with the author's change.
  {
    approverUserId: "user-charlie",
    createdAt: "2026-11-04T10:00:00Z",
    id: "thread-seed-3",
    messages: [
      {
        authorUserId: "user-charlie",
        body: "Two days is long. Can it be one?",
        createdAt: "2026-11-04T10:00:00Z",
        id: "message-seed-3",
      },
      {
        authorUserId: "user-bob",
        body: "Changed to one working day.",
        createdAt: "2026-11-04T12:00:00Z",
        id: "message-seed-4",
      },
    ],
    occurrence: 1,
    policyVersionId: "version-19",
    quote: "within two days",
    resolved: true,
    suggestion: {
      closedBy: "user-bob",
      closedText: "within one working day",
      outcome: "CHANGED",
      reason: null,
      rounds: [
        {
          by: "REVIEWER",
          createdAt: "2026-11-04T10:00:00Z",
          text: "within one working day",
          userId: "user-charlie",
        },
      ],
      text: "within one working day",
      turn: "REVIEWER",
    },
  },
  // An open suggestion on the reviewer's turn: Bob countered Charlie.
  {
    approverUserId: "user-charlie",
    createdAt: "2026-11-05T09:00:00Z",
    id: "thread-seed-4",
    messages: [
      {
        authorUserId: "user-charlie",
        body: "Review access every month.",
        createdAt: "2026-11-05T09:00:00Z",
        id: "message-seed-5",
      },
    ],
    occurrence: 1,
    policyVersionId: "version-19",
    quote: "Access is reviewed every quarter.",
    resolved: false,
    suggestion: {
      closedBy: null,
      closedText: null,
      outcome: null,
      reason: null,
      rounds: [
        {
          by: "REVIEWER",
          createdAt: "2026-11-05T09:00:00Z",
          text: "Access is reviewed every month.",
          userId: "user-charlie",
        },
        {
          by: "AUTHOR",
          createdAt: "2026-11-05T11:00:00Z",
          text: "Access is reviewed every two months.",
          userId: "user-bob",
        },
      ],
      text: "Access is reviewed every two months.",
      turn: "REVIEWER",
    },
  },
];

/**
 * PRC-TRAVEL-000003 (policy-3) is in review and was never published, so it has no appendix from
 * the version migration. It gets one published appendix of its own, "Appendix A" (a title no other
 * appendix of the policy has), with a heading, bold words, a list and a table, so the approval
 * screen's Upcoming version has a formatted appendix to show.
 */
export const travelAppendices = (): PolicyAppendix[] => {
  const at = "2026-09-14T10:00:00Z";
  return [
    {
      createdAt: at,
      createdBy: "user-bob",
      id: "appendix-8",
      orderIndex: 0,
      policyId: "policy-3",
      retiredAt: null,
      retiredBy: null,
      versions: [
        {
          contentJson: appendixText(
            "Appendix A",
            rich(
              ["Book through the ", 0],
              ["approved travel portal", 1],
              [" unless the fare is ", 0],
              ["lower elsewhere", 2],
              [" and you keep the proof.", 0],
            ),
            list(
              "number",
              "Check the fare class table below.",
              "Book at least 14 days ahead where you can.",
              "Keep the booking confirmation with your claim.",
            ),
            table(
              ["Trip", "Class allowed"],
              ["Under 4 hours", "Economy"],
              ["4 to 8 hours", "Premium economy"],
              ["Over 8 hours", "Business with approval"],
            ),
          ),
          createdAt: at,
          createdBy: "user-bob",
          editors: ["user-bob"],
          id: "appendix-8-v1",
          publishedAt: at,
          publishedBy: "user-bob",
          state: "PUBLISHED",
          title: "Appendix A",
          updatedAt: at,
          updatedBy: "user-bob",
          versionNo: 1,
        },
      ],
    },
  ];
};
