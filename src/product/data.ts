// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The invented data the mock serves, made fresh on every reset. Every address is example.org,
// which never delivers mail. The people's shape is the core's: the sign-in routes read it.
// Steward's records (policies, categories, workflows and the rest) arrive with the resolvers.

import type { Person } from "#core/state.ts";

export interface Announcement {
  enabled: boolean;
  level: string;
  message: string;
}

export interface GlobalSettings {
  announcement: Announcement;
  maintenance: { enabled: boolean; message: string };
}

export interface ProductData {
  people: Person[];
  settings: GlobalSettings;
}

/** One person per Steward role; reader is implicit and never listed, as in steward-authz. */
const people = (): Person[] => [
  {
    email: "demo.admin@example.org",
    id: "user-demo-admin",
    name: "Demo Admin",
    roles: ["site-admin"],
    secondFactor: true,
    username: "demo-admin",
  },
  {
    email: "ada.lovelace@example.org",
    id: "user-alovelace",
    name: "Ada Lovelace",
    roles: ["author"],
    secondFactor: false,
    username: "alovelace",
  },
  {
    email: "grace.hopper@example.org",
    id: "user-ghopper",
    name: "Grace Hopper",
    roles: ["approver"],
    secondFactor: true,
    username: "ghopper",
  },
  {
    email: "margaret.hamilton@example.org",
    enrolSecondFactor: true,
    id: "user-mhamilton",
    name: "Margaret Hamilton",
    roles: ["privacy-officer"],
    secondFactor: false,
    username: "mhamilton",
  },
  {
    email: "katherine.johnson@example.org",
    id: "user-kjohnson",
    name: "Katherine Johnson",
    roles: [],
    secondFactor: false,
    username: "kjohnson",
  },
  {
    disabled: true,
    email: "hedy.lamarr@example.org",
    id: "user-hlamarr",
    name: "Hedy Lamarr",
    roles: [],
    secondFactor: false,
    username: "hlamarr",
  },
];

export const seed = (): ProductData => ({
  people: people(),
  settings: {
    announcement: { enabled: false, level: "info", message: "" },
    maintenance: { enabled: false, message: "" },
  },
});
