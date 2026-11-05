// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The people who can sign in, one per Steward role, and what the admin directory knows about
// them beyond the core's sign-in fields. Every address is example.org, which never delivers mail.
// Their roles and groups are the owner's to edit on /_mock (src/product/groups.ts reads them).

import type { Person } from "#core/state.ts";

export interface Membership {
  groupId: string;
  /** "manual" when an admin added it, "idp-sync" when the identity provider's groups did. */
  source: string;
}

/** One registered passkey, as identity's webauthn_credentials row keeps it. */
export interface Passkey {
  /** RFC 3339. */
  createdAt: string;
  /** The base64url credential id the authenticator gave it. */
  id: string;
  label: null | string;
  lastUsedAt: null | string;
  transports: string[];
}

/** A per-person exception to the rules for one policy, as identity keeps it. */
export interface PolicyOverride {
  effect: "ALLOW" | "DENY";
  policyNumber: string;
}

/** A person as Steward's directory keeps them: the core's sign-in fields and the User type's. */
export interface StewardPerson extends Person {
  deletedAt: null | string;
  /**
   * Has no second factor yet but must enrol one before signing in: the gateway answers the
   * password with enrollmentRequired, and enrolling turns secondFactor on.
   */
  enrolSecondFactor?: boolean;
  /**
   * Free-text groups, edited on /_mock: the person's IdP groups, their platform-group
   * memberships by name, and "Manages <group>" for a group they manage (src/product/groups.ts).
   */
  groups: string[];
  localAccount: boolean;
  locale: string;
  mergedIntoUserId: null | string;
  /** Owes first-run onboarding (the welcome page) until completeOnboarding; the controls set it. */
  needsOnboarding?: boolean;
  /**
   * Has a passkey (src/product/passkeys.ts): it signs in on its own, and is offered as a second
   * factor beside the authenticator app and the emailed code.
   */
  passkey?: boolean;
  /** When the seeded passkey was registered, and its name; RFC 3339. */
  passkeyCreatedAt?: string;
  passkeyLabel?: null | string;
  /** identity's WebAuthn credentials, oldest first, once a passkey has been read or added. */
  passkeys?: Passkey[];
  policyOverrides: PolicyOverride[];
  /** identity's read-sensitive claim: may read SENSITIVE policies the RACI rules let them read. */
  readSensitive: boolean;
  /** When the authenticator app (secondFactor) was confirmed, and its name; RFC 3339. */
  totpEnrolledAt?: string;
  totpLabel?: null | string;
}

const DIRECTORY_DEFAULTS = {
  deletedAt: null,
  groups: [],
  localAccount: true,
  locale: "en",
  mergedIntoUserId: null,
  policyOverrides: [],
  readSensitive: false,
};

/**
 * A person with the directory's fields: the core adds people of its own (the first-run admin)
 * with only the sign-in fields, so the missing ones are filled in, in place, on first use.
 */
export const asSteward = (person: Person): StewardPerson => {
  for (const [key, value] of Object.entries(DIRECTORY_DEFAULTS))
    if (!(key in person))
      Object.assign(person, { [key]: Array.isArray(value) ? [] : value });
  return person as StewardPerson;
};

const person = (
  given: Partial<StewardPerson> &
    Pick<StewardPerson, "email" | "id" | "name" | "roles" | "username">,
): StewardPerson => ({
  ...DIRECTORY_DEFAULTS,
  groups: [],
  // Every seed person signs in with <username>-password; the Users card on /_mock changes it.
  password: `${given.username}-password`,
  policyOverrides: [],
  secondFactor: false,
  ...given,
});

/**
 * One person per Steward role, Heidi the group manager and Grace the template admin; reader is
 * implicit and never listed, as in steward-authz.
 */
export const people = (): StewardPerson[] => [
  person({
    email: "alice@example.org",
    id: "user-alice",
    name: "Alice Admin",
    roles: ["site-admin", "root"],
    secondFactor: true,
    totpEnrolledAt: "2026-02-10T09:00:00Z",
    totpLabel: "Work phone",
    username: "alice",
  }),
  person({
    email: "bob@example.org",
    groups: ["All staff"],
    id: "user-bob",
    name: "Bob Author",
    readSensitive: true,
    roles: ["author"],
    username: "bob",
  }),
  person({
    email: "charlie@example.org",
    groups: [
      "finance-staff",
      "Finance team",
      "All staff",
      "Manages Finance team",
    ],
    id: "user-charlie",
    localAccount: false,
    name: "Charlie Approver",
    passkey: true,
    passkeyCreatedAt: "2026-06-18T08:15:00Z",
    passkeyLabel: "MacBook Touch ID",
    readSensitive: true,
    roles: ["approver"],
    secondFactor: true,
    totpEnrolledAt: "2026-04-02T14:30:00Z",
    username: "charlie",
  }),
  person({
    email: "dave@example.org",
    enrolSecondFactor: true,
    groups: ["contractors", "Finance team", "Facilities team"],
    id: "user-dave",
    localAccount: false,
    name: "Dave Officer",
    policyOverrides: [{ effect: "DENY", policyNumber: "PRC-DEVICES-000001" }],
    roles: ["privacy-officer", "compliance-admin"],
    username: "dave",
  }),
  person({
    email: "erin@example.org",
    groups: ["All staff", "Facilities team"],
    id: "user-erin",
    name: "Erin Reader",
    policyOverrides: [{ effect: "ALLOW", policyNumber: "POL-RECORDS-000002" }],
    roles: [],
    username: "erin",
  }),
  person({
    disabled: true,
    email: "frank@example.org",
    id: "user-frank",
    name: "Frank Disabled",
    roles: [],
    username: "frank",
  }),
  // The brief's template admin, so the template screens can be walked.
  person({
    email: "grace@example.org",
    groups: ["All staff"],
    id: "user-grace",
    name: "Grace Templates",
    roles: ["template-admin"],
    username: "grace",
  }),
  // The brief's group manager: a password account with no second factor, so My groups (A22)
  // can be walked without SSO.
  person({
    email: "heidi@example.org",
    groups: ["All staff", "Facilities team", "Manages Facilities team"],
    id: "user-heidi",
    name: "Heidi Manager",
    roles: [],
    username: "heidi",
  }),
];
