// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Several passkeys per person, as steward-identity keeps them: each registration adds a credential
// under the id its authenticator gave it, myWebauthnCredentials lists them oldest first, each can
// be renamed or removed on its own, and any of them signs in. The relying-party id in the
// ceremony options is the configured public host, else the host the request came on.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { passkeyCredentialId } from "#product/passkeys.ts";
import {
  post,
  query,
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});
afterEach(() => {
  delete process.env.MOCK_PUBLIC_URL;
});

const ok = async (
  text: string,
  signed: Signed,
  variables?: Record<string, unknown>,
) => {
  const { body } = await query(base, text, signed, variables);
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data as Record<string, unknown>;
};

const refusal = async (
  text: string,
  signed: Signed,
  variables?: Record<string, unknown>,
) => {
  const { body } = await query(base, text, signed, variables);
  assert.ok(body.errors?.length, "expected a refusal");
  const error = body.errors[0] as {
    extensions?: { code?: string };
    message?: string;
  };
  return { code: error.extensions?.code, message: error.message };
};

const BEGIN = "mutation { webauthnRegisterBegin { optionsJson sessionId } }";
const FINISH = `mutation ($sessionId: ID!, $credentialJson: String!, $label: String) {
  webauthnRegisterFinish(sessionId: $sessionId, credentialJson: $credentialJson, label: $label)
}`;
const MINE =
  "query { myWebauthnCredentials { id label createdAt lastUsedAt transports } }";
const RENAME =
  "mutation ($methodId: ID!, $label: String!) { renameMfaMethod(methodId: $methodId, label: $label) }";
const REMOVE =
  "mutation ($credentialId: ID!) { removeWebauthnCredential(credentialId: $credentialId) }";

interface Options {
  publicKey: {
    excludeCredentials?: { id: string }[];
    rp: { id?: string; name: string };
  };
}

const begin = async (signed: Signed) => {
  const begun = (await ok(BEGIN, signed)).webauthnRegisterBegin as {
    optionsJson: string;
    sessionId: string;
  };
  return {
    options: JSON.parse(begun.optionsJson) as Options,
    sessionId: begun.sessionId,
  };
};

/** A registration of the authenticator credential `id`, as navigator.credentials.create() answers. */
const register = async (signed: Signed, id: string, label?: string) => {
  const { sessionId } = await begin(signed);
  const credentialJson = JSON.stringify({
    id,
    rawId: id,
    response: { transports: ["usb"] },
    type: "public-key",
  });
  return query(base, FINISH, signed, { credentialJson, label, sessionId });
};

const mine = async (signed: Signed) =>
  (await ok(MINE, signed)).myWebauthnCredentials as {
    id: string;
    label: null | string;
    lastUsedAt: null | string;
    transports: string[];
  }[];

const FAULT = {
  code: "INTERNAL",
  message: "Something went wrong on our side. Please try again.",
};

