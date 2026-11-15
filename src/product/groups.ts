// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Who someone is on the mock comes from its own store of people, which the owner edits on /_mock:
// the template's roles field and Steward's groups field, read on every request and never copied
// into a session.
//
// - Roles are Steward's (site-admin, author, approver, privacy-officer, compliance-admin,
//   template-admin) and decide permissions, as identity's do. "root" among them makes the person a
//   root admin; identity keeps that as a flag beside the roles, so the User type lists it apart.
// - Groups are free text. Each is one of the person's IdP groups, which category access rules
//   match, and a member of the platform group of the same name (case aside). "Manages <group>"
//   makes them that platform group's manager instead: the mock's way to set it, where identity
//   keeps managers apart. No group grants a role, as in the real stack.
//
// An edit on /_mock writes the store as it is; it announces user.permissions_changed on
// liveEvents when it touches someone's groups, roles, password or disabled flag, or adds or
// removes a person, so a signed-in web app refreshes them at once.

import type { Membership, StewardPerson } from "#product/data/people.ts";

import { listen, PEOPLE_CHANGED, type PeopleChange } from "#core/events.ts";
import { stewardData } from "#product/data.ts";
import { announce } from "#product/resolvers/shared.ts";

/** The live event an edit to who someone is or what they may do announces. */
export const PERMISSIONS_CHANGED = "user.permissions_changed";

/** The role that marks a root admin; identity keeps it as a flag, not a role. */
export const ROOT_ROLE = "root";

const MANAGES = /^manages\s+(.+)$/i;

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** The person's groups as the owner set them. */
export const groupsOf = (person: StewardPerson): string[] =>
  person.groups ?? [];

/** The person's IdP groups: every group but the "Manages …" ones. */
export const idpGroupsOf = (person: StewardPerson): string[] =>
  groupsOf(person).filter((g) => !MANAGES.test(g));

const platformGroupsNamed = (names: string[]) =>
  stewardData().platformGroups.filter((g) =>
    names.some((name) => same(name, g.name)),
  );

/** The platform groups the person belongs to: those named among their IdP groups. */
export const membershipsOf = (person: StewardPerson): Membership[] =>
  platformGroupsNamed(idpGroupsOf(person)).map((g) => ({
    groupId: g.id,
    source: "manual",
  }));

/** The platform groups the person manages: those their "Manages <group>" groups name. */
export const managedGroupIdsOf = (person: StewardPerson): string[] =>
  platformGroupsNamed(
    groupsOf(person).flatMap((g) => MANAGES.exec(g)?.[1] ?? []),
  ).map((g) => g.id);

/** Steward's roles, without the root marker. */
export const rolesOf = (person: StewardPerson): string[] =>
  person.roles.filter((role) => role !== ROOT_ROLE);

export const isRoot = (person: StewardPerson): boolean =>
  person.roles.includes(ROOT_ROLE);

/** Join a platform group by its name (Steward's addUserToGroup). */
export const joinGroup = (person: StewardPerson, groupName: string): void => {
  if (!idpGroupsOf(person).some((g) => same(g, groupName)))
    person.groups = [...groupsOf(person), groupName];
};

/** Leave a platform group by its name (Steward's removeUserFromGroup). */
export const leaveGroup = (person: StewardPerson, groupName: string): void => {
  person.groups = groupsOf(person).filter((g) => !same(g, groupName));
};

/**
 * Hand the single root seat to the target (Steward's transferRoot). Every other holder loses the
 * marker and keeps their other roles, so there is never more than one root; the target is enabled
 * and gets site-admin.
 */
export const moveRoot = (
  holders: StewardPerson[],
  target: StewardPerson,
): void => {
  for (const person of holders)
    person.roles = person.roles.filter((role) => role !== ROOT_ROLE);
  target.disabled = false;
  target.roles.push(ROOT_ROLE);
  if (!target.roles.includes("site-admin")) target.roles.push("site-admin");
};

/** The fields whose change alters who someone is or what they may do. */
const WATCHED = new Set(["disabled", "groups", "password", "roles"]);

listen(PEOPLE_CHANGED, (payload) => {
  const { change, fields, personId } = payload as PeopleChange;
  if (change !== "updated" || fields.some((field) => WATCHED.has(field)))
    announce(PERMISSIONS_CHANGED, null, `user:${personId}`);
});
