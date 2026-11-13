// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What the admin console manages beyond people and the library: platform groups, single sign-on
// organisations and their group mappings, the service-provider certificate, settings, past
// sessions and the audit trail. Domains are example.net subdomains; addresses are from the
// documentation ranges.

export interface Announcement {
  enabled: boolean;
  level: string;
  message: string;
}

export interface AuditRecord {
  action: string;
  actorName: null | string;
  actorUserId: string;
  groupId: string;
  groupName: null | string;
  id: string;
  legalBasisExempt: boolean;
  occurredAt: string;
  prevHash: string;
  recordHash: string;
  recordUuid: string;
  subject: string;
  subjectLabel: null | string;
  tier: string;
}

export interface EmailServiceConfig {
  apiKeySet: boolean;
  domain: string;
  enabled: boolean;
  fromAddress: string;
  provider: string;
  region: string;
}

export interface GlobalSettings {
  announcement: Announcement;
  maintenance: { enabled: boolean; message: string };
  workCalendar: SiteWorkCalendar;
}

export interface GroupMapping {
  connectionId: string;
  id: string;
  idpGroupClaimValue: string;
  targetGroupId: string;
}

export interface Organization {
  allowLocal: boolean;
  connectionAlias: string;
  connectionId: string;
  displayName: string;
  domain: string;
  enabled: boolean;
  jitEnabled: boolean;
  orgName: string;
  protocol: string;
  secretReentryRequired: boolean;
  testPassed: boolean;
  verified: boolean;
}

/** A session from before the mock started, as the admin console lists them. */
export interface PastSession {
  active: boolean;
  authenticatedAt: string;
  clientIp: null | string;
  expiresAt: string;
  issuedAt: string;
  lastSeenAt: null | string;
  sessionId: string;
  userAgent: string;
  userId: string;
}

export interface PlatformGroup {
  id: string;
  name: string;
  parentId: null | string;
}

/** The site work calendar (steward-mock-server#227): ISO weekdays, an IANA zone, holidays. */
export interface SiteWorkCalendar {
  holidays: { date: string; label: string }[];
  timezone: string;
  weekdays: number[];
}

export interface SpCertificate {
  active: boolean;
  certPem: string;
  notAfter: string;
  serial: string;
  spMetadataXml: string;
}

export const platformGroups = (): PlatformGroup[] => [
  { id: "group-1", name: "All staff", parentId: null },
  { id: "group-2", name: "Finance team", parentId: "group-1" },
  { id: "group-3", name: "Facilities team", parentId: "group-1" },
  { id: "group-4", name: "Approvers", parentId: "group-1" },
];

const organization = (
  given: Partial<Organization> &
    Pick<Organization, "connectionId" | "domain" | "orgName">,
): Organization => ({
  allowLocal: false,
  connectionAlias: `${given.connectionId}-alias`,
  displayName: given.orgName,
  enabled: false,
  jitEnabled: true,
  protocol: "saml",
  secretReentryRequired: false,
  testPassed: false,
  verified: false,
  ...given,
});

/**
 * One organisation part-way through activation (domain verified, IdP test not passed yet) and
 * one ready to activate, so both sides of the activation gate can be walked through.
 */
export const organizations = (): Organization[] => [
  organization({
    connectionId: "connection-1",
    displayName: "Partner",
    domain: "partner.example.net",
    orgName: "Partner Example",
    verified: true,
  }),
  organization({
    connectionId: "connection-2",
    domain: "branch.example.net",
    orgName: "Branch Example",
    protocol: "oidc",
    testPassed: true,
    verified: true,
  }),
];

export const groupMappings = (): GroupMapping[] => [
  {
    connectionId: "connection-1",
    id: "group-mapping-1",
    idpGroupClaimValue: "finance",
    targetGroupId: "group-2",
  },
];

export const spCertificate = (serial = 1): SpCertificate => ({
  active: true,
  certPem: `-----BEGIN CERTIFICATE-----\nSTEWARD-MOCK-SP-${String(serial)}\n-----END CERTIFICATE-----`,
  notAfter: `${String(2026 + serial)}-12-31T00:00:00Z`,
  serial: `sp-cert-${String(serial)}`,
  spMetadataXml:
    '<EntityDescriptor entityID="https://steward.example.org/auth/saml/metadata"/>',
});

export const globalSettings = (): GlobalSettings => ({
  announcement: { enabled: false, level: "info", message: "" },
  maintenance: { enabled: false, message: "" },
  workCalendar: { holidays: [], timezone: "UTC", weekdays: [1, 2, 3, 4, 5] },
});

export const emailServiceConfig = (): EmailServiceConfig => ({
  apiKeySet: false,
  domain: "",
  enabled: false,
  fromAddress: "",
  provider: "",
  region: "",
});

