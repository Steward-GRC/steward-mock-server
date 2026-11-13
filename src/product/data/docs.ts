// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The docs start state (MOCK_START=docs): a data set designed for the user guide's screenshots. One
// coherent fictional organisation, "Example Organisation", with the eight placeholder people, a
// three-level category tree, four workflows, and thirteen documents on believable topics, each in
// the state one of the guide's screenshots needs. Every id and every document number is fixed, so
// the guide can name them, and every date is absolute, so a boot always reads the same.
/* oxlint-disable unicorn-js/prevent-abbreviations -- "docs" is the start state's name */

import type { PolicyAppendix } from "#product/appendices.ts";
import type { VersionLinks } from "#product/links.ts";
import type { ReviewThread } from "#product/resolvers/review-threads.ts";

import { syncAppendices } from "#product/appendices.ts";
import { demoSeed, type StewardData } from "#product/data.ts";
import * as prose from "#product/data/docs-content.ts";
import {
  type Category,
  type ContactBlock,
  type Definition,
  type Reference,
  section,
  stage,
  type TemplateVersion,
  withSiblingOrder,
  type Workflow,
} from "#product/data/library.ts";
import {
  policy,
  type Policy,
  type PolicyVersion,
  type Run,
  seat,
  version,
} from "#product/data/policies.ts";

const BOB = "user-bob";
const CHARLIE = "user-charlie";
const ALICE = "user-alice";
const DAVE = "user-dave";
const FRANK = "user-frank";
const HEIDI = "user-heidi";

/** The eight people: no second factor to enrol, Frank enabled as an approver. */
const docsPeople = (): StewardData["people"] =>
  demoSeed().people.map((person) => {
    const {
      enrolSecondFactor: _enrol,
      totpEnrolledAt: _at,
      totpLabel: _label,
      ...rest
    } = person as {
      enrolSecondFactor?: boolean;
      totpEnrolledAt?: string;
      totpLabel?: null | string;
    } & typeof person;
    // A passkey is a strong factor, so the staff app shows no "add an authenticator app" nudge, and
    // it asks for nothing more at a password sign-in.
    const kept = {
      ...rest,
      localAccount: true,
      passkey: true,
      passkeyCreatedAt: "2026-06-18T08:15:00Z",
      passkeyLabel: "Work laptop",
      secondFactor: false,
    };
    return person.id === FRANK
      ? {
          ...kept,
          disabled: false,
          groups: ["All staff", "Facilities team"],
          name: "Frank Approver",
          roles: ["approver"],
        }
      : kept;
  });

/** The category tree: Information goes three levels deep, and Devices is left without documents. */
const docsCategories = (): Category[] => {
  const base = demoSeed().categories;
  const find = (id: string) => {
    const found = base.find((c) => c.id === id);
    if (!found) throw new Error(`no category ${id}`);
    return found;
  };
  const patch = (id: string, given: Partial<Category>): Category => ({
    ...find(id),
    ...given,
  });
  const security: Category = {
    ...find("category-records"),
    code: "SECURITY",
    defaultTemplateId: "template-1",
    id: "category-security",
    name: "Security",
    parentId: "category-information",
    slug: "security",
  };
  const incident: Category = {
    ...security,
    code: "INCIDENT",
    id: "category-incident-response",
    name: "Incident response",
    parentId: "category-security",
    slug: "incident-response",
  };
  return withSiblingOrder([
    // Finance: the locked default template (admin-1, "Authors must use this template").
    patch("category-finance", {
      defaultTemplateLocked: true,
      owners: [CHARLIE],
    }),
    patch("category-expenses", {}),
    patch("category-purchasing", {
      defaultTemplateId: "template-1",
      defaultTemplateLocked: true,
    }),
    patch("category-people", { owners: [ALICE] }),
    patch("category-leave", {}),
    patch("category-conduct", {}),
    // Information: a default template that is not locked.
    patch("category-information", {
      defaultTemplateLocked: false,
      defaultWorkflowId: "workflow-3",
      owners: [DAVE],
    }),
    patch("category-records", {}),
    security,
    incident,
    patch("category-devices", {}),
    patch("category-phones", {}),
    patch("category-workplace", {
      authorRule: [BOB, HEIDI],
      owners: [HEIDI],
    }),
    patch("category-facilities", {}),
    patch("category-travel", { authorRule: [] }),
  ]);
};

