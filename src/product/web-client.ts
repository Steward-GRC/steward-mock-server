// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What the product's tests share: steward-web's operations as the web sends them, and a client
// that signs a sample person in and calls them by name.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { control, query, type Signed } from "#product/test-client.ts";

const FOLDER = new URL("web-operations/", import.meta.url);

/** Every definition in web-operations/, operations and fragments, by name. */
const definitions = new Map<string, string>();
for (const file of readdirSync(FOLDER).filter((name) =>
  name.endsWith(".graphql"),
)) {
  const text = readFileSync(new URL(file, FOLDER), "utf8");
  const name = /^(?:query|mutation|subscription|fragment)\s+(\w+)/m.exec(
    text,
  )?.[1];
  assert.ok(name, `${file} names no definition`);
  definitions.set(name, text);
}

/** steward-web's operations (not its fragments), by name. */
export const webOperations = [...definitions.keys()].filter(
  (name) => !definitions.get(name)?.trimStart().startsWith("fragment"),
);

/** An operation's text with the fragments it spreads, as codegen sends it. */
export const documentOf = (name: string): string => {
  const text = definitions.get(name);
  assert.ok(text, `steward-web has no operation ${name}`);
  const wanted = new Set<string>();
  const visit = (body: string) => {
    for (const [, spread] of body.matchAll(/\.\.\.(\w+)/g)) {
      if (!spread || wanted.has(spread) || !definitions.has(spread)) continue;
      wanted.add(spread);
      visit(definitions.get(spread) ?? "");
    }
  };
  visit(text);
  return [text, ...[...wanted].map((f) => definitions.get(f))].join("\n");
};

/** A bearer session for a sample person, from the controls (no password or second factor). */
export const signInAs = async (
  base: string,
  personId: string,
): Promise<Signed> => {
  const signed = await control(base, {
    kind: "sign-in",
    personId,
    token: true,
  });
  assert.ok(signed.accessToken, `couldn't sign ${personId} in`);
  return { cookie: "", csrf: "", token: signed.accessToken as string };
};

export interface Answer {
  data: Record<string, unknown>;
  /** The first error's code, when the call was refused. */
  refused?: string;
}

/** Call one of steward-web's operations by name. */
export const call = async (
  base: string,
  signed: Signed,
  name: string,
  variables: Record<string, unknown> = {},
): Promise<Answer> => {
  const { body } = await query(base, documentOf(name), signed, variables);
  return {
    data: body.data ?? {},
    refused: body.errors?.[0]?.extensions.code,
  };
};
