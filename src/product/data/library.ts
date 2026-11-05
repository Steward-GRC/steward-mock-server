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
  /** steward-core's stored number code; a category without one derives it from its slug. */
  code?: string;
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

/**
 * The design brief's four top-level categories, two subcategories each; Devices goes a third level
 * deep. Each carries the stored code its document numbers use, as steward-core keeps one per
 * category, so numbers read POL-FACILITIES-000001 rather than a six-letter cut of the slug.
 */
export const categories = (): Category[] => [
  category({
    ackEveryone: true,
    ackEveryoneSet: true,
    ackTriggers: "ON_PUBLISH",
    approverRule: ["user-charlie"],
    authorRule: ["user-bob"],
    code: "FINANCE",
    defaultTemplateId: "template-1",
    defaultWorkflowId: "workflow-1",
    id: "category-finance",
    name: "Finance",
    owners: ["user-alice"],
    reviewCadence: "ANNUAL",
    slug: "finance",
  }),
  category({
    code: "EXPENSES",
    defaultWorkflowId: "workflow-1",
    id: "category-expenses",
    name: "Expenses",
    parentId: "category-finance",
    slug: "expenses",
  }),
  category({
    code: "PURCHASING",
    defaultWorkflowId: "workflow-1",
    id: "category-purchasing",
    name: "Purchasing",
    parentId: "category-finance",
    slug: "purchasing",
  }),
  category({
    ackTriggers: "ON_CHANGE",
    approverRule: ["user-charlie"],
    authorRule: ["user-bob"],
    code: "PEOPLE",
    defaultWorkflowId: "workflow-1",
    id: "category-people",
    name: "People",
    slug: "people",
  }),
  category({
    code: "LEAVE",
    defaultWorkflowId: "workflow-1",
    id: "category-leave",
    name: "Leave",
    parentId: "category-people",
    slug: "leave",
  }),
  category({
    code: "CONDUCT",
    defaultWorkflowId: "workflow-1",
    id: "category-conduct",
    name: "Conduct",
    parentId: "category-people",
    slug: "conduct",
  }),
  category({
    approverRule: ["user-charlie"],
    authorRule: ["user-bob"],
    code: "INFORMATION",
    defaultTemplateId: "template-1",
    defaultWorkflowId: "workflow-1",
    id: "category-information",
    idpGroupIds: ["information-staff"],
    name: "Information",
    owners: ["user-charlie"],
    reviewCadence: "BIENNIAL",
    slug: "information",
  }),
  category({
    code: "RECORDS",
    defaultWorkflowId: "workflow-1",
    id: "category-records",
    name: "Records",
    parentId: "category-information",
    slug: "records",
  }),
  category({
    code: "DEVICES",
    defaultTemplateId: "template-2",
    defaultWorkflowId: "workflow-1",
    id: "category-devices",
    name: "Devices",
    parentId: "category-information",
    slug: "devices",
  }),
  category({
    code: "PHONES",
    defaultTemplateNone: true,
    exclusionGroupIds: [],
    id: "category-phones",
    name: "Phones",
    parentId: "category-devices",
    slug: "phones",
  }),
  category({
    approverRule: ["user-charlie"],
    authorRule: ["user-bob"],
    code: "WORKPLACE",
    id: "category-workplace",
    name: "Workplace",
    slug: "workplace",
  }),
  category({
    code: "FACILITIES",
    defaultWorkflowId: "workflow-2",
    id: "category-facilities",
    name: "Facilities",
    parentId: "category-workplace",
    slug: "facilities",
  }),
  category({
    code: "TRAVEL",
    id: "category-travel",
    name: "Travel",
    parentId: "category-workplace",
    slug: "travel",
  }),
];

export const templates = (): Template[] => [
  {
    code: "TPL-001",
    id: "template-1",
    name: "Standard Policy",
    ownerCategoryId: "category-finance",
    retiredAt: null,
  },
  {
    code: "TPL-002",
    id: "template-2",
    name: "Step-by-step Procedure",
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
    description: "Finance's approver signs off in one step.",
    id: "workflow-1",
    name: "Finance sign-off",
    stages: [
      stage({
        approvers: ["user-charlie"],
        id: "workflow-stage-1",
        name: "Finance sign-off",
      }),
    ],
    version: 1,
  },
  {
    archived: false,
    description: "A review by the approvers, then a final approval.",
    id: "workflow-2",
    name: "Standard 2-stage",
    stages: [
      stage({
        approvers: ["user-charlie", "user-alice"],
        id: "workflow-stage-2",
        name: "Review",
        quorum: "majority",
        rejectOnSlaBreach: true,
        slaDays: 5,
      }),
      stage({
        approvers: ["user-alice"],
        id: "workflow-stage-3",
        name: "Final approval",
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
        approvers: ["user-alice"],
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
    createdByUserId: "user-alice",
    id: "reference-1",
    kind: "STANDARD",
    label: "RFC 2119",
    url: null,
  },
  {
    archived: false,
    body: "Keep records for the longest period any applicable regulator sets.",
    clause: null,
    createdByUserId: "user-alice",
    id: "reference-2",
    kind: "TEXT",
    label: "Retention baseline",
    url: null,
  },
  {
    archived: true,
    body: null,
    clause: null,
    createdByUserId: "user-alice",
    id: "reference-3",
    kind: "LINK",
    label: "Superseded vendor policy",
    url: "https://example.org/legacy-policy",
  },
  {
    archived: false,
    body: null,
    clause: null,
    createdByUserId: "user-bob",
    id: "reference-4",
    kind: "LINK",
    label: "Travel booking portal",
    url: "https://travel.example.org",
  },
];

export const definitions = (): Definition[] => [
  {
    archived: false,
    categoryId: "category-information",
    createdByUserId: "user-alice",
    definition:
      "The maximum tolerable time to restore a system after an incident.",
    id: "definition-1",
    term: "RTO",
  },
  {
    archived: false,
    categoryId: "category-information",
    createdByUserId: "user-alice",
    definition: "The maximum tolerable amount of data loss, measured in time.",
    id: "definition-2",
    term: "RPO",
  },
  {
    archived: true,
    categoryId: "category-information",
    createdByUserId: "user-alice",
    definition: 'Superseded by "RTO".',
    id: "definition-3",
    term: "Recovery window",
  },
  {
    archived: false,
    categoryId: "category-finance",
    createdByUserId: "user-bob",
    definition:
      "A cost incurred for the organisation's business, not personal use.",
    id: "definition-4",
    term: "Business expense",
  },
];
