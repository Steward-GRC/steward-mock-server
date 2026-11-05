// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The policy library's structure: the category tree, templates and their versions, the approval
// workflows, and the reusable contact, reference and definition libraries.

export interface Category {
  ackEveryone: boolean;
  ackEveryoneSet: boolean;
  ackTriggers: "NONE" | "ON_CHANGE" | "ON_PUBLISH";
  /** RACI rules: who the category's approve rule names. Descendants inherit them. */
  approverRule: string[];
  /** RACI rules: who the category's author rule names. Descendants inherit them. */
  authorRule: string[];
  defaultTemplateId: null | string;
  defaultTemplateNone: boolean;
  defaultWorkflowId: null | string;
  exclusionGroupIds: null | string[];
  id: string;
  idpGroupIds: null | string[];
  name: string;
  owners: string[];
  parentId: null | string;
  reviewCadence: "ANNUAL" | "BIENNIAL" | "NONE" | "ON_DATE";
  reviewDate: null | string;
  slug: string;
}

export interface ContactBlock {
  archived: boolean;
  department: null | string;
  email: null | string;
  hours: null | string;
  id: string;
  label: string;
  name: null | string;
  notes: null | string;
  phone: null | string;
  role: null | string;
}

export interface Definition {
  archived: boolean;
  categoryId: string;
  createdByUserId: null | string;
  definition: string;
  id: string;
  term: string;
}

export interface Reference {
  archived: boolean;
  body: null | string;
  clause: null | string;
  createdByUserId: null | string;
  id: string;
  kind: "LINK" | "STANDARD" | "TEXT";
  label: string;
  url: null | string;
}

export interface Section {
  blocks: { contentJson: null | string; type: string }[];
  key: string;
  level: number;
  order: number;
  required: boolean;
  title: string;
}

export interface Template {
  code: string;
  id: string;
  name: string;
  ownerCategoryId: null | string;
  retiredAt: null | string;
}

export interface TemplateVersion {
  id: string;
  sections: Section[];
  /** "draft" until published, then "published". */
  status: string;
  templateId: string;
  versionNo: number;
}

export interface Workflow {
  archived: boolean;
  description: null | string;
  id: string;
  name: string;
  stages: WorkflowStage[];
  version: number;
}

export interface WorkflowStage {
  approvers: string[];
  approversByCategory: { approverIds: string[]; categoryId: string }[];
  groupUnits: {
    groupId: string;
    internalQuorum: string;
    memberUserIds: string[];
  }[];
  id: string;
  name: string;
  pinnedLast: boolean;
  /** one, majority or all of the stage's approvers. */
  quorum: string;
  rejectOnSlaBreach: boolean;
  slaDays: null | number;
}

const category = (
  given: Partial<Category> & Pick<Category, "id" | "name" | "slug">,
): Category => ({
  ackEveryone: false,
  ackEveryoneSet: false,
  ackTriggers: "NONE",
  approverRule: [],
  authorRule: [],
  defaultTemplateId: null,
  defaultTemplateNone: false,
  defaultWorkflowId: null,
  exclusionGroupIds: null,
  idpGroupIds: null,
  owners: [],
  parentId: null,
  reviewCadence: "NONE",
  reviewDate: null,
  ...given,
});

