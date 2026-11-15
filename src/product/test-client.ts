// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The core's test helpers, for Steward: a server serving Steward's product, and sign-in through
// the gateway's routes (/auth/mfa/verify with a kind) rather than the template's.

import type { Product } from "#core/product.ts";

import {
  GOOD_CODE,
  post,
  type Signed,
  startForTests as startCore,
} from "#core/test-client.ts";
import { stewardData } from "#product/data.ts";
import { asSteward } from "#product/data/people.ts";
import { moveRoot } from "#product/groups.ts";
import { steward } from "#product/product.ts";

export {
  control,
  GOOD_CODE,
  headersFor,
  openSocket,
  post,
  query,
  type Signed,
  startFresh,
  WRONG_CODE,
} from "#core/test-client.ts";
export { SETUP_TOKEN } from "#product/routes.ts";

/** Start the mock on a free port serving Steward. */
export const startForTests = (product: Product = steward) => startCore(product);

/**
 * Sign in with a password and, when asked, the TOTP second factor, as steward-web does. The seed
 * gives each person the password `<username>-password`.
 */
export const signIn = async (
  base: string,
  username: string,
  token = false,
  password = `${username}-password`,
): Promise<Signed> => {
  let answer = await post(base, "/auth/login", {
    password,
    token,
    username,
  });
  let body = (await answer.json()) as Record<string, string>;
  if (body.mfaRequired) {
    answer = await post(base, "/auth/mfa/verify", {
      code: GOOD_CODE,
      kind: "totp",
      pendingId: body.pendingId,
      token,
    });
    body = (await answer.json()) as Record<string, string>;
  }
  const cookie =
    (answer.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  return { cookie, csrf: body.csrfToken ?? "", token: body.accessToken };
};

/**
 * Hand the root seat from Alice to Grace, so Alice is a site admin who is not root: she follows
 * the category rules like everyone, and a sensitive policy reaches her obfuscated until she
 * breaks glass. The root account always reads, so these cases need someone else to be root.
 */
export const demoteAlice = (): void => {
  const people = stewardData().people.map((p) => asSteward(p));
  moveRoot(
    people,
    people.find((p) => p.id === "user-grace")!,
  );
};