export const pastSessions = (): PastSession[] => [
  {
    active: true,
    authenticatedAt: "2026-11-04T08:00:00Z",
    clientIp: "192.0.2.42",
    expiresAt: "2026-11-05T08:00:00Z",
    issuedAt: "2026-11-04T08:00:00Z",
    lastSeenAt: "2026-11-04T09:30:00Z",
    sessionId: "session-1",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    userId: "user-bob",
  },
  {
    active: false,
    authenticatedAt: "2026-10-28T07:45:00Z",
    clientIp: "198.51.100.17",
    expiresAt: "2026-10-29T07:45:00Z",
    issuedAt: "2026-10-28T07:45:00Z",
    lastSeenAt: "2026-10-28T16:10:00Z",
    sessionId: "session-2",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    userId: "user-bob",
  },
];

/** A record's hash: not cryptographic, only enough that an edited record breaks the chain. */
export const auditHash = (seed: string): string => {
  let hash = 2_166_136_261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(2);
};

type AuditSeed = Omit<
  AuditRecord,
  "id" | "prevHash" | "recordHash" | "recordUuid"
>;

const auditSeeds: AuditSeed[] = [
  {
    action: "category.created",
    actorName: "Alice Admin",
    actorUserId: "user-alice",
    groupId: "category-finance",
    groupName: "Finance",
    legalBasisExempt: false,
    occurredAt: "2026-01-05T09:00:00Z",
    subject: "category:category-finance",
    subjectLabel: "Finance",
    tier: "audit",
  },
  {
    action: "role.granted",
    actorName: "Alice Admin",
    actorUserId: "user-alice",
    groupId: "category-finance",
    groupName: "Finance",
    legalBasisExempt: false,
    occurredAt: "2026-01-10T14:05:00Z",
    subject: "user:user-bob",
    // Unresolved on purpose: the UI falls back to the raw subject when no label comes back.
    subjectLabel: null,
    tier: "audit",
  },
  {
    action: "user.login.success",
    actorName: "Bob Author",
    actorUserId: "user-bob",
    groupId: "category-finance",
    groupName: "Finance",
    legalBasisExempt: false,
    occurredAt: "2026-01-11T08:00:00Z",
    subject: "user:user-bob",
    subjectLabel: "Bob Author",
    tier: "activity",
  },
  {
    action: "user.disabled",
    actorName: "Alice Admin",
    actorUserId: "user-alice",
    groupId: "category-information",
    groupName: "Information",
    legalBasisExempt: false,
    occurredAt: "2026-02-01T16:45:00Z",
    subject: "user:user-frank",
    subjectLabel: "Frank Disabled",
    tier: "audit",
  },
  {
    action: "policy.created",
    actorName: "Bob Author",
    actorUserId: "user-bob",
    groupId: "category-expenses",
    groupName: "Expenses",
    legalBasisExempt: false,
    occurredAt: "2026-07-29T09:15:00Z",
    subject: "policy:policy-1",
    subjectLabel: "Expense Claims Policy",
    tier: "audit",
  },
  {
    action: "policy.published",
    actorName: "Bob Author",
    actorUserId: "user-bob",
    groupId: "category-expenses",
    groupName: "Expenses",
    legalBasisExempt: false,
    occurredAt: "2026-08-12T00:00:00Z",
    subject: "policy_version:version-2",
    subjectLabel: "Expense Claims Policy",
    tier: "audit",
  },
  {
    action: "workflow.submitted",
    actorName: "Bob Author",
    actorUserId: "user-bob",
    groupId: "category-travel",
    groupName: "Travel",
    legalBasisExempt: false,
    occurredAt: "2026-09-20T00:00:00Z",
    subject: "policy_version:version-4",
    subjectLabel: "Travel Booking Procedure",
    tier: "audit",
  },
  {
    action: "global_settings.updated",
    actorName: "Alice Admin",
    actorUserId: "user-alice",
    groupId: "",
    groupName: null,
    legalBasisExempt: false,
    occurredAt: "2026-10-02T13:00:00Z",
    subject: "settings:global",
    subjectLabel: "Settings",
    tier: "audit",
  },
];

/** Chain a record onto the trail: its id, uuid and hashes follow from the one before it. */
export const chained = (
  trail: readonly AuditRecord[],
  entry: AuditSeed,
): AuditRecord => {
  const index = trail.length + 1;
  const previousHash = trail.at(-1)?.recordHash ?? "0".repeat(16);
  return {
    ...entry,
    id: String(index),
    prevHash: previousHash,
    recordHash: auditHash(`${previousHash}|${entry.action}|${entry.subject}`),
    recordUuid: `audit-record-${String(index)}`,
  };
};

/** The audit trail, oldest first. */
export const auditTrail = (): AuditRecord[] => {
  const trail: AuditRecord[] = [];
  for (const entry of auditSeeds) trail.push(chained(trail, entry));
  return trail;
};
