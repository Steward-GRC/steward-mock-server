// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The Compliance module switch and the four-eyes hard reset (steward-reporting#47,
// steward-gateway#227, steward-identity#77): the switch refuses every case call with MODULE_OFF
// and keeps the data; the root admin asks for a hard reset, a different active site admin
// approves, and root redeems the approval once with the exact phrase, with the module off and no
// case under a legal hold.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

import { stewardData } from "#product/data.ts";
import { query, startForTests, startFresh } from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});

const PHRASE = "RESET COMPLIANCE DATA";

let alice: Signed; // root and site admin
let charlie: Signed; // made a second site admin
let dave: Signed; // compliance admin and privacy officer
let bob: Signed; // an author, nothing else

beforeEach(async () => {
  startFresh();
  stewardData()
    .people.find((p) => p.id === "user-charlie")
    ?.roles.push("site-admin");
  alice = await signInAs(base, "user-alice");
  charlie = await signInAs(base, "user-charlie");
  dave = await signInAs(base, "user-dave");
  bob = await signInAs(base, "user-bob");
});

interface Answer {
  code?: string;
  data: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  message?: string;
}

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
): Promise<Answer> => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | {
        extensions: { code: string } & Record<string, unknown>;
        message: string;
      }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    extensions: error?.extensions,
    message: error?.message,
  };
};

const SETTINGS = `query { complianceSettings { moduleEnabled } }`;
const SWITCH = `mutation ($enabled: Boolean!) { setComplianceModule(enabled: $enabled) { moduleEnabled } }`;
const CASES = `query { reportCases { cases { id } } }`;
const CASE = `query { reportCase(caseId: "case-1") { id } }`;
const NOTE = `mutation { addCaseNote(caseId: "case-1", body: "x") { id } }`;
const REQUEST = `mutation ($reason: String!, $module: String!) {
  requestHardReset(module: $module, reason: $reason) { id module state requestedBy approvedBy expiresAt }
}`;
const APPROVE = `mutation ($id: ID!) { approveHardReset(requestId: $id) { id state approvedBy approvalExpiresAt } }`;
const CANCEL = `mutation ($id: ID!) { cancelHardReset(requestId: $id) { id state cancelledAt } }`;
const LIST = `query { hardResetRequests(module: "compliance") { id state } }`;
const EXECUTE = `mutation ($id: ID!, $phrase: String!) {
  executeHardReset(requestId: $id, confirmation: $phrase) { casesDeleted requestedBy approvedBy }
}`;

const setModule = (signed: Signed, enabled: boolean) =>
  ask(signed, SWITCH, { enabled });

const request = async (signed = alice) => {
  const made = await ask(signed, REQUEST, {
    module: "compliance",
    reason: "retention review",
  });
  assert.equal(made.code, undefined, made.message);
  return (made.data.requestHardReset as { id: string }).id;
};

/** A request root asked for and charlie approved. */
const approvedRequest = async () => {
  const id = await request();
  const approved = await ask(charlie, APPROVE, { id });
  assert.equal(approved.code, undefined, approved.message);
  return id;
};

const refusedWith = (
  answer: Answer,
  code: string,
  codeNumber: number,
  message: string,
) => {
  assert.equal(answer.code, code);
  assert.equal(answer.extensions?.codeNum, codeNumber);
  assert.equal(answer.extensions?.domain, "reporting");
  assert.equal(answer.extensions?.kind, "business");
  assert.equal(answer.message, message);
};

const caseCount = () => stewardData().reportCases.length;

