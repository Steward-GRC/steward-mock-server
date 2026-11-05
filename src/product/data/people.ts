// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The people who can sign in, one per Steward role, and what the admin directory knows about
// them beyond the core's sign-in fields. Every address is example.org, which never delivers mail.

import type { Person } from "#core/state.ts";

export interface Membership {
  groupId: string;
  /** "manual" when an admin added it, "idp-sync" when the identity provider's groups did. */
  source: string;
}

/** A person as Steward's directory keeps them: the core's sign-in fields and the User type's. */
export interface StewardPerson extends Person {
  deletedAt: null | string;
  /**
   * Has no second factor yet but must enrol one before signing in: the gateway answers the
   * password with enrollmentRequired, and enrolling turns secondFactor on.
   */
  enrolSecondFactor?: boolean;
  idpGroups: string[];
  localAccount: boolean;
  locale: string;
  /** Platform groups this person is a local group manager of. */
  managedGroupIds: string[];
  memberships: Membership[];
  mergedIntoUserId: null | string;
  /** Owes first-run onboarding (the welcome page) until completeOnboarding; the controls set it. */
  needsOnboarding?: boolean;
  /**
   * Has a passkey (src/product/passkeys.ts): it signs in on its own, and is offered as a second
   * factor beside the authenticator app and the emailed code.
   */
  passkey?: boolean;
  /** identity's read-sensitive claim: may read SENSITIVE policies the RACI rules let them read. */
  readSensitive: boolean;
}

const DIRECTORY_DEFAULTS = {
  deletedAt: null,
  idpGroups: [],
  localAccount: true,
  locale: "en",
  managedGroupIds: [],
  memberships: [],
  mergedIntoUserId: null,
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
  idpGroups: [],
  managedGroupIds: [],
  memberships: [],
  secondFactor: false,
  ...given,
});

/** One person per Steward role; reader is implicit and never listed, as in steward-authz. */
export const people = (): StewardPerson[] => [
  person({
    email: "alice@example.org",
    id: "user-alice",
    name: "Alice Admin",
    roles: ["site-admin"],
    secondFactor: true,
    username: "alice",
  }),
  person({
    email: "bob@example.org",
    id: "user-bob",
    idpGroups: ["All staff"],
    name: "Bob Author",
    readSensitive: true,
    roles: ["author"],
    username: "bob",
  }),
  person({
    email: "charlie@example.org",
    id: "user-charlie",
    idpGroups: ["finance-staff", "Finance team", "All staff"],
    localAccount: false,
    managedGroupIds: ["group-2"],
    memberships: [{ groupId: "group-2", source: "manual" }],
    name: "Charlie Approver",
    passkey: true,
    readSensitive: true,
    roles: ["approver"],
    secondFactor: true,
    username: "charlie",
  }),
  person({
    email: "dave@example.org",
    enrolSecondFactor: true,
    id: "user-dave",
    idpGroups: ["contractors"],
    localAccount: false,
    memberships: [{ groupId: "group-2", source: "idp-sync" }],
    name: "Dave Officer",
    roles: ["privacy-officer"],
    username: "dave",
  }),
  person({
    email: "erin@example.org",
    id: "user-erin",
    idpGroups: ["All staff", "Facilities team"],
    memberships: [{ groupId: "group-3", source: "manual" }],
    name: "Erin Reader",
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
];
