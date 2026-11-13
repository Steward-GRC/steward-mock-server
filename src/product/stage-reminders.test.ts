// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The stage reminder and escalation days (steward-mock-server#245), whole working days kept on a
// workflow stage: remindEveryDays and escalateAfterDays. Zero or absent is off, each is 0 to 365,
// and either needs the stage's slaDays and cannot sit on a stage that rejects at its due date.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";
import type { Signed } from "#product/test-client.ts";

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
beforeEach(() => {
  startFresh();
});

const as = (user: string) => signInAs(base, `user-${user}`);

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const FIELDS = "stages { slaDays remindEveryDays escalateAfterDays }";
const CREATE = `mutation ($name: String!, $stages: [WorkflowStageInput!]!) {
  createWorkflowDef(name: $name, stages: $stages) { id ${FIELDS} }
}`;
const UPDATE = `mutation ($id: ID!, $name: String!, $stages: [WorkflowStageInput!]!) {
  updateWorkflowDef(id: $id, name: $name, stages: $stages) { id ${FIELDS} }
}`;
const READ = `query ($id: ID!) { workflowDef(id: $id) { id ${FIELDS} } }`;

const stageInput = (given: Record<string, unknown>) => ({
  approvers: ["user-charlie"],
  name: "Review",
  quorum: "one",
  slaDays: 5,
  ...given,
});

const stagesOf = (answer: { data: Record<string, unknown> }, key: string) =>
  (answer.data[key] as { stages: unknown[] }).stages;

describe("saving a stage with reminder and escalation days", () => {
  it("keeps both and reads them back after create, update and a fresh read", async () => {
    const admin = await as("grace");
    const made = await ask(admin, CREATE, {
      name: "Chased",
      stages: [stageInput({ escalateAfterDays: 2, remindEveryDays: 1 })],
    });
    assert.equal(made.code, undefined, made.message);
    assert.deepEqual(stagesOf(made, "createWorkflowDef"), [
      { escalateAfterDays: 2, remindEveryDays: 1, slaDays: 5 },
    ]);
    const id = (made.data.createWorkflowDef as { id: string }).id;
    const changed = await ask(admin, UPDATE, {
      id,
      name: "Chased",
      stages: [stageInput({ escalateAfterDays: 4, remindEveryDays: 3 })],
    });
    assert.equal(changed.code, undefined, changed.message);
    assert.deepEqual(stagesOf(changed, "updateWorkflowDef"), [
      { escalateAfterDays: 4, remindEveryDays: 3, slaDays: 5 },
    ]);
    const read = await ask(admin, READ, { id });
    assert.deepEqual(stagesOf(read, "workflowDef"), [
      { escalateAfterDays: 4, remindEveryDays: 3, slaDays: 5 },
    ]);
  });

  it("reads zero when a stage sets neither, and keeps an explicit zero as off", async () => {
    const admin = await as("grace");
    const omitted = await ask(admin, CREATE, {
      name: "Quiet",
      stages: [stageInput({})],
    });
    assert.equal(omitted.code, undefined, omitted.message);
    assert.deepEqual(stagesOf(omitted, "createWorkflowDef"), [
      { escalateAfterDays: 0, remindEveryDays: 0, slaDays: 5 },
    ]);
    const zero = await ask(admin, CREATE, {
      name: "Zero",
      stages: [stageInput({ escalateAfterDays: 0, remindEveryDays: 0 })],
    });
    assert.equal(zero.code, undefined, zero.message);
    assert.deepEqual(stagesOf(zero, "createWorkflowDef"), [
      { escalateAfterDays: 0, remindEveryDays: 0, slaDays: 5 },
    ]);
  });

  it("allows zero on a stage with no slaDays and on a stage that rejects at due", async () => {
    const admin = await as("grace");
    const answer = await ask(admin, CREATE, {
      name: "Off",
      stages: [
        stageInput({ remindEveryDays: 0, slaDays: null }),
        stageInput({ escalateAfterDays: 0, rejectOnSlaBreach: true }),
      ],
    });
    assert.equal(answer.code, undefined, answer.message);
  });

  it("accepts 365 and refuses 366 and below zero, on each field", async () => {
    const admin = await as("grace");
    for (const field of ["remindEveryDays", "escalateAfterDays"]) {
      const top = await ask(admin, CREATE, {
        name: "Top",
        stages: [stageInput({ [field]: 365 })],
      });
      assert.equal(top.code, undefined, `${field} 365: ${top.message}`);
      assert.equal(
        (stagesOf(top, "createWorkflowDef")[0] as Record<string, number>)[
          field
        ],
        365,
      );
      for (const value of [366, -1]) {
        const answer = await ask(admin, CREATE, {
          name: "Bad",
          stages: [stageInput({ [field]: value })],
        });
        assert.equal(answer.code, "InvalidArgument", `${field} ${value}`);
        assert.match(
          answer.message ?? "",
          new RegExp(
            `${field === "remindEveryDays" ? "remind_every_days" : "escalate_after_days"} must be between 0 and 365`,
          ),
        );
      }
    }
  });

  it("refuses either field on a stage with no slaDays", async () => {
    const admin = await as("grace");
    for (const field of ["remindEveryDays", "escalateAfterDays"]) {
      for (const slaDays of [null, 0]) {
        const answer = await ask(admin, CREATE, {
          name: "Undated",
          stages: [stageInput({ [field]: 1, slaDays })],
        });
        assert.equal(answer.code, "InvalidArgument", `${field} ${slaDays}`);
        assert.match(answer.message ?? "", /needs sla_days/);
      }
    }
  });

  it("refuses either field on a stage that rejects at its due date", async () => {
    const admin = await as("grace");
    for (const field of ["remindEveryDays", "escalateAfterDays"]) {
      const answer = await ask(admin, UPDATE, {
        id: "workflow-2",
        name: "Standard 2-stage",
        stages: [stageInput({ [field]: 2, rejectOnSlaBreach: true })],
      });
      assert.equal(answer.code, "InvalidArgument", field);
      assert.match(answer.message ?? "", /reject_on_sla_breach/);
    }
  });

  it("leaves the seeded workflows without the fields except the one that sets them", async () => {
    const admin = await as("grace");
    const one = await ask(admin, READ, { id: "workflow-1" });
    assert.deepEqual(stagesOf(one, "workflowDef"), [
      { escalateAfterDays: 0, remindEveryDays: 0, slaDays: null },
    ]);
    const committee = await ask(admin, READ, { id: "workflow-4" });
    assert.deepEqual(
      (stagesOf(committee, "workflowDef") as Record<string, number>[])[0],
      { escalateAfterDays: 2, remindEveryDays: 1, slaDays: 7 },
    );
  });
});