describe("the Compliance module switch", () => {
  it("starts on", async () => {
    const answer = await ask(dave, SETTINGS);
    assert.deepEqual(answer.data.complianceSettings, { moduleEnabled: true });
  });

  it("lets a compliance admin and root read and change it, and nobody else", async () => {
    assert.equal(
      (await ask(alice, SETTINGS)).data.complianceSettings !== undefined,
      true,
    );
    for (const who of [bob, charlie]) {
      refusedWith(
        await ask(who, SETTINGS),
        "SETTINGS_ACCESS_DENIED",
        8111,
        "Only compliance admins can see or change the Compliance settings.",
      );
      assert.equal(
        (await setModule(who, false)).code,
        "SETTINGS_ACCESS_DENIED",
      );
    }
    const off = await setModule(dave, false);
    assert.deepEqual(off.data.setComplianceModule, { moduleEnabled: false });
    const on = await setModule(alice, true);
    assert.deepEqual(on.data.setComplianceModule, { moduleEnabled: true });
  });

  it("refuses every case call with MODULE_OFF while off, and keeps the data", async () => {
    const before = caseCount();
    assert.ok(before > 0);
    await setModule(dave, false);
    for (const text of [CASES, CASE, NOTE]) {
      refusedWith(
        await ask(dave, text),
        "MODULE_OFF",
        8113,
        "Compliance reporting is switched off.",
      );
    }
    // The switch comes before the role check, as the gate does in reporting.
    assert.equal((await ask(bob, CASES)).code, "MODULE_OFF");
    assert.equal(caseCount(), before);
    assert.equal(stewardData().reportCases[0]?.notes.length, 0);
  });

  it("keeps settings and the switch open while off, and serves cases again once on", async () => {
    await setModule(dave, false);
    assert.deepEqual((await ask(dave, SETTINGS)).data.complianceSettings, {
      moduleEnabled: false,
    });
    await setModule(dave, true);
    const answer = await ask(dave, CASES);
    assert.equal(answer.code, undefined);
    assert.equal(
      (answer.data.reportCases as { cases: unknown[] }).cases.length,
      caseCount(),
    );
  });

  it("refuses a case call from anyone but a privacy officer with CASE_ACCESS_DENIED, as reporting does", async () => {
    for (const who of [bob, alice]) {
      const answer = await ask(who, CASES);
      assert.equal(answer.code, "CASE_ACCESS_DENIED");
      assert.equal(answer.extensions?.codeNum, 8105);
      assert.equal(answer.extensions?.domain, "reporting");
      assert.equal(answer.extensions?.kind, "business");
      assert.equal(answer.message, "Only privacy officers can open cases.");
    }
  });

  it("records the switch in the audit trail", async () => {
    await setModule(dave, false);
    await setModule(dave, true);
    const actions = stewardData()
      .audit.filter((r) => r.action.startsWith("module."))
      .map((r) => r.action);
    assert.deepEqual(actions, ["module.disabled", "module.enabled"]);
  });
});

