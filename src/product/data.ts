// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The invented data the mock serves, made fresh on every reset. The records live by domain in
// data/*.ts; seed() calls each of them, so a reset never shares an object with the last run.
// The people's shape is the core's: the sign-in routes read it.

import type { ProductData } from "#core/product.ts";
import type { Person } from "#core/state.ts";
import type { PolicyAppendix } from "#product/appendices.ts";
import type { AssetSettings, StoredAsset } from "#product/assets.ts";
import type { MagicLink, PdfJob } from "#product/delivery.ts";
import type { ReviewThread } from "#product/resolvers/review-threads.ts";
import type { ReviewSnapshot } from "#product/review-snapshots.ts";

import { mockState } from "#core/state.ts";
import { migrateAppendices } from "#product/appendices.ts";
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
  extraPolicies,
  extraRuns,
  extraThreads,
  extraVersions,
  extraWorkflows,
} from "#product/data/extras.ts";
import { seedAssets } from "#product/data/files.ts";
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
import { duplicatePeople, people } from "#product/data/people.ts";
import {
  type Acknowledgement,
  acknowledgements,
  links,
  policies,
  type Policy,
  type PolicyVersion,
  type PolicyView,
  policyViews,
  type Run,
  runs,
  versions,
} from "#product/data/policies.ts";
import { migrateLinks, type VersionLinks } from "#product/links.ts";

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
  /** The appendices of policies and procedures, each with its own version table. */
  appendices: PolicyAppendix[];
  /** Every question put to Ask, oldest first, behind topPolicyQuestions. */
  askedQuestions: string[];
  /** The editor images' metadata by id (src/product/assets.ts keeps the bytes). */
  assets: Record<string, StoredAsset>;
  /** The /_mock switches for image uploads. */
  assetSettings: AssetSettings;
  audit: AuditRecord[];
  breakGlass: BreakGlassGrant[];
  categories: Category[];
  /** A draft's last co-editing checkpoint: its Yjs state (base64), which starts the next room. */
  collabStates: Record<string, string>;
  contactBlocks: ContactBlock[];
  definitions: Definition[];
  emailServiceConfig: EmailServiceConfig;
  groupMappings: GroupMapping[];
  /** Whether the next IdP test passes or fails (the controls set it). */
  idpTestOutcome: "fail" | "pass";
  /** What each policy version links to in the libraries, by version id. */
  links: Record<string, VersionLinks>;
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
  /** The text each approver last reviewed, by version and then by approver. */
  reviewSnapshots: Record<string, Record<string, ReviewSnapshot>>;
  /** Inline review comment threads on policy versions (ahead of the gateway; see the pending schema). */
  reviewThreads: ReviewThread[];
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

export const seed = (): StewardData => {
  const allVersions = [...versions(), ...extraVersions()];
  const appendices = migrateAppendices(allVersions);
  return {
    acknowledgements: acknowledgements(),
    aiSimulated: true,
    appendices,
    askedQuestions: [],
    assets: seedAssets(),
    assetSettings: { fail: false, limit: "real" },
    audit: auditTrail(),
    breakGlass: [],
    categories: categories(),
    collabStates: {},
    contactBlocks: contactBlocks(),
    definitions: definitions(),
    emailServiceConfig: emailServiceConfig(),
    groupMappings: groupMappings(),
    idpTestOutcome: "pass",
    links: migrateLinks(links(), policies()),
    magicLinks: {},
    next: {},
    notificationPrefs: notificationPrefs(),
    organizations: organizations(),
    passwordResets: [],
    pastSessions: pastSessions(),
    pdfJobs: {},
    pendingFactors: { totp: [], webauthn: {} },
    people: [...people(), ...duplicatePeople()],
    platformGroups: platformGroups(),
    policies: [...policies(), ...extraPolicies()],
    policyViews: policyViews(),
    references: references(),
    reportCases: reportCases(),
    reviewSnapshots: {},
    reviewThreads: extraThreads(),
    runs: [...runs(), ...extraRuns()],
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
    versions: allVersions,
    workflowDefs: [...workflowDefs(), ...extraWorkflows()],
  };
};

/** The mock's state as Steward's data: the core holds it as its own minimal shape. */
export const stewardData = (): StewardData => mockState.data as StewardData;
