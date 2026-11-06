// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The invented data the mock serves, made fresh on every reset. The records live by domain in
// data/*.ts; seed() calls each of them, so a reset never shares an object with the last run.
// The people's shape is the core's: the sign-in routes read it.

import type { ProductData } from "#core/product.ts";
import type { Person } from "#core/state.ts";
import type { MagicLink, PdfJob } from "#product/delivery.ts";

import { mockState } from "#core/state.ts";
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
import {
  type NotificationPrefs,
  notificationPrefs,
} from "#product/data/notifications.ts";
import { people } from "#product/data/people.ts";
import {
  type Acknowledgement,
  acknowledgements,
  links,
  policies,
  type Policy,
  type PolicyLinks,
  type PolicyVersion,
  type PolicyView,
  policyViews,
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

/**
 * The gateway's sign-in switches. `passwordReset` off answers like a gateway without its
 * internal/passwordreset package, the only way the gateway shows no reset: steward-web offers the
 * reset whenever /auth/config answers.
 */
export interface SignInMethods {
  defaultLoginMethod: "local" | "sso";
  passkey: boolean;
  passwordReset: boolean;
  sso: boolean;
}

export interface StewardData extends ProductData {
  acknowledgements: Acknowledgement[];
  /** Whether Ask and the AI health answer from the simulation (the controls switch it). */
  aiSimulated: boolean;
  /** Every question put to Ask, oldest first, behind topPolicyQuestions. */
  askedQuestions: string[];
  audit: AuditRecord[];
  breakGlass: BreakGlassGrant[];
  categories: Category[];
  contactBlocks: ContactBlock[];
  definitions: Definition[];
  emailServiceConfig: EmailServiceConfig;
  groupMappings: GroupMapping[];
  /** Whether the next IdP test passes or fails (the controls set it). */
  idpTestOutcome: "fail" | "pass";
  links: Record<string, PolicyLinks>;
  /** steward-delivery's magic links, by token. */
  magicLinks: Record<string, MagicLink>;
  /** The next number each kind of new record takes, so a new id never repeats a seeded one. */
  next: Record<string, number>;
  /** steward-obligations' saved notification choices, by person id. */
  notificationPrefs: Record<string, NotificationPrefs>;
  organizations: Organization[];
  /** Emails a password reset code was sent to and not used yet. */
  passwordResets: string[];
  pastSessions: PastSession[];
  /** steward-delivery's PDF export jobs, by id. */
  pdfJobs: Record<string, PdfJob>;
  /**
   * identity's factor ceremonies under way: who began an authenticator app enrollment, and each
   * passkey registration's single-use session, by session id, with whose it is.
   */
  pendingFactors: { totp: string[]; webauthn: Record<string, string> };
  /** The core's sign-in records; the directory's fields are filled in by asSteward. */
  people: Person[];
  platformGroups: PlatformGroup[];
  policies: Policy[];
  /** steward-obligations' policy_views: who viewed which version when. */
  policyViews: PolicyView[];
  references: Reference[];
  reportCases: ReportCase[];
  runs: Run[];
  settings: GlobalSettings;
  /** Which sign-in methods the gateway offers (the controls switch them). */
  signInMethods: SignInMethods;
  spCertificate: SpCertificate;
  templates: Template[];
  templateVersions: TemplateVersion[];
  versions: PolicyVersion[];
  workflowDefs: Workflow[];
}

export const seed = (): StewardData => ({
  acknowledgements: acknowledgements(),
  aiSimulated: true,
  askedQuestions: [],
  audit: auditTrail(),
  breakGlass: [],
  categories: categories(),
  contactBlocks: contactBlocks(),
  definitions: definitions(),
  emailServiceConfig: emailServiceConfig(),
  groupMappings: groupMappings(),
  idpTestOutcome: "pass",
  links: links(),
  magicLinks: {},
  next: {},
  notificationPrefs: notificationPrefs(),
  organizations: organizations(),
  passwordResets: [],
  pastSessions: pastSessions(),
  pdfJobs: {},
  pendingFactors: { totp: [], webauthn: {} },
  people: people(),
  platformGroups: platformGroups(),
  policies: policies(),
  policyViews: policyViews(),
  references: references(),
  reportCases: reportCases(),
  runs: runs(),
  settings: globalSettings(),
  signInMethods: {
    defaultLoginMethod: "local",
    passkey: true,
    passwordReset: true,
    sso: true,
  },
  spCertificate: spCertificate(),
  templates: templates(),
  templateVersions: templateVersions(),
  versions: versions(),
  workflowDefs: workflowDefs(),
});

/** The mock's state as Steward's data: the core holds it as its own minimal shape. */
export const stewardData = (): StewardData => mockState.data as StewardData;