const docsTemplateVersions = (): TemplateVersion[] => [
  {
    id: "template-version-1",
    sections: [
      section("purpose", "Purpose", 0),
      section("scope", "Scope", 1),
      section("policy-statement", "Policy statement", 2),
      section("responsibilities", "Responsibilities", 3, false),
      section("exceptions", "Exceptions", 4, false),
    ],
    status: "published",
    templateId: "template-1",
    versionNo: 1,
  },
  {
    id: "template-version-2",
    sections: [
      section("steps", "Steps", 0),
      section("afterwards", "Afterwards", 1, false),
    ],
    status: "published",
    templateId: "template-2",
    versionNo: 1,
  },
  {
    id: "template-version-3",
    sections: [
      section("purpose", "Purpose", 0),
      section("scope", "Scope", 1),
      section("policy-statement", "Policy statement", 2),
      section("responsibilities", "Responsibilities", 3, false),
      section("exceptions", "Exceptions", 4, false),
      section("related-documents", "Related documents", 5, false),
    ],
    status: "draft",
    templateId: "template-1",
    versionNo: 2,
  },
  {
    id: "template-version-4",
    sections: [section("notice", "Notice", 0)],
    status: "published",
    templateId: "template-3",
    versionNo: 1,
  },
];

const docsWorkflows = (): Workflow[] => [
  {
    archived: false,
    description: "One approver signs the document off.",
    id: "workflow-1",
    name: "Single approver",
    stages: [
      stage({
        approvers: [CHARLIE],
        id: "workflow-stage-1",
        name: "Approval",
        slaDays: 5,
      }),
    ],
    version: 1,
    vetoEnabled: false,
  },
  {
    archived: false,
    description: "A line review, then a final sign-off.",
    id: "workflow-2",
    name: "Two-stage review",
    stages: [
      stage({
        approvers: [CHARLIE],
        id: "workflow-stage-2",
        name: "Line review",
        slaDays: 5,
      }),
      stage({
        approvers: [ALICE],
        id: "workflow-stage-3",
        name: "Final sign-off",
        pinnedLast: true,
      }),
    ],
    version: 1,
    vetoEnabled: false,
  },
  {
    archived: false,
    description:
      "A committee of three, two of whom must agree, with a veto for the Privacy Officer, then a sign-off.",
    id: "workflow-3",
    name: "Committee with veto",
    stages: [
      stage({
        approvers: [CHARLIE, ALICE, DAVE],
        id: "workflow-stage-4",
        name: "Committee review",
        quorum: "majority",
        rejectOnSlaBreach: false,
        slaDays: 7,
        vetoUserIds: [DAVE],
      }),
      stage({
        approvers: [ALICE],
        id: "workflow-stage-5",
        name: "Sign-off",
        pinnedLast: true,
      }),
    ],
    version: 1,
    vetoEnabled: false,
  },
  {
    archived: false,
    description:
      "For documents that touch contracts and money: four stages, from the line manager to the executive.",
    id: "workflow-4",
    name: "Executive review",
    stages: [
      stage({
        approvers: [HEIDI],
        id: "workflow-stage-6",
        name: "Line manager",
        slaDays: 3,
      }),
      stage({
        approvers: [DAVE],
        id: "workflow-stage-7",
        name: "Privacy",
        slaDays: 5,
      }),
      stage({
        approvers: [CHARLIE, FRANK],
        id: "workflow-stage-8",
        name: "Security and finance",
        quorum: "all",
        slaDays: 5,
      }),
      stage({
        approvers: [ALICE],
        id: "workflow-stage-9",
        name: "Executive sign-off",
        pinnedLast: true,
      }),
    ],
    version: 1,
    vetoEnabled: false,
  },
];

const docsDefinitions = (): Definition[] => [
  {
    archived: false,
    categoryId: "category-records",
    createdByUserId: ALICE,
    definition:
      "The length of time a record must be kept before it can be disposed of.",
    id: "definition-1",
    term: "Retention period",
  },
  {
    archived: false,
    categoryId: "category-records",
    createdByUserId: ALICE,
    definition:
      "An instruction to keep records beyond their retention period because they may be needed for legal or regulatory reasons.",
    id: "definition-2",
    term: "Legal hold",
  },
  {
    archived: false,
    categoryId: "category-security",
    createdByUserId: ALICE,
    definition:
      "A loss of confidentiality, integrity or availability of information or systems.",
    id: "definition-3",
    term: "Security incident",
  },
  {
    archived: false,
    categoryId: "category-security",
    createdByUserId: ALICE,
    definition:
      "Information that identifies a person, or could be used to identify them.",
    id: "definition-4",
    term: "Personal data",
  },
  {
    archived: false,
    categoryId: "category-expenses",
    createdByUserId: CHARLIE,
    definition:
      "Money spent on the organisation's behalf that is claimed back through an expense claim.",
    id: "definition-5",
    term: "Business expense",
  },
];