/** Four top-level categories, each with subcategories; IT Security goes three levels deep. */
export const categories = (): Category[] => [
  category({
    ackEveryone: true,
    ackEveryoneSet: true,
    ackTriggers: "ON_PUBLISH",
    approverRule: ["user-ghopper"],
    authorRule: ["user-alovelace"],
    defaultTemplateId: "template-1",
    defaultWorkflowId: "workflow-1",
    id: "category-finance",
    name: "Finance",
    owners: ["user-demo-admin"],
    reviewCadence: "ANNUAL",
    slug: "finance",
  }),
  category({
    defaultWorkflowId: "workflow-1",
    id: "category-reimbursement",
    name: "Reimbursement",
    parentId: "category-finance",
    slug: "reimbursement",
  }),
  category({
    ackTriggers: "ON_CHANGE",
    approverRule: ["user-ghopper"],
    authorRule: ["user-alovelace"],
    defaultWorkflowId: "workflow-1",
    id: "category-hr",
    name: "Human Resources",
    slug: "human-resources",
  }),
  category({
    defaultWorkflowId: "workflow-1",
    id: "category-workplace",
    name: "Workplace",
    parentId: "category-hr",
    slug: "workplace",
  }),
  category({
    defaultWorkflowId: "workflow-1",
    id: "category-ethics",
    name: "Ethics",
    parentId: "category-hr",
    slug: "ethics",
  }),
  category({
    approverRule: ["user-ghopper"],
    authorRule: ["user-alovelace"],
    defaultTemplateId: "template-1",
    defaultWorkflowId: "workflow-1",
    id: "category-itsec",
    idpGroupIds: ["it-security-staff"],
    name: "IT Security",
    owners: ["user-ghopper"],
    reviewCadence: "BIENNIAL",
    slug: "it-security",
  }),
  category({
    defaultWorkflowId: "workflow-1",
    id: "category-usage",
    name: "Usage",
    parentId: "category-itsec",
    slug: "usage",
  }),
  category({
    defaultWorkflowId: "workflow-2",
    id: "category-data-governance",
    name: "Data Governance",
    parentId: "category-itsec",
    slug: "data-governance",
  }),
  category({
    defaultTemplateId: "template-2",
    defaultWorkflowId: "workflow-1",
    id: "category-operations",
    name: "Operations",
    parentId: "category-itsec",
    slug: "operations",
  }),
  category({
    defaultTemplateNone: true,
    exclusionGroupIds: [],
    id: "category-infrastructure",
    name: "Infrastructure",
    parentId: "category-operations",
    slug: "infrastructure",
  }),
  category({
    approverRule: ["user-ghopper"],
    authorRule: ["user-alovelace"],
    id: "category-procurement",
    name: "Procurement",
    slug: "procurement",
  }),
  category({
    id: "category-due-diligence",
    name: "Due Diligence",
    parentId: "category-procurement",
    slug: "due-diligence",
  }),
];

export const templates = (): Template[] => [
  {
    code: "TPL-001",
    id: "template-1",
    name: "Standard policy",
    ownerCategoryId: "category-finance",
    retiredAt: null,
  },
  {
    code: "TPL-002",
    id: "template-2",
    name: "Procedure runbook",
    ownerCategoryId: null,
    retiredAt: null,
  },
  {
    code: "TPL-003",
    id: "template-3",
    name: "Short notice",
    ownerCategoryId: null,
    retiredAt: null,
  },
];

const section = (
  key: string,
  title: string,
  order: number,
  required = true,
): Section => ({ blocks: [], key, level: 1, order, required, title });

