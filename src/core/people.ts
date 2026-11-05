// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The people who can sign in, managed from the controls: add one, change their details or
// password, or remove them. A change counts from the next sign-in, and a removed person's sessions
// end with them. Passwords go in and never come out: the list says only whether one is set, so a
// dev quick-login widget can read who to offer without seeing anyone's password. A product adds
// fields of its own (Product.personFields), edited the same way and stored on the person.

import { refuse } from "#core/http.ts";
import { type PersonField, product } from "#core/product.ts";
import {
  endSessions,
  mockState,
  type Person,
  personById,
} from "#core/state.ts";

type Body = Record<string, unknown>;

/** A person as the controls and GET /_mock/people show them: everything but the password. */
export const publicPerson = ({ password, ...person }: Person) => ({
  ...person,
  disabled: person.disabled === true,
  hasPassword: password !== "",
});

/** The people who can sign in, without their passwords. */
export const listPeople = (): ReturnType<typeof publicPerson>[] =>
  mockState.data.people.map(publicPerson);

const USERNAME = /^[a-z0-9][a-z0-9._-]*$/;

const roles = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string")
    return value
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);
  return undefined;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() : undefined;

const flag = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** A username from the controls, lower-cased, or a refusal when it's empty, odd or taken. */
const username = (value: unknown, self?: Person): Response | string => {
  const wanted = text(value)?.toLowerCase() ?? "";
  if (!USERNAME.test(wanted))
    return refuse(
      400,
      "invalid_username",
      "A username is letters, digits, dots, dashes and underscores.",
    );
  const taken = mockState.data.people.some(
    (p) => p !== self && (p.username === wanted || p.email === wanted),
  );
  if (taken)
    return refuse(409, "username_taken", `${wanted} is taken already.`);
  return wanted;
};

/** The core's own person fields, which a product field can't take over. */
const CORE_FIELDS = new Set([
  "disabled",
  "email",
  "hasPassword",
  "id",
  "name",
  "password",
  "roles",
  "secondFactor",
  "username",
]);

/** The product's own person fields, without any that would shadow the core's. */
export const personFields = (): PersonField[] =>
  (product().personFields ?? []).filter((field) => !CORE_FIELDS.has(field.key));

/** A product field's value from the controls, or undefined when the body doesn't name it. */
const fieldValue = (field: PersonField, value: unknown): unknown => {
  if (field.kind === "boolean") return flag(value);
  if (field.kind === "list") return roles(value);
  return typeof value === "string" ? value.trim() : undefined;
};

const emptyValue = (field: PersonField): unknown => {
  if (field.kind === "boolean") return false;
  if (field.kind === "list") return [];
  return "";
};

/** Lay the body's product fields on the person; on a new person, fill the rest with empties. */
const applyFields = (person: Person, body: Body, fresh: boolean) => {
  const fields = person as unknown as Record<string, unknown>;
  for (const field of personFields()) {
    const value = fieldValue(field, body[field.key]);
    if (value !== undefined) fields[field.key] = value;
    else if (fresh && fields[field.key] === undefined)
      fields[field.key] = emptyValue(field);
  }
};

const capitalised = (word: string) =>
  word.charAt(0).toUpperCase() + word.slice(1);

/** The person kinds for POST /_mock/controls. */
export const peopleControls: Record<string, (body: Body) => unknown> = {
  /** A new person: a username, and optionally a name, email, roles, password and flags. */
  "person-add": (body) => {
    const name = username(body.username);
    if (name instanceof Response) return name;
    const person: Person = {
      disabled: flag(body.disabled) ?? false,
      email: text(body.email) || `${name}@example.org`,
      id: `person-${name}`,
      name: text(body.name) || capitalised(name),
      password: typeof body.password === "string" ? body.password : "",
      roles: roles(body.roles) ?? [],
      secondFactor: flag(body.secondFactor) ?? false,
      username: name,
    };
    if (personById(person.id))
      person.id = `person-${name}-${String(Date.now())}`;
    applyFields(person, body, true);
    mockState.data.people.push(person);
    return publicPerson(person);
  },
  /** Take a person out, and end every session they have. */
  "person-remove": (body) => {
    const person = personById(String(body.personId ?? ""));
    if (!person) return refuse(404, "unknown_person", "No such person.");
    mockState.data.people = mockState.data.people.filter((p) => p !== person);
    for (const [pending, owner] of mockState.pending)
      if (owner === person.id) mockState.pending.delete(pending);
    endSessions(person.id);
    return { removed: person.id };
  },
  /** Change the fields the body names; a password only when one is given. */
  "person-update": (body) => {
    const person = personById(String(body.personId ?? ""));
    if (!person) return refuse(404, "unknown_person", "No such person.");
    if (body.username !== undefined) {
      const name = username(body.username, person);
      if (name instanceof Response) return name;
      person.username = name;
    }
    person.name = text(body.name) || person.name;
    person.email = text(body.email) || person.email;
    person.roles = roles(body.roles) ?? person.roles;
    person.disabled = flag(body.disabled) ?? person.disabled;
    person.secondFactor = flag(body.secondFactor) ?? person.secondFactor;
    if (typeof body.password === "string" && body.password !== "")
      person.password = body.password;
    applyFields(person, body, false);
    if (person.disabled) endSessions(person.id);
    return publicPerson(person);
  },
};
