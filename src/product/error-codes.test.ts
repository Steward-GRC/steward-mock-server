// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Refusals carry the codes steward-gateway puts in extensions.code: a service's refusal is relayed
// with its gRPC status name (internal/server/errors.go, presentStatus), and steward-web reads
// some of them by name (isPermissionDenied, to let a reader without audit.read open a policy).

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { refuse } from "#product/resolvers/shared.ts";
import {
  query,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";

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

const codeOf = (code: Parameters<typeof refuse>[0]) =>
  refuse(code, "x").extensions.code;

describe("error codes", () => {
  it("spells each refusal the way the gateway relays a service's status", () => {
    assert.equal(codeOf("ALREADY_EXISTS"), "AlreadyExists");
    assert.equal(codeOf("BAD_USER_INPUT"), "InvalidArgument");
    assert.equal(codeOf("FAILED_PRECONDITION"), "FailedPrecondition");
    assert.equal(codeOf("FORBIDDEN"), "PermissionDenied");
    assert.equal(codeOf("INTERNAL"), "INTERNAL");
    assert.equal(codeOf("NOT_FOUND"), "NotFound");
  });

  it("refuses a reader the audit log with PermissionDenied", async () => {
    const reader = await signIn(base, "kjohnson");
    const { body } = await query(
      base,
      'query { auditLog(subject: "policy:any") { records { id } } }',
      reader,
    );
    assert.equal(body.errors?.[0]?.extensions.code, "PermissionDenied");
  });
});