export const templateVersions = (): TemplateVersion[] => [
  {
    id: "template-version-1",
    sections: [
      section("purpose", "Purpose", 0),
      section("scope", "Scope", 1),
      section("policy-statement", "Policy statement", 2),
    ],
    status: "published",
    templateId: "template-1",
    versionNo: 1,
  },
  {
    id: "template-version-2",
    sections: [
      section("steps", "Steps", 0),
      section("rollback", "Rollback", 1, false),
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
      section("exceptions", "Exceptions", 3, false),
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

const stage = (
  given: Partial<WorkflowStage> &
    Pick<WorkflowStage, "approvers" | "id" | "name">,
): WorkflowStage => ({
  approversByCategory: [],
  groupUnits: [],
  pinnedLast: false,
  quorum: "one",
  rejectOnSlaBreach: false,
  slaDays: null,
  ...given,
});

export const workflowDefs = (): Workflow[] => [
  {
    archived: false,
    description: "A single named approver signs off.",
    id: "workflow-1",
    name: "Single approver",
    stages: [
      stage({
        approvers: ["user-ghopper"],
        id: "workflow-stage-1",
        name: "Approval",
      }),
    ],
    version: 1,
  },
  {
    archived: false,
    description: "A review board, then a final sign-off.",
    id: "workflow-2",
    name: "Security review board",
    stages: [
      stage({
        approvers: ["user-ghopper", "user-demo-admin"],
        id: "workflow-stage-2",
        name: "Board review",
        quorum: "majority",
        rejectOnSlaBreach: true,
        slaDays: 5,
      }),
      stage({
        approvers: ["user-demo-admin"],
        id: "workflow-stage-3",
        name: "Final sign-off",
        pinnedLast: true,
      }),
    ],
    version: 1,
  },
  {
    archived: false,
    description: "Kept for policies still on the old process.",
    id: "workflow-3",
    name: "Legacy sign-off",
    stages: [
      stage({
        approvers: ["user-demo-admin"],
        id: "workflow-stage-4",
        name: "Sign-off",
      }),
    ],
    version: 2,
  },
];

export const contactBlocks = (): ContactBlock[] => [
  {
    archived: false,
    department: "IT",
    email: "it-service-desk@example.org",
    hours: "Mon-Fri 9-5",
    id: "contact-block-1",
    label: "IT Service Desk",
    name: null,
    notes: null,
    phone: "+1 555-0100",
    role: null,
  },
  {
    archived: true,
    department: null,
    email: "security@example.org",
    hours: null,
    id: "contact-block-2",
    label: "Security Team",
    name: null,
    notes: null,
    phone: null,
    role: null,
  },
  {
    archived: false,
    department: "Finance",
    email: "finance@example.org",
    hours: "Mon-Fri, 9am-5pm",
    id: "contact-block-3",
    label: "Expense queries",
    name: null,
    notes: null,
    phone: null,
    role: "Finance help desk",
  },
];

export const references = (): Reference[] => [
  {
    archived: false,
    body: null,
    clause: "Requirement levels",
    createdByUserId: "user-demo-admin",
    id: "reference-1",
    kind: "STANDARD",
    label: "RFC 2119",
    url: null,
  },
  {
    archived: false,
    body: "Keep records for the longest period any applicable regulator sets.",
    clause: null,
    createdByUserId: "user-demo-admin",
    id: "reference-2",
    kind: "TEXT",
    label: "Retention baseline",
    url: null,
  },
  {
    archived: true,
    body: null,
    clause: null,
    createdByUserId: "user-demo-admin",
    id: "reference-3",
    kind: "LINK",
    label: "Superseded vendor policy",
    url: "https://example.org/legacy-policy",
  },
  {
    archived: false,
    body: null,
    clause: null,
    createdByUserId: "user-alovelace",
    id: "reference-4",
    kind: "LINK",
    label: "Travel booking portal",
    url: "https://travel.example.org",
  },
];

export const definitions = (): Definition[] => [
  {
    archived: false,
    categoryId: "category-itsec",
    createdByUserId: "user-demo-admin",
    definition:
      "The maximum tolerable time to restore a system after an incident.",
    id: "definition-1",
    term: "RTO",
  },
  {
    archived: false,
    categoryId: "category-itsec",
    createdByUserId: "user-demo-admin",
    definition: "The maximum tolerable amount of data loss, measured in time.",
    id: "definition-2",
    term: "RPO",
  },
  {
    archived: true,
    categoryId: "category-itsec",
    createdByUserId: "user-demo-admin",
    definition: 'Superseded by "RTO".',
    id: "definition-3",
    term: "Recovery window",
  },
  {
    archived: false,
    categoryId: "category-finance",
    createdByUserId: "user-alovelace",
    definition:
      "A cost incurred for the organisation's business, not personal use.",
    id: "definition-4",
    term: "Business expense",
  },
];
