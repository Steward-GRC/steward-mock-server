// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The profile pages: the caller's passkeys (identity's ListWebauthnCredentials), signing out
// everywhere (identity's RevokeMySessions), and the notification settings and type catalog
// (steward-obligations' notifprefs service and notifpolicy taxonomy), as steward-gateway answers
// them.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { passkeyCredentialId } from "#product/passkeys.ts";
import {
  GOOD_CODE,
  query,
  type Signed,
  startForTests,
  startFresh,
  WRONG_CODE,
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

const SETTINGS = `
  channels { userId email inApp push }
  categories { category cadence mandatory }
  overrides { kind category cadence mandatory delivery }
  digest { dailyHour weeklyDow }
`;

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

const settingsOf = async (signed: Signed) =>
  (await ok(`query { notificationSettings { ${SETTINGS} } }`, signed))
    .notificationSettings;

const DEFAULT_CATEGORIES = [
  { cadence: "IMMEDIATE", category: "COMPLIANCE", mandatory: true },
  { cadence: "IMMEDIATE", category: "SECURITY", mandatory: true },
  { cadence: "IMMEDIATE", category: "TRANSACTIONAL", mandatory: true },
  { cadence: "IMMEDIATE", category: "WORKFLOW", mandatory: false },
  { cadence: "DAILY", category: "INFORMATIONAL", mandatory: false },
];

const MANDATORY_OFF = {
  code: "NOTIFY_PREF_MANDATORY_OFF",
  message:
    "This category is required for compliance and can't be turned off — choose a digest instead.",
};

const INVALID = {
  code: "NOTIFY_PREF_INVALID",
  message:
    "That notification preference isn't valid — check the value and try again.",
};

describe("myWebauthnCredentials", () => {
  const MINE =
    "query { myWebauthnCredentials { id label createdAt lastUsedAt transports } }";

  it("lists Charlie's MacBook Touch ID passkey", async () => {
    const data = await ok(MINE, await signInAs(base, "user-charlie"));
    assert.deepEqual(data.myWebauthnCredentials, [
      {
        createdAt: "2026-06-18T08:15:00Z",
        id: passkeyCredentialId("charlie"),
        label: "MacBook Touch ID",
        lastUsedAt: null,
        transports: ["internal", "hybrid"],
      },
    ]);
  });

  it("gives someone without a passkey an empty list", async () => {
    const data = await ok(MINE, await signInAs(base, "user-erin"));
    assert.deepEqual(data.myWebauthnCredentials, []);
  });
});

describe("revokeMySessions", () => {
  const SESSIONS = `query ($userId: ID!) { listUserSessions(userId: $userId) { active } }`;

  const activeSessions = async (admin: Signed) => {
    const data = await ok(SESSIONS, admin, { userId: "user-erin" });
    return (data.listUserSessions as { active: boolean }[]).filter(
      (s) => s.active,
    ).length;
  };

  it("ends every one of the caller's sessions and says how many", async () => {
    const admin = await signInAs(base, "user-alice");
    const first = await signInAs(base, "user-erin");
    await signInAs(base, "user-erin");
    const before = await activeSessions(admin);
    assert.ok(before >= 2);

    const data = await ok("mutation { revokeMySessions }", first);
    assert.equal(data.revokeMySessions, before);
    assert.equal(await activeSessions(admin), 0);

    const { body } = await query(
      base,
      "query { myWebauthnCredentials { id } }",
      first,
    );
    assert.ok(body.errors?.length, "the revoked session still works");
  });
});

const row = (
  kind: string,
  category: string,
  mandatory: boolean,
  delivery: string,
) => ({ category, delivery, kind, mandatory });

describe("notificationTypeCatalog", () => {
  it("lists every type obligations classifies, by category then kind", async () => {
    const data = await ok(
      "query { notificationTypeCatalog { kind category mandatory delivery } }",
      await signInAs(base, "user-erin"),
    );
    assert.deepEqual(data.notificationTypeCatalog, [
      row("ack-required", "COMPLIANCE", true, "IMMEDIATE_ONLY"),
      row("policy-ack-reminder", "COMPLIANCE", true, "REMINDER_SCHEDULE"),
      row("policy-escalation", "COMPLIANCE", true, "IMMEDIATE_ONLY"),
      row("review-due", "COMPLIANCE", true, "REMINDER_SCHEDULE"),
      row("break-glass-alert", "SECURITY", true, "IMMEDIATE_ONLY"),
      row("break-glass-read-alert", "SECURITY", true, "IMMEDIATE_ONLY"),
      row("kratos-recovery", "SECURITY", true, "IMMEDIATE_ONLY"),
      row("mfa-setup", "SECURITY", true, "IMMEDIATE_ONLY"),
      row("otp", "SECURITY", true, "IMMEDIATE_ONLY"),
      row("sp-cert-rotated", "SECURITY", true, "IMMEDIATE_ONLY"),
      row(
        "domain-verification-instructions",
        "TRANSACTIONAL",
        true,
        "IMMEDIATE_ONLY",
      ),
      row("domain-verified", "TRANSACTIONAL", true, "IMMEDIATE_ONLY"),
      row("email-verification", "TRANSACTIONAL", true, "IMMEDIATE_ONLY"),
      row("sso-account-welcome", "TRANSACTIONAL", true, "IMMEDIATE_ONLY"),
      row("welcome-account", "TRANSACTIONAL", true, "IMMEDIATE_ONLY"),
      row("assigned-as-owner", "WORKFLOW", false, "IMMEDIATE_OR_DIGEST"),
      row("workflow-assigned", "WORKFLOW", false, "IMMEDIATE_OR_DIGEST"),
      row(
        "workflow-awaiting-approval",
        "WORKFLOW",
        false,
        "IMMEDIATE_OR_DIGEST",
      ),
      row("workflow-denied", "WORKFLOW", false, "IMMEDIATE_OR_DIGEST"),
      row("workflow-started", "WORKFLOW", false, "DIGEST_PREFERRED"),
      row("access-granted", "INFORMATIONAL", false, "DIGEST_PREFERRED"),
      row("idp-test-failed", "INFORMATIONAL", false, "IMMEDIATE_OR_DIGEST"),
      row("policy-published", "INFORMATIONAL", false, "DIGEST_PREFERRED"),
      row("policy-retired", "INFORMATIONAL", false, "DIGEST_PREFERRED"),
      row(
        "raci-permission-granted",
        "INFORMATIONAL",
        false,
        "DIGEST_PREFERRED",
      ),
      row("sso-activated", "INFORMATIONAL", false, "IMMEDIATE_OR_DIGEST"),
      row("sso-disabled", "INFORMATIONAL", false, "IMMEDIATE_OR_DIGEST"),
    ]);
  });
});

describe("notificationSettings", () => {
  it("gives someone who saved nothing obligations' defaults", async () => {
    assert.deepEqual(await settingsOf(await signInAs(base, "user-erin")), {
      categories: DEFAULT_CATEGORIES,
      channels: { email: true, inApp: true, push: false, userId: "user-erin" },
      digest: { dailyHour: 8, weeklyDow: 1 },
      overrides: [],
    });
  });

  it("shows the choices Alice saved", async () => {
    const settings = await settingsOf(await signInAs(base, "user-alice"));
    assert.deepEqual(settings, {
      categories: DEFAULT_CATEGORIES.map((c) =>
        c.category === "WORKFLOW" ? { ...c, cadence: "DAILY" } : c,
      ),
      channels: { email: true, inApp: true, push: true, userId: "user-alice" },
      digest: { dailyHour: 7, weeklyDow: 1 },
      overrides: [
        {
          cadence: "IMMEDIATE",
          category: "WORKFLOW",
          delivery: "IMMEDIATE_OR_DIGEST",
          kind: "workflow-awaiting-approval",
          mandatory: false,
        },
      ],
    });
  });

  it("refuses someone signed out", async () => {
    const { body } = await query(
      base,
      `query { notificationSettings { ${SETTINGS} } }`,
    );
    assert.ok(body.errors?.length);
  });
});

describe("setCategoryCadence", () => {
  const SET = `mutation ($category: NotifCategory!, $cadence: NotifCadence!) {
    setCategoryCadence(category: $category, cadence: $cadence) { ${SETTINGS} }
  }`;

  it("saves a category's cadence for the caller alone", async () => {
    const erin = await signInAs(base, "user-erin");
    const data = await ok(SET, erin, {
      cadence: "WEEKLY",
      category: "WORKFLOW",
    });
    const saved = data.setCategoryCadence as { categories: unknown[] };
    assert.deepEqual(saved.categories[3], {
      cadence: "WEEKLY",
      category: "WORKFLOW",
      mandatory: false,
    });
    assert.deepEqual(await settingsOf(erin), saved);
    const dave = (await settingsOf(await signInAs(base, "user-dave"))) as {
      categories: unknown[];
    };
    assert.deepEqual(dave.categories, DEFAULT_CATEGORIES);
  });

  it("turns off an optional category and puts a required one on a digest", async () => {
    const erin = await signInAs(base, "user-erin");
    await ok(SET, erin, { cadence: "OFF", category: "INFORMATIONAL" });
    await ok(SET, erin, { cadence: "DAILY", category: "COMPLIANCE" });
    const settings = (await settingsOf(erin)) as { categories: unknown[] };
    assert.deepEqual(settings.categories[0], {
      cadence: "DAILY",
      category: "COMPLIANCE",
      mandatory: true,
    });
    assert.deepEqual(settings.categories[4], {
      cadence: "OFF",
      category: "INFORMATIONAL",
      mandatory: false,
    });
  });

  it("won't turn off a required category", async () => {
    const erin = await signInAs(base, "user-erin");
    for (const category of ["COMPLIANCE", "SECURITY", "TRANSACTIONAL"])
      assert.deepEqual(
        await refusal(SET, erin, { cadence: "OFF", category }),
        MANDATORY_OFF,
      );
    assert.deepEqual(
      ((await settingsOf(erin)) as { categories: unknown[] }).categories,
      DEFAULT_CATEGORIES,
    );
  });
});

describe("setTypeCadence", () => {
  const SET = `mutation ($kind: String!, $cadence: NotifCadence!) {
    setTypeCadence(kind: $kind, cadence: $cadence) { ${SETTINGS} }
  }`;

  it("saves an override with the type's class", async () => {
    const erin = await signInAs(base, "user-erin");
    await ok(SET, erin, { cadence: "OFF", kind: "policy-published" });
    const data = await ok(SET, erin, {
      cadence: "DAILY",
      kind: "ack-required",
    });
    assert.deepEqual(
      (data.setTypeCadence as { overrides: unknown[] }).overrides,
      [
        {
          cadence: "OFF",
          category: "INFORMATIONAL",
          delivery: "DIGEST_PREFERRED",
          kind: "policy-published",
          mandatory: false,
        },
        {
          cadence: "DAILY",
          category: "COMPLIANCE",
          delivery: "IMMEDIATE_ONLY",
          kind: "ack-required",
          mandatory: true,
        },
      ],
    );
  });

  it("refuses an unknown type and turning off a required one", async () => {
    const erin = await signInAs(base, "user-erin");
    assert.deepEqual(
      await refusal(SET, erin, { cadence: "DAILY", kind: "no-such-kind" }),
      INVALID,
    );
    assert.deepEqual(
      await refusal(SET, erin, { cadence: "OFF", kind: "otp" }),
      MANDATORY_OFF,
    );
  });
});

describe("setDigestWindow", () => {
  const SET = `mutation ($dailyHour: Int!, $weeklyDow: Int!) {
    setDigestWindow(dailyHour: $dailyHour, weeklyDow: $weeklyDow) { digest { dailyHour weeklyDow } }
  }`;

  it("saves the digest hour and day", async () => {
    const erin = await signInAs(base, "user-erin");
    const data = await ok(SET, erin, { dailyHour: 18, weeklyDow: 5 });
    assert.deepEqual(data.setDigestWindow, {
      digest: { dailyHour: 18, weeklyDow: 5 },
    });
    assert.deepEqual(((await settingsOf(erin)) as { digest: unknown }).digest, {
      dailyHour: 18,
      weeklyDow: 5,
    });
  });

  it("refuses an hour or day out of range", async () => {
    const erin = await signInAs(base, "user-erin");
    for (const window of [
      { dailyHour: 24, weeklyDow: 1 },
      { dailyHour: -1, weeklyDow: 1 },
      { dailyHour: 8, weeklyDow: 0 },
      { dailyHour: 8, weeklyDow: 8 },
    ])
      assert.deepEqual(await refusal(SET, erin, window), INVALID);
  });
});

describe("setNotificationChannels", () => {
  it("saves the caller's channel switches", async () => {
    const erin = await signInAs(base, "user-erin");
    const data = await ok(
      `mutation ($input: NotificationPrefInput!) {
        setNotificationChannels(input: $input) { channels { userId email inApp push } }
      }`,
      erin,
      { input: { email: false, inApp: true, push: true } },
    );
    const channels = {
      email: false,
      inApp: true,
      push: true,
      userId: "user-erin",
    };
    assert.deepEqual(data.setNotificationChannels, { channels });
    assert.deepEqual(
      ((await settingsOf(erin)) as { channels: unknown }).channels,
      channels,
    );
  });
});

const FAULT = {
  code: "INTERNAL",
  message: "Something went wrong on our side. Please try again.",
};

const kindsOf = async (signed: Signed) =>
  (
    (await ok("query { myFactors { kind } }", signed)).myFactors as {
      kind: string;
    }[]
  ).map((f) => f.kind);

const passkeysOf = async (signed: Signed) =>
  (await ok("query { myWebauthnCredentials { id label } }", signed))
    .myWebauthnCredentials;

describe("enrollTotpBegin and enrollTotpConfirm", () => {
  const BEGIN = "mutation { enrollTotpBegin { otpauthUri secretMasked } }";
  const CONFIRM =
    "mutation ($code: String!) { enrollTotpConfirm(code: $code) }";

  it("enrols Erin's authenticator app once she proves a code", async () => {
    const erin = await signInAs(base, "user-erin");
    const begun = (await ok(BEGIN, erin)).enrollTotpBegin as {
      otpauthUri: string;
      secretMasked: string;
    };
    const uri = new URL(begun.otpauthUri);
    assert.equal(uri.protocol, "otpauth:");
    assert.equal(uri.host, "totp");
    assert.equal(decodeURIComponent(uri.pathname), "/Steward:erin@example.org");
    assert.equal(uri.searchParams.get("issuer"), "Steward");
    const secret = uri.searchParams.get("secret") ?? "";
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(begun.secretMasked, `••••${secret.slice(-4)}`);

    assert.deepEqual(await refusal(CONFIRM, erin, { code: "" }), {
      code: "InvalidArgument",
      message: "code required",
    });
    assert.deepEqual(await refusal(CONFIRM, erin, { code: WRONG_CODE }), {
      code: "InvalidArgument",
      message: "invalid code",
    });
    assert.deepEqual(await kindsOf(erin), ["email"]);
    const data = await ok(CONFIRM, erin, { code: GOOD_CODE });
    assert.equal(data.enrollTotpConfirm, true);
    assert.deepEqual(await kindsOf(erin), ["totp", "email"]);
    assert.equal(
      stewardData().audit.at(-1)?.action,
      "user.mfa_factor_enrolled",
    );
  });

  it("won't confirm with nothing begun, or begin over an enrolled app", async () => {
    assert.deepEqual(
      await refusal(CONFIRM, await signInAs(base, "user-erin"), {
        code: GOOD_CODE,
      }),
      FAULT,
    );
    assert.deepEqual(
      await refusal(BEGIN, await signInAs(base, "user-alice")),
      FAULT,
    );
  });
});

describe("removeFactor", () => {
  const REMOVE = "mutation ($kind: String!) { removeFactor(kind: $kind) }";

  it("removes the authenticator app or every passkey", async () => {
    const charlie = await signInAs(base, "user-charlie");
    assert.equal(
      (await ok(REMOVE, charlie, { kind: "totp" })).removeFactor,
      true,
    );
    assert.equal(
      (await ok(REMOVE, charlie, { kind: "passkey" })).removeFactor,
      true,
    );
    assert.deepEqual(await kindsOf(charlie), ["email"]);
    assert.equal(stewardData().audit.at(-1)?.action, "user.mfa_factor_removed");
  });

  it("refuses what isn't there, the email factor and an unknown kind", async () => {
    const erin = await signInAs(base, "user-erin");
    assert.deepEqual(await refusal(REMOVE, erin, { kind: "totp" }), {
      code: "NotFound",
      message: "no totp enrollment to remove",
    });
    assert.deepEqual(await refusal(REMOVE, erin, { kind: "passkey" }), {
      code: "NotFound",
      message: "no passkeys to remove",
    });
    assert.deepEqual(await refusal(REMOVE, erin, { kind: "email" }), FAULT);
    assert.deepEqual(await refusal(REMOVE, erin, { kind: "sms" }), {
      code: "InvalidArgument",
      message: 'unknown factor kind "sms"',
    });
  });
});

describe("removeWebauthnCredential", () => {
  const REMOVE =
    "mutation ($credentialId: ID!) { removeWebauthnCredential(credentialId: $credentialId) }";

  it("removes one passkey by its id", async () => {
    const charlie = await signInAs(base, "user-charlie");
    const credentialId = passkeyCredentialId("charlie");
    const data = await ok(REMOVE, charlie, { credentialId });
    assert.equal(data.removeWebauthnCredential, true);
    assert.deepEqual(await passkeysOf(charlie), []);
    assert.deepEqual(await refusal(REMOVE, charlie, { credentialId }), {
      code: "NotFound",
      message: "no such credential",
    });
    assert.deepEqual(await refusal(REMOVE, charlie, { credentialId: "" }), {
      code: "InvalidArgument",
      message: "credential_id required",
    });
  });
});

describe("renameMfaMethod", () => {
  const RENAME =
    "mutation ($methodId: ID!, $label: String!) { renameMfaMethod(methodId: $methodId, label: $label) }";

  it("names a passkey and the authenticator app", async () => {
    const charlie = await signInAs(base, "user-charlie");
    const id = passkeyCredentialId("charlie");
    await ok(RENAME, charlie, { label: "Work laptop", methodId: id });
    assert.deepEqual(await passkeysOf(charlie), [{ id, label: "Work laptop" }]);
    await ok(RENAME, charlie, { label: "Phone", methodId: "totp" });
    const factors = (await ok("query { myFactors { kind label } }", charlie))
      .myFactors as { kind: string; label: null | string }[];
    assert.equal(factors[0]?.label, "Phone");
    assert.equal(
      stewardData().audit.at(-1)?.action,
      "user.mfa_factor_relabeled",
    );
  });

  it("refuses the email factor, a long label and a method that isn't there", async () => {
    const erin = await signInAs(base, "user-erin");
    assert.deepEqual(
      await refusal(RENAME, erin, { label: "Inbox", methodId: "email" }),
      FAULT,
    );
    assert.deepEqual(
      await refusal(RENAME, erin, { label: "x".repeat(129), methodId: "totp" }),
      {
        code: "InvalidArgument",
        message: "label too long (max 128 characters)",
      },
    );
    assert.deepEqual(
      await refusal(RENAME, erin, { label: "Phone", methodId: "totp" }),
      { code: "NotFound", message: "no totp enrollment to rename" },
    );
    assert.deepEqual(
      await refusal(RENAME, erin, { label: "Key", methodId: "abc" }),
      { code: "NotFound", message: "no such passkey to rename" },
    );
  });
});

describe("webauthnRegisterBegin and webauthnRegisterFinish", () => {
  const BEGIN = "mutation { webauthnRegisterBegin { optionsJson sessionId } }";
  const FINISH = `mutation ($sessionId: ID!, $credentialJson: String!, $label: String) {
    webauthnRegisterFinish(sessionId: $sessionId, credentialJson: $credentialJson, label: $label)
  }`;

  it("registers Erin's passkey with the name she gave it", async () => {
    const erin = await signInAs(base, "user-erin");
    const begun = (await ok(BEGIN, erin)).webauthnRegisterBegin as {
      optionsJson: string;
      sessionId: string;
    };
    const { publicKey } = JSON.parse(begun.optionsJson) as {
      publicKey: {
        challenge: string;
        pubKeyCredParams: unknown[];
        rp: { name: string };
        user: { displayName: string; id: string; name: string };
      };
    };
    assert.ok(publicKey.challenge.length > 0);
    assert.equal(publicKey.rp.name, "Steward");
    assert.equal(publicKey.user.name, "erin@example.org");
    assert.equal(publicKey.user.displayName, "Erin Reader");
    assert.ok(publicKey.pubKeyCredParams.length > 0);

    const credentialJson = JSON.stringify({
      id: "new-key",
      type: "public-key",
    });
    const data = await ok(FINISH, erin, {
      credentialJson,
      label: "  YubiKey  ",
      sessionId: begun.sessionId,
    });
    assert.equal(data.webauthnRegisterFinish, true);
    assert.deepEqual(await passkeysOf(erin), [
      { id: "new-key", label: "YubiKey" },
    ]);
    assert.deepEqual(await kindsOf(erin), ["passkey", "email"]);
    assert.deepEqual(
      await refusal(FINISH, erin, {
        credentialJson,
        sessionId: begun.sessionId,
      }),
      {
        code: "NotFound",
        message:
          "no pending register ceremony for this session (expired, used, or unknown) — begin again",
      },
    );
  });

  it("refuses a missing or malformed credential", async () => {
    const erin = await signInAs(base, "user-erin");
    const { sessionId } = (await ok(BEGIN, erin)).webauthnRegisterBegin as {
      sessionId: string;
    };
    assert.deepEqual(
      await refusal(FINISH, erin, { credentialJson: "", sessionId }),
      { code: "InvalidArgument", message: "credential_json required" },
    );
    assert.deepEqual(
      await refusal(FINISH, erin, { credentialJson: "{not json", sessionId }),
      { code: "InvalidArgument", message: "malformed webauthn credential" },
    );
  });
});