describe("a four-eyes hard reset request", () => {
  it("is asked for by root alone, for the compliance module with a reason", async () => {
    const made = await ask(alice, REQUEST, {
      module: "compliance",
      reason: "retention review",
    });
    assert.equal(made.code, undefined);
    const row = made.data.requestHardReset as Record<string, null | string>;
    assert.equal(row.state, "pending");
    assert.equal(row.requestedBy, "user-alice");
    assert.equal(row.approvedBy, null);

    for (const who of [charlie, dave, bob]) {
      const refused = await ask(who, REQUEST, {
        module: "compliance",
        reason: "x",
      });
      assert.equal(refused.code, "PermissionDenied");
    }
    assert.equal(
      (await ask(alice, REQUEST, { module: "compliance", reason: "again" }))
        .code,
      "FailedPrecondition",
      "one open request per module",
    );
  });

  it("refuses an unknown module and a blank reason", async () => {
    const module = await ask(alice, REQUEST, {
      module: "policies",
      reason: "x",
    });
    assert.equal(module.code, "InvalidArgument");
    const reason = await ask(alice, REQUEST, {
      module: "compliance",
      reason: " ".repeat(3),
    });
    assert.equal(reason.code, "InvalidArgument");
  });

  it("is approved by a different active site admin, never by the requester", async () => {
    const id = await request();
    const own = await ask(alice, APPROVE, { id });
    assert.equal(own.code, "PermissionDenied");
    assert.equal(
      own.message,
      "a different site-admin must approve: the requester can't",
    );
    for (const who of [dave, bob]) {
      assert.equal((await ask(who, APPROVE, { id })).code, "PermissionDenied");
    }
    const approved = await ask(charlie, APPROVE, { id });
    const row = approved.data.approveHardReset as Record<string, string>;
    assert.equal(row.state, "approved");
    assert.equal(row.approvedBy, "user-charlie");
    assert.ok(row.approvalExpiresAt);
    assert.equal(
      (await ask(charlie, APPROVE, { id })).code,
      "FailedPrecondition",
      "an approved request cannot be approved again",
    );
  });

  it("does not take the approval of a disabled site admin", async () => {
    const id = await request();
    const charlieRow = stewardData().people.find(
      (p) => p.id === "user-charlie",
    );
    assert.ok(charlieRow);
    charlieRow.disabled = true;
    // A disabled account cannot sign in, so the token is the proof it was issued earlier.
    const answer = await ask(charlie, APPROVE, { id });
    assert.notEqual(answer.code, undefined);
    assert.equal(stewardData().hardResets[0]?.state, "pending");
  });

  it("lets only the requester cancel, and lets root and site admins list", async () => {
    const id = await request();
    assert.equal((await ask(charlie, CANCEL, { id })).code, "PermissionDenied");
    assert.equal((await ask(dave, CANCEL, { id })).code, "PermissionDenied");
    for (const who of [alice, charlie]) {
      const listed = await ask(who, LIST);
      assert.deepEqual(listed.data.hardResetRequests, [
        { id, state: "pending" },
      ]);
    }
    assert.equal((await ask(dave, LIST)).code, "PermissionDenied");
    assert.equal((await ask(bob, LIST)).code, "PermissionDenied");

    const cancelled = await ask(alice, CANCEL, { id });
    assert.equal(
      (cancelled.data.cancelHardReset as { state: string }).state,
      "cancelled",
    );
    assert.equal((await ask(alice, CANCEL, { id })).code, "FailedPrecondition");
    // The module is free for a new request.
    assert.notEqual(await request(), id);
  });

  it("expires after 24 hours unapproved and an hour unredeemed", async () => {
    const id = await request();
    const row = stewardData().hardResets.find((r) => r.id === id);
    assert.ok(row);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(
      (await ask(charlie, APPROVE, { id })).code,
      "FailedPrecondition",
    );
    assert.deepEqual((await ask(alice, LIST)).data.hardResetRequests, [
      { id, state: "expired" },
    ]);

    const second = await approvedRequest();
    const approved = stewardData().hardResets.find((r) => r.id === second);
    assert.ok(approved);
    approved.approvalExpiresAt = new Date(Date.now() - 1000).toISOString();
    await setModule(dave, false);
    assert.equal(
      (await ask(alice, EXECUTE, { id: second, phrase: PHRASE })).code,
      "HARD_RESET_NOT_APPROVED",
    );
  });
});