const docsReferences = (): Reference[] => [
  {
    archived: false,
    body: null,
    clause: "Clause 8.1",
    createdByUserId: ALICE,
    id: "reference-1",
    kind: "STANDARD",
    label: "ISO 27001",
    url: null,
  },
  {
    archived: false,
    body: "Keep records for the longest period any applicable regulator sets.",
    clause: null,
    createdByUserId: DAVE,
    id: "reference-2",
    kind: "TEXT",
    label: "Retention baseline",
    url: null,
  },
  {
    archived: false,
    body: null,
    clause: null,
    createdByUserId: HEIDI,
    id: "reference-3",
    kind: "LINK",
    label: "Fire safety guidance",
    url: "https://example.org/guidance/fire-safety",
  },
];

const docsContacts = (): ContactBlock[] => [
  {
    archived: false,
    department: "IT",
    email: "it-service-desk@example.org",
    hours: "Mon-Fri 8:00-18:00",
    id: "contact-block-1",
    label: "IT Service Desk",
    name: null,
    notes: "Report lost devices and suspected phishing here first.",
    phone: "+1 555 0100",
    role: null,
  },
  {
    archived: false,
    department: "Legal and Privacy",
    email: "privacy@example.org",
    hours: "Mon-Fri 9:00-17:00",
    id: "contact-block-2",
    label: "Privacy Officer",
    name: "Dave Officer",
    notes: null,
    phone: "+1 555 0142",
    role: "Privacy Officer",
  },
  {
    archived: false,
    department: "Finance",
    email: "expenses@example.org",
    hours: "Mon-Fri 9:00-17:00",
    id: "contact-block-3",
    label: "Expenses team",
    name: null,
    notes: null,
    phone: null,
    role: null,
  },
];

const at = (day: string, time = "09:00:00") => `${day}T${time}Z`;

interface Doc {
  policy: Policy;
  versions: PolicyVersion[];
}

