// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What Steward gives the template's Users card on /_mock: the roles and groups to pick from, and
// the legend that says what each grants. The roles and their permissions come from ROLE_GRANTS,
// the table the permissions resolvers read, so the legend can't drift from what a role does; the
// groups come from the seeded platform groups. The template only draws these (Product.roleChoices,
// PersonField.choices and Product.legend).

import type { Choice, LegendSection } from "#core/product.ts";

import { platformGroups } from "#product/data/admin.ts";
import { ROOT_ROLE } from "#product/groups.ts";
import { ROLE_GRANTS } from "#product/resolvers/users.ts";

/** What each role is for, beside the permissions it grants. */
const ROLE_USE: Record<string, string> = {
  approver:
    "Approves policy versions in the categories they are an approver for.",
  author: "Writes and edits drafts, and submits them for review.",
  "compliance-admin": "Runs the compliance screens and reads the audit trail.",
  "privacy-officer": "Works the anonymous report cases, the officers' queue.",
  "site-admin":
    "Everything, the admin console included. Sensitive policies stay obfuscated until they break glass.",
  "template-admin": "Manages the templates.",
};

const grantsOf = (role: string) => (ROLE_GRANTS[role] ?? []).join(", ");

/** Steward's roles for the Roles dropdown, then the root marker. */
export const roleChoices: Choice[] = [
  ...Object.keys(ROLE_GRANTS).map((value) => ({
    hint: ROLE_USE[value] ?? "",
    value,
  })),
  {
    hint: "A root admin; identity keeps it beside the roles.",
    value: ROOT_ROLE,
  },
];

/** The platform groups, and a "Manages <group>" for each, for the Groups dropdown. */
export const groupChoices = (): Choice[] =>
  platformGroups().flatMap(({ name }) => [
    { value: name },
    { hint: `Manages the ${name} group`, value: `Manages ${name}` },
  ]);

/** The info box under the Users card's introduction. */
export const legend = (): LegendSection[] => [
  {
    entries: [
      ...Object.keys(ROLE_GRANTS).map((role) => ({
        term: role,
        text: `${ROLE_USE[role] ?? ""} Grants ${grantsOf(role)}.`,
      })),
      {
        term: ROOT_ROLE,
        text: "Makes the person a root admin, the flag identity keeps beside the roles (the User type reports it as isRoot).",
      },
      {
        term: "(no role)",
        text: "A reader: published, non-sensitive policies they are allowed to read (policy.read), whatever their groups.",
      },
    ],
    title: "Roles",
  },
  {
    entries: [
      ...platformGroups().map(({ name, parentId }) => ({
        term: name,
        text: `A platform group${parentId ? ` inside ${platformGroups().find((g) => g.id === parentId)?.name ?? ""}` : ""}. Being in it makes the person a member, and category access rules that name it match them.`,
      })),
      {
        term: "Manages <group>",
        text: "Makes the person that platform group's manager instead of a member (My groups). No group grants a role.",
      },
      {
        term: "Any other group",
        text: "Typed in by hand: an IdP group that category access rules can match, with no platform group behind it.",
      },
    ],
    title: "Groups",
  },
];