describe("executeHardReset", () => {
  it("is refused unless the caller is root, with HARD_RESET_ROOT_REQUIRED", async () => {
    const id = await approvedRequest();
    await setModule(dave, false);
    for (const who of [charlie, dave, bob]) {
      refusedWith(
        await ask(who, EXECUTE, { id, phrase: PHRASE }),
        "HARD_RESET_ROOT_REQUIRED",
        8118,
        "Only the root admin can run a hard reset.",
      );
    }
    assert.ok(caseCount() > 0);
  });

  it("needs the exact phrase, with HARD_RESET_CONFIRMATION", async () => {
    const id = await approvedRequest();
    await setModule(dave, false);
    for (const phrase of ["", "reset compliance data", `${PHRASE} `, "RESET"]) {
      refusedWith(
        await ask(alice, EXECUTE, { id, phrase }),
        "HARD_RESET_CONFIRMATION",
        8114,
        "The confirmation phrase doesn't match. Type it exactly as shown.",
      );
    }
    assert.ok(caseCount() > 0);
    assert.equal(stewardData().hardResets[0]?.state, "approved", "not spent");
  });

  it("needs the module off first, with HARD_RESET_MODULE_ON", async () => {
    const id = await approvedRequest();
    refusedWith(
      await ask(alice, EXECUTE, { id, phrase: PHRASE }),
      "HARD_RESET_MODULE_ON",
      8115,
      "Switch the module off first.",
    );
    assert.ok(caseCount() > 0);
  });

  it("is blocked by any case under a legal hold, with HARD_RESET_LEGAL_HOLD", async () => {
    const id = await approvedRequest();
    await setModule(dave, false);
    const held = stewardData().reportCases[1];
    assert.ok(held);
    held.legalHold = true;
    refusedWith(
      await ask(alice, EXECUTE, { id, phrase: PHRASE }),
      "HARD_RESET_LEGAL_HOLD",
      8116,
      "A case is under a legal hold.",
    );
    assert.ok(caseCount() > 0);
    assert.equal(stewardData().hardResets[0]?.state, "approved", "not spent");
  });

  it("needs an approved request, with HARD_RESET_NOT_APPROVED", async () => {
    await setModule(dave, false);
    const pending = await request();
    const message =
      "This hard reset has no valid approval from a second admin.";
    refusedWith(
      await ask(alice, EXECUTE, { id: pending, phrase: PHRASE }),
      "HARD_RESET_NOT_APPROVED",
      8117,
      message,
    );
    refusedWith(
      await ask(alice, EXECUTE, { id: "hard-reset-999", phrase: PHRASE }),
      "HARD_RESET_NOT_APPROVED",
      8117,
      message,
    );
    assert.ok(caseCount() > 0);
  });

  it("deletes every case, keeps the module off, spends the approval once and audits it", async () => {
    const id = await approvedRequest();
    await setModule(dave, false);
    const count = caseCount();
    assert.ok(count > 0);
    const done = await ask(alice, EXECUTE, { id, phrase: PHRASE });
    assert.equal(done.code, undefined, done.message);
    assert.deepEqual(done.data.executeHardReset, {
      approvedBy: "user-charlie",
      casesDeleted: count,
      requestedBy: "user-alice",
    });
    assert.equal(caseCount(), 0);
    assert.equal(stewardData().complianceModuleEnabled, false);
    assert.deepEqual((await ask(alice, SETTINGS)).data.complianceSettings, {
      moduleEnabled: false,
    });

    const spent = stewardData().hardResets.find((r) => r.id === id);
    assert.equal(spent?.state, "consumed");
    assert.equal(spent?.consumedBy, "reporting");
    assert.equal(
      (await ask(alice, EXECUTE, { id, phrase: PHRASE })).code,
      "HARD_RESET_NOT_APPROVED",
      "redeemed once",
    );

    const events = stewardData().audit.filter(
      (r) => r.action === "module.hard_reset",
    );
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.actorUserId, "user-alice");
    assert.equal(event?.subject, "module:compliance");
    const label = event?.subjectLabel ?? "";
    for (const part of [id, "user-alice", "user-charlie", String(count)])
      assert.ok(label.includes(part), `${part} is in ${label}`);
    // Nothing about a case or its reporter is written.
    assert.equal(/K7Q4|P3D8|case-/.test(label), false);
    assert.equal(
      stewardData().audit.some((r) => r.action === "hard_reset.consumed"),
      true,
    );
  });

  it("is refused while acting as another user", async () => {
    const id = await approvedRequest();
    await setModule(dave, false);
    const started = await ask(
      alice,
      `mutation { startImpersonation(userId: "user-bob", reason: "support") { targetUserId } }`,
    );
    assert.equal(started.code, undefined, started.message);
    const refused = await ask(alice, EXECUTE, { id, phrase: PHRASE });
    assert.equal(refused.code, "ACT_AS_NOT_ALLOWED");
    assert.ok(caseCount() > 0);
  });
});