const docs = (): Doc[] => {
  const standard = "template-version-1";
  const procedure = "template-version-2";
  const std = { templateId: "template-1", templateNone: false } as const;
  const prc = {
    documentType: "PROCEDURE",
    templateId: "template-2",
    templateNone: false,
  } as const;
  return [
    {
      policy: policy({
        ...std,
        ackTriggers: "ON_PUBLISH",
        createdAt: at("2025-09-01"),
        currentDraftVersionId: "version-4",
        currentPublishedVersionId: "version-3",
        homeCategoryId: "category-expenses",
        id: "policy-1",
        number: "POL-EXPENSES-000001",
        ownerUserId: BOB,
        title: "Expense Claims Policy",
        updatedAt: at("2026-11-03"),
      }),
      versions: [
        version({
          contentJson: prose.expenseClaims.v1,
          createdAt: at("2025-09-01"),
          id: "version-1",
          policyId: "policy-1",
          publishedAt: at("2025-09-15"),
          status: "SUPERSEDED",
          templateVersionId: standard,
          versionNo: 1,
        }),
        version({
          contentJson: prose.expenseClaims.v2,
          createdAt: at("2026-02-02"),
          id: "version-2",
          policyId: "policy-1",
          publishedAt: at("2026-02-20"),
          status: "SUPERSEDED",
          templateVersionId: standard,
          versionNo: 2,
        }),
        version({
          contentJson: prose.expenseClaims.v3,
          createdAt: at("2026-07-27"),
          id: "version-3",
          policyId: "policy-1",
          publishedAt: at("2026-08-12"),
          status: "PUBLISHED",
          templateVersionId: standard,
          versionNo: 3,
        }),
        version({
          contentJson: prose.expenseClaims.revision,
          createdAt: at("2026-11-03"),
          id: "version-4",
          policyId: "policy-1",
          status: "DRAFT",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-04-14"),
        currentDraftVersionId: "version-6",
        currentPublishedVersionId: "version-5",
        homeCategoryId: "category-records",
        id: "policy-2",
        number: "POL-RECORDS-000001",
        ownerUserId: BOB,
        title: "Records Retention Policy",
        updatedAt: at("2026-11-05"),
      }),
      versions: [
        version({
          contentJson: prose.recordsRetention,
          createdAt: at("2026-04-14"),
          id: "version-5",
          policyId: "policy-2",
          publishedAt: at("2026-05-05"),
          status: "PUBLISHED",
          templateVersionId: standard,
          versionNo: 1,
        }),
        version({
          contentJson: prose.recordsRetention,
          createdAt: at("2026-11-05"),
          id: "version-6",
          policyId: "policy-2",
          status: "DRAFT",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...prc,
        ackTriggers: "NONE",
        createdAt: at("2026-05-18"),
        currentPublishedVersionId: "version-7",
        homeCategoryId: "category-travel",
        id: "policy-3",
        number: "PRC-TRAVEL-000001",
        ownerUserId: BOB,
        title: "Travel Booking Procedure",
        updatedAt: at("2026-06-10"),
      }),
      versions: [
        version({
          contentJson: prose.travelBooking,
          createdAt: at("2026-05-18"),
          id: "version-7",
          policyId: "policy-3",
          publishedAt: at("2026-06-10"),
          status: "PUBLISHED",
          templateVersionId: procedure,
          versionNo: 1,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "ON_PUBLISH",
        createdAt: at("2026-09-14"),
        currentPublishedVersionId: "version-8",
        homeCategoryId: "category-facilities",
        id: "policy-4",
        number: "POL-FACILITIES-000001",
        ownerUserId: BOB,
        title: "Visitor Access Policy",
        updatedAt: at("2026-10-02"),
      }),
      versions: [
        version({
          contentJson: prose.visitorAccess,
          createdAt: at("2026-09-14"),
          id: "version-8",
          policyId: "policy-4",
          publishedAt: at("2026-10-02"),
          status: "PUBLISHED",
          templateVersionId: standard,
          versionNo: 1,
        }),
      ],
    },
    {
      policy: policy({
        ...prc,
        ackTriggers: "NONE",
        createdAt: at("2026-03-09"),
        currentPublishedVersionId: "version-9",
        homeCategoryId: "category-incident-response",
        id: "policy-5",
        number: "PRC-INCIDENT-000001",
        ownerUserId: BOB,
        sensitivity: "SENSITIVE",
        title: "Incident Response Procedure",
        updatedAt: at("2026-04-01"),
      }),
      versions: [
        version({
          contentJson: prose.incidentResponse,
          createdAt: at("2026-03-09"),
          id: "version-9",
          policyId: "policy-5",
          publishedAt: at("2026-04-01"),
          status: "PUBLISHED",
          templateVersionId: procedure,
          versionNo: 1,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-10-19"),
        currentDraftVersionId: "version-10",
        homeCategoryId: "category-security",
        id: "policy-6",
        number: "POL-SECURITY-000001",
        ownerUserId: BOB,
        title: "Information Security Policy",
        updatedAt: at("2026-11-04", "15:30:00"),
        workflowDefId: "workflow-3",
      }),
      versions: [
        version({
          contentJson: prose.informationSecurity,
          createdAt: at("2026-10-19"),
          id: "version-10",
          policyId: "policy-6",
          status: "IN_REVIEW",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-10-21"),
        currentDraftVersionId: "version-11",
        homeCategoryId: "category-security",
        id: "policy-7",
        number: "POL-SECURITY-000002",
        ownerUserId: BOB,
        title: "Acceptable Use Policy",
        updatedAt: at("2026-11-06", "10:15:00"),
        workflowDefId: "workflow-1",
      }),
      versions: [
        version({
          contentJson: prose.acceptableUse.current,
          createdAt: at("2026-10-21"),
          id: "version-11",
          policyId: "policy-7",
          status: "IN_REVIEW",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-10-26"),
        currentDraftVersionId: "version-12",
        homeCategoryId: "category-people",
        id: "policy-8",
        number: "POL-PEOPLE-000001",
        ownerUserId: BOB,
        title: "Remote Working Policy",
        updatedAt: at("2026-11-06", "16:40:00"),
        workflowDefId: "workflow-2",
      }),
      versions: [
        version({
          contentJson: prose.remoteWorking,
          createdAt: at("2026-10-26"),
          id: "version-12",
          policyId: "policy-8",
          status: "IN_REVIEW",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...prc,
        ackTriggers: "NONE",
        createdAt: at("2026-10-28"),
        currentDraftVersionId: "version-13",
        homeCategoryId: "category-purchasing",
        id: "policy-9",
        number: "PRC-PURCHASING-000001",
        ownerUserId: BOB,
        title: "Supplier Onboarding Procedure",
        updatedAt: at("2026-11-05", "11:20:00"),
        workflowDefId: "workflow-4",
      }),
      versions: [
        version({
          contentJson: prose.supplierOnboarding,
          createdAt: at("2026-10-28"),
          id: "version-13",
          policyId: "policy-9",
          status: "IN_REVIEW",
          templateVersionId: procedure,
        }),
      ],
    },
    {
      policy: policy({
        ...prc,
        ackTriggers: "NONE",
        createdAt: at("2026-10-12"),
        currentDraftVersionId: "version-14",
        homeCategoryId: "category-conduct",
        id: "policy-10",
        number: "PRC-CONDUCT-000001",
        ownerUserId: BOB,
        title: "Gifts and Hospitality Procedure",
        updatedAt: at("2026-11-02", "14:05:00"),
        workflowDefId: "workflow-1",
      }),
      versions: [
        version({
          contentJson: prose.giftsAndHospitality,
          createdAt: at("2026-10-12"),
          id: "version-14",
          policyId: "policy-10",
          status: "REJECTED",
          templateVersionId: procedure,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-11-04"),
        currentDraftVersionId: "version-15",
        homeCategoryId: "category-purchasing",
        id: "policy-11",
        number: "POL-PURCHASING-000001",
        ownerUserId: BOB,
        title: "Supplier Management Policy",
        updatedAt: at("2026-11-06", "09:30:00"),
      }),
      versions: [
        version({
          contentJson: prose.supplierManagement,
          createdAt: at("2026-11-04"),
          id: "version-15",
          policyId: "policy-11",
          status: "DRAFT",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-11-07"),
        currentDraftVersionId: "version-16",
        homeCategoryId: "category-facilities",
        id: "policy-12",
        number: "POL-FACILITIES-000002",
        ownerUserId: BOB,
        title: "Clear Desk Policy",
        updatedAt: at("2026-11-07", "13:10:00"),
      }),
      versions: [
        version({
          contentJson: prose.clearDesk,
          createdAt: at("2026-11-07"),
          id: "version-16",
          policyId: "policy-12",
          status: "DRAFT",
          templateVersionId: standard,
        }),
      ],
    },
    {
      policy: policy({
        ...std,
        ackTriggers: "NONE",
        createdAt: at("2026-11-02"),
        currentDraftVersionId: "version-17",
        homeCategoryId: "category-records",
        id: "policy-13",
        number: "POL-RECORDS-000002",
        ownerUserId: BOB,
        title: "Data Classification Policy",
        updatedAt: at("2026-11-08", "08:50:00"),
      }),
      versions: [
        version({
          contentJson: prose.dataClassification,
          createdAt: at("2026-11-02"),
          id: "version-17",
          policyId: "policy-13",
          status: "DRAFT",
          templateVersionId: standard,
        }),
      ],
    },
  ];
};

const approved = (
  taskId: string,
  userId: string,
  day: string,
  comment = "Approved.",
) =>
  seat(taskId, userId, { at: at(day, "10:00:00"), comment, state: "approved" });

/** The approval runs: the published versions' (all approved) and the ones still open. */
const docsRuns = (): Run[] => {
  const published = (
    id: string,
    policyId: string,
    versionId: string,
    day: string,
    task: string,
    approver = CHARLIE,
  ): Run => ({
    currentStageIdx: 0,
    id,
    policyId,
    policyVersionId: versionId,
    stages: [
      {
        name: "Approval",
        quorum: "one",
        seats: [approved(task, approver, day)],
      },
    ],
    status: "APPROVAL_STATUS_PUBLISHED",
    submittedAt: at(day, "08:00:00"),
    submittedBy: BOB,
    workflowDefId: "workflow-1",
  });
  return [
    published("run-1", "policy-1", "version-1", "2025-09-12", "task-1"),
    published("run-2", "policy-1", "version-2", "2026-02-18", "task-2"),
    published("run-3", "policy-1", "version-3", "2026-08-10", "task-3"),
    published("run-4", "policy-2", "version-5", "2026-05-04", "task-4"),
    published("run-5", "policy-3", "version-7", "2026-06-09", "task-5"),
    published("run-6", "policy-4", "version-8", "2026-09-30", "task-6"),
    published("run-7", "policy-5", "version-9", "2026-03-30", "task-7"),
    // Remote Working: stage 1 of 2, Charlie has not decided.
    {
      currentStageIdx: 0,
      id: "run-8",
      policyId: "policy-8",
      policyVersionId: "version-12",
      stages: [
        {
          name: "Line review",
          quorum: "one",
          seats: [seat("task-8", CHARLIE)],
        },
        {
          name: "Final sign-off",
          quorum: "one",
          seats: [seat("task-9", ALICE)],
        },
      ],
      status: "APPROVAL_STATUS_IN_REVIEW",
      submittedAt: at("2026-11-06", "16:40:00"),
      submittedBy: BOB,
      workflowDefId: "workflow-2",
    },
    // Acceptable Use: one approver, Charlie, who looked at it before Bob's later edit.
    {
      currentStageIdx: 0,
      id: "run-9",
      policyId: "policy-7",
      policyVersionId: "version-11",
      stages: [
        { name: "Approval", quorum: "one", seats: [seat("task-10", CHARLIE)] },
      ],
      status: "APPROVAL_STATUS_IN_REVIEW",
      submittedAt: at("2026-11-04", "09:00:00"),
      submittedBy: BOB,
      workflowDefId: "workflow-1",
    },
    // Information Security: Charlie approved; two of the committee of three are still to decide.
    {
      currentStageIdx: 0,
      id: "run-10",
      policyId: "policy-6",
      policyVersionId: "version-10",
      stages: [
        {
          name: "Committee review",
          quorum: "majority",
          seats: [
            seat("task-11", CHARLIE, {
              at: at("2026-11-04", "15:30:00"),
              comment: "Approved, with the suggestions in the text.",
              state: "approved",
            }),
            seat("task-12", ALICE),
            seat("task-13", DAVE),
          ],
          vetoUserIds: [DAVE],
        },
        { name: "Sign-off", quorum: "one", seats: [seat("task-14", ALICE)] },
      ],
      status: "APPROVAL_STATUS_IN_REVIEW",
      submittedAt: at("2026-11-03", "09:00:00"),
      submittedBy: BOB,
      workflowDefId: "workflow-3",
    },
    // Supplier Onboarding: four stages, at the first; Charlie's seat is on the third.
    {
      currentStageIdx: 0,
      id: "run-11",
      policyId: "policy-9",
      policyVersionId: "version-13",
      stages: [
        {
          name: "Line manager",
          quorum: "one",
          seats: [seat("task-15", HEIDI)],
        },
        { name: "Privacy", quorum: "one", seats: [seat("task-16", DAVE)] },
        {
          name: "Security and finance",
          quorum: "all",
          seats: [seat("task-17", CHARLIE), seat("task-18", FRANK)],
        },
        {
          name: "Executive sign-off",
          quorum: "one",
          seats: [seat("task-19", ALICE)],
        },
      ],
      status: "APPROVAL_STATUS_IN_REVIEW",
      submittedAt: at("2026-11-05", "11:20:00"),
      submittedBy: BOB,
      workflowDefId: "workflow-4",
    },
    // Gifts and Hospitality: rejected, with Charlie's reason.
    {
      currentStageIdx: 0,
      id: "run-12",
      policyId: "policy-10",
      policyVersionId: "version-14",
      stages: [
        {
          name: "Approval",
          quorum: "one",
          seats: [
            seat("task-20", CHARLIE, {
              at: at("2026-11-02", "14:05:00"),
              comment:
                "The thresholds are not clear enough to apply. Please define the value bands and who approves each, then resubmit.",
              state: "rejected",
            }),
          ],
        },
      ],
      status: "APPROVAL_STATUS_REJECTED",
      submittedAt: at("2026-10-30", "09:00:00"),
      submittedBy: BOB,
      workflowDefId: "workflow-1",
    },
  ];
};

const thread = (
  given: Partial<ReviewThread> &
    Pick<ReviewThread, "id" | "policyVersionId" | "quote">,
): ReviewThread => ({
  approverUserId: CHARLIE,
  createdAt: at("2026-11-04", "11:00:00"),
  messages: [],
  occurrence: 1,
  resolved: false,
  suggestion: null,
  ...given,
});

/** Charlie's comments on the Information Security Policy: open, countered, agreed, and a question. */
const docsThreads = (): ReviewThread[] => [
  thread({
    id: "thread-docs-1",
    messages: [
      {
        authorUserId: CHARLIE,
        body: "Twelve is too short for shared systems.",
        createdAt: at("2026-11-04", "11:00:00"),
        id: "message-docs-1",
      },
    ],
    policyVersionId: "version-10",
    quote: "Passwords must be at least 12 characters long.",
    suggestion: {
      closedBy: null,
      closedText: null,
      outcome: null,
      reason: null,
      rounds: [
        {
          by: "REVIEWER",
          createdAt: at("2026-11-04", "11:00:00"),
          text: "Passwords must be at least 14 characters long and are never reused across systems.",
          userId: CHARLIE,
        },
      ],
      text: "Passwords must be at least 14 characters long and are never reused across systems.",
      turn: "AUTHOR",
    },
  }),
  thread({
    createdAt: at("2026-11-04", "11:20:00"),
    id: "thread-docs-2",
    messages: [
      {
        authorUserId: CHARLIE,
        body: "Say when the laptops are encrypted.",
        createdAt: at("2026-11-04", "11:20:00"),
        id: "message-docs-2",
      },
    ],
    policyVersionId: "version-10",
    quote: "Laptops are encrypted by the IT team.",
    suggestion: {
      closedBy: null,
      closedText: null,
      outcome: null,
      reason: null,
      rounds: [
        {
          by: "REVIEWER",
          createdAt: at("2026-11-04", "11:20:00"),
          text: "All laptops are encrypted before they are issued.",
          userId: CHARLIE,
        },
        {
          by: "AUTHOR",
          createdAt: at("2026-11-05", "09:40:00"),
          text: "Laptops are encrypted by the IT team before they are issued.",
          userId: BOB,
        },
      ],
      text: "Laptops are encrypted by the IT team before they are issued.",
      turn: "REVIEWER",
    },
  }),
  thread({
    createdAt: at("2026-11-04", "11:40:00"),
    id: "thread-docs-3",
    messages: [
      {
        authorUserId: CHARLIE,
        body: "Once a year is too slow for admin accounts.",
        createdAt: at("2026-11-04", "11:40:00"),
        id: "message-docs-3",
      },
      {
        authorUserId: BOB,
        body: "Agreed, every six months.",
        createdAt: at("2026-11-05", "10:05:00"),
        id: "message-docs-4",
      },
    ],
    policyVersionId: "version-10",
    quote: "Access reviews happen every year.",
    resolved: true,
    suggestion: {
      closedBy: BOB,
      closedText: "Access reviews happen every six months.",
      outcome: "AGREED",
      reason: null,
      rounds: [
        {
          by: "REVIEWER",
          createdAt: at("2026-11-04", "11:40:00"),
          text: "Access reviews happen every six months.",
          userId: CHARLIE,
        },
      ],
      text: "Access reviews happen every six months.",
      turn: "REVIEWER",
    },
  }),
  thread({
    createdAt: at("2026-11-04", "12:00:00"),
    id: "thread-docs-4",
    messages: [
      {
        authorUserId: CHARLIE,
        body: "Does this cover contractors who bring their own devices?",
        createdAt: at("2026-11-04", "12:00:00"),
        id: "message-docs-5",
      },
    ],
    policyVersionId: "version-10",
    quote: "Third-party suppliers follow the same rules.",
  }),
];

const row = (
  appendixId: string,
  versionNo: number,
  state: "DRAFT" | "PUBLISHED",
  title: string,
  contentJson: string,
  day: string,
  editors: string[],
  publishedBy: null | string = null,
) => ({
  contentJson,
  createdAt: at(day),
  createdBy: editors[0] ?? BOB,
  editors,
  id: `${appendixId}-v${String(versionNo)}`,
  publishedAt: state === "PUBLISHED" ? at(day, "12:00:00") : null,
  publishedBy:
    state === "PUBLISHED" ? (publishedBy ?? editors.at(-1) ?? BOB) : null,
  state,
  title,
  updatedAt: at(day, "12:00:00"),
  updatedBy: editors.at(-1) ?? BOB,
  versionNo: state === "DRAFT" ? 0 : versionNo,
});

/**
 * The Expense Claims Policy's three appendices: A has two published versions and a newer draft,
 * B was never published, C is retired.
 */
const docsAppendices = (): PolicyAppendix[] => [
  {
    createdAt: at("2025-09-01"),
    createdBy: BOB,
    id: "appendix-1",
    orderIndex: 0,
    policyId: "policy-1",
    retiredAt: null,
    retiredBy: null,
    versions: [
      row(
        "appendix-1",
        1,
        "PUBLISHED",
        "Mileage and subsistence rates",
        prose.expenseAppendixA.v1,
        "2025-09-15",
        [BOB],
      ),
      row(
        "appendix-1",
        2,
        "PUBLISHED",
        "Mileage and subsistence rates",
        prose.expenseAppendixA.v2,
        "2026-08-12",
        [BOB, CHARLIE],
        CHARLIE,
      ),
      row(
        "appendix-1",
        3,
        "DRAFT",
        "Mileage and subsistence rates",
        prose.expenseAppendixA.draft,
        "2026-11-03",
        [BOB],
      ),
    ],
  },
  {
    createdAt: at("2026-11-03"),
    createdBy: BOB,
    id: "appendix-2",
    orderIndex: 1,
    policyId: "policy-1",
    retiredAt: null,
    retiredBy: null,
    versions: [
      row(
        "appendix-2",
        1,
        "DRAFT",
        "Claim checklist",
        prose.expenseAppendixB,
        "2026-11-03",
        [BOB],
      ),
    ],
  },
  {
    createdAt: at("2025-09-01"),
    createdBy: BOB,
    id: "appendix-3",
    orderIndex: 2,
    policyId: "policy-1",
    retiredAt: at("2026-08-12"),
    retiredBy: ALICE,
    versions: [
      row(
        "appendix-3",
        1,
        "PUBLISHED",
        "Superseded rates (2025)",
        prose.expenseAppendixC,
        "2025-09-15",
        [BOB],
      ),
    ],
  },
];

/** What the Records Retention Policy, and the Expenses revision, link to from the libraries. */
const docsLinks = (): Record<string, VersionLinks> => {
  const records: VersionLinks = {
    contactBlockIds: ["contact-block-2"],
    definitionIds: ["definition-1", "definition-2"],
    referenceIds: ["reference-1", "reference-2"],
    related: [{ policyId: "policy-4", type: "RELATED_TO" }],
  };
  const expenses: VersionLinks = {
    contactBlockIds: ["contact-block-3"],
    definitionIds: ["definition-5"],
    referenceIds: [],
    related: [{ policyId: "policy-3", type: "RELATED_TO" }],
  };
  return {
    "version-3": expenses,
    "version-4": expenses,
    "version-5": records,
    "version-6": records,
  };
};

/** Everyone in the all-staff audience except Erin acknowledged the Visitor Access Policy. */
const docsAcknowledgements = (): StewardData["acknowledgements"] => [
  ...[ALICE, BOB, CHARLIE, DAVE, FRANK, HEIDI, "user-grace"].map((userId) => ({
    ackedAt: at("2026-10-05", "09:30:00"),
    policyVersionId: "version-8",
    userId,
  })),
  // Erin acknowledged the Expense Claims Policy but has not yet read the Visitor Access Policy.
  ...[ALICE, BOB, CHARLIE, DAVE, FRANK, HEIDI, "user-grace", "user-erin"].map(
    (userId) => ({
      ackedAt: at("2026-08-18", "11:00:00"),
      policyVersionId: "version-3",
      userId,
    }),
  ),
];

/** The docs start state. */
export const docsSeed = (): StewardData => {
  const base = demoSeed();
  const versions = docs().flatMap((doc) => doc.versions);
  const appendices = docsAppendices();
  for (const doc of docs()) syncAppendices(appendices, versions, doc.policy.id);
  return {
    ...base,
    acknowledgements: docsAcknowledgements(),
    aiLimitReached: false,
    aiMonthlyLimit: 0,
    aiProviderOutage: null,
    aiSimulated: true,
    appendices,
    assets: base.assets,
    audit: [],
    categories: docsCategories(),
    contactBlocks: docsContacts(),
    definitions: docsDefinitions(),
    links: docsLinks(),
    next: {},
    pastSessions: [],
    people: docsPeople(),
    policies: docs().map((doc) => doc.policy),
    policyViews: [],
    references: docsReferences(),
    reviewSnapshots: {
      "version-11": {
        [CHARLIE]: {
          at: at("2026-11-04", "09:30:00"),
          contentJson: prose.acceptableUse.seen,
        },
      },
    },
    reviewThreads: docsThreads(),
    runs: docsRuns(),
    templateVersions: docsTemplateVersions(),
    versions,
    workflowDefs: docsWorkflows(),
  };
};