describe("several passkeys", () => {
  it("adds each registration and lists them oldest first", async () => {
    const charlie = await signInAs(base, "user-charlie");
    const added = await register(charlie, "yubikey-1", "YubiKey");
    assert.equal(added.body.errors, undefined);
    await register(charlie, "phone-1");
    const list = await mine(charlie);
    assert.deepEqual(
      list.map(({ id, label }) => ({ id, label })),
      [
        { id: passkeyCredentialId("charlie"), label: "MacBook Touch ID" },
        { id: "yubikey-1", label: "YubiKey" },
        { id: "phone-1", label: null },
      ],
    );
    assert.deepEqual(list[1]?.transports, ["usb"]);
    const factors = (
      await ok("query { myFactors { kind enrolledAt } }", charlie)
    ).myFactors as { enrolledAt: null | string; kind: string }[];
    assert.deepEqual(
      factors.filter((f) => f.kind === "passkey"),
      [{ enrolledAt: "2026-06-18T08:15:00Z", kind: "passkey" }],
    );
  });

  it("refuses a credential already registered and one with no id", async () => {
    const erin = await signInAs(base, "user-erin");
    await register(erin, "key-a");
    const again = await register(erin, "key-a");
    const error = again.body.errors?.[0] as
      | { extensions?: { code?: string }; message?: string }
      | undefined;
    assert.deepEqual(
      { code: error?.extensions?.code, message: error?.message },
      FAULT,
    );
    const { sessionId } = await begin(erin);
    assert.deepEqual(
      await refusal(FINISH, erin, {
        credentialJson: JSON.stringify({ type: "public-key" }),
        sessionId,
      }),
      { code: "InvalidArgument", message: "malformed webauthn credential" },
    );
    assert.equal((await mine(erin)).length, 1);
  });

  it("leaves out the passkeys the person already has", async () => {
    const charlie = await signInAs(base, "user-charlie");
    await register(charlie, "yubikey-1");
    const { options } = await begin(charlie);
    assert.deepEqual(
      options.publicKey.excludeCredentials?.map((c) => c.id),
      [passkeyCredentialId("charlie"), "yubikey-1"],
    );
  });

  it("renames and removes one passkey at a time", async () => {
    const charlie = await signInAs(base, "user-charlie");
    await register(charlie, "yubikey-1", "YubiKey");
    await ok(RENAME, charlie, { label: "Desk key", methodId: "yubikey-1" });
    await ok(REMOVE, charlie, { credentialId: passkeyCredentialId("charlie") });
    assert.deepEqual(
      (await mine(charlie)).map(({ id, label }) => ({ id, label })),
      [{ id: "yubikey-1", label: "Desk key" }],
    );
    assert.deepEqual(
      await refusal(REMOVE, charlie, {
        credentialId: passkeyCredentialId("charlie"),
      }),
      { code: "NotFound", message: "no such credential" },
    );
    await ok(REMOVE, charlie, { credentialId: "yubikey-1" });
    assert.deepEqual(await mine(charlie), []);
    const kinds = (
      (await ok("query { myFactors { kind } }", charlie)).myFactors as {
        kind: string;
      }[]
    ).map((f) => f.kind);
    assert.deepEqual(kinds, ["totp", "email"]);
  });

  it("removes every passkey with removeFactor", async () => {
    const charlie = await signInAs(base, "user-charlie");
    await register(charlie, "yubikey-1");
    await ok('mutation { removeFactor(kind: "passkey") }', charlie);
    assert.deepEqual(await mine(charlie), []);
  });

  it("lists, renames and removes each passkey for an admin", async () => {
    const charlie = await signInAs(base, "user-charlie");
    await register(charlie, "yubikey-1", "YubiKey");
    const alice = await signInAs(base, "user-alice");
    const factors = (
      await ok(
        'query { userFactors(userId: "user-charlie") { id kind label } }',
        alice,
      )
    ).userFactors as { id: string; kind: string; label: null | string }[];
    assert.deepEqual(
      factors.filter((f) => f.kind === "passkey"),
      [
        {
          id: passkeyCredentialId("charlie"),
          kind: "passkey",
          label: "MacBook Touch ID",
        },
        { id: "yubikey-1", kind: "passkey", label: "YubiKey" },
      ],
    );
  });

  it("signs in with a registered passkey and stamps when it was used", async () => {
    const erin = await signInAs(base, "user-erin");
    await register(erin, "erin-key");
    const begun = await post(base, "/auth/passkey/login/begin", {});
    const { flowId } = (await begun.json()) as { flowId: string };
    const finished = await post(base, "/auth/passkey/login/finish", {
      credentialJson: JSON.stringify({ id: "erin-key", type: "public-key" }),
      flowId,
    });
    assert.equal(finished.status, 200);
    const [key] = await mine(erin);
    assert.match(key?.lastUsedAt ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

describe("the relying-party id", () => {
  it("is the host the person signed in on", async () => {
    const erin = await signIn(base, "erin", true);
    const { options } = await begin(erin);
    assert.equal(options.publicKey.rp.id, new URL(base).hostname);
    assert.equal(options.publicKey.rp.name, "Steward");
  });

  it("is the configured public host when there is one", async () => {
    const host = ["steward", "example", "org"].join(".");
    process.env.MOCK_PUBLIC_URL = `https://${host}:8443/`;
    const erin = await signIn(base, "erin", true);
    const { options } = await begin(erin);
    assert.equal(options.publicKey.rp.id, host);
    const begun = await post(base, "/auth/passkey/login/begin", {});
    const { optionsJson } = (await begun.json()) as { optionsJson: string };
    assert.equal(
      (JSON.parse(optionsJson) as { publicKey: { rpId: string } }).publicKey
        .rpId,
      host,
    );
  });

  it("is identity's default for a session with no request behind it", async () => {
    const { options } = await begin(await signInAs(base, "user-erin"));
    assert.equal(options.publicKey.rp.id, "localhost");
  });
});
