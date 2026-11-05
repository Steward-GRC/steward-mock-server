// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The invented data the mock serves, made fresh on every reset. The records live by domain in
// data/*.ts; seed() calls each of them, so a reset never shares an object with the last run.
// The people's shape is the core's: the sign-in routes read it.

import type { Person } from "#core/state.ts";

import {
  type AuditRecord,
  auditTrail,
  type EmailServiceConfig,
  emailServiceConfig,
  type GlobalSettings,
  globalSettings,
  type GroupMapping,
  groupMappings,
  type Organization,
  organizations,
  type PastSession,
  pastSessions,
  type PlatformGroup,
  platformGroups,
  type SpCertificate,
  spCertificate,
} from "#product/data/admin.ts";
import { type ReportCase, reportCases } from "#product/data/cases.ts";
import {
  categories,
  type Category,
  type ContactBlock,
  contactBlocks,
  type Definition,
  definitions,
  type Reference,
  references,
  type Template,
  templates,
  type TemplateVersion,
  templateVersions,
  type Workflow,
  workflowDefs,
} from "#product/data/library.ts";
import { people } from "#product/data/people.ts";
import {
  type Acknowledgement,
  acknowledgements,
  links,
  policies,
  type Policy,
  type PolicyLinks,
  type PolicyVersion,
  type Run,
  runs,
  versions,
} from "#product/data/policies.ts";

export type { Announcement, GlobalSettings } from "#product/data/admin.ts";

/** A break-glass grant: one person may read one sensitive policy's real content until a time. */
export interface BreakGlassGrant {
  policyNumber: string;
  until: number;
  userId: string;
}

export interface ProductData {
  acknowledgements: Acknowledgement[];
  audit: AuditRecord[];
  breakGlass: BreakGlassGrant[];
  categories: Category[];
  contactBlocks: ContactBlock[];
  definitions: Definition[];
  emailServiceConfig: EmailServiceConfig;
  groupMappings: GroupMapping[];
  links: Record<string, PolicyLinks>;
  /** The next number each kind of new record takes, so a new id never repeats a seeded one. */
  next: Record<string, number>;
  organizations: Organization[];
  pastSessions: PastSession[];
  /** The core's sign-in records; the directory's fields are filled in by asSteward. */
  people: Person[];
  platformGroups: PlatformGroup[];
  policies: Policy[];
  references: Reference[];
  reportCases: ReportCase[];
  runs: Run[];
  settings: GlobalSettings;
  spCertificate: SpCertificate;
  templates: Template[];
  templateVersions: TemplateVersion[];
  versions: PolicyVersion[];
  workflowDefs: Workflow[];
}

export const seed = (): ProductData => ({
  acknowledgements: acknowledgements(),
  audit: auditTrail(),
  breakGlass: [],
  categories: categories(),
  contactBlocks: contactBlocks(),
  definitions: definitions(),
  emailServiceConfig: emailServiceConfig(),
  groupMappings: groupMappings(),
  links: links(),
  next: {},
  organizations: organizations(),
  pastSessions: pastSessions(),
  people: people(),
  platformGroups: platformGroups(),
  policies: policies(),
  references: references(),
  reportCases: reportCases(),
  runs: runs(),
  settings: globalSettings(),
  spCertificate: spCertificate(),
  templates: templates(),
  templateVersions: templateVersions(),
  versions: versions(),
  workflowDefs: workflowDefs(),
});
