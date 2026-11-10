// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The docs start state: the data set the user guide's screenshots are taken from. Its ids and
// document numbers are what the guide names, so they are pinned here; the counts and the states
// each slot needs are checked, and so is the data's own integrity (every person exists, every quote
// a reviewer made is in the text it quotes, the drafts' sections are filled or empty as designed).

/* oxlint-disable unicorn-js/prevent-abbreviations -- "docs" is the start state's name */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import { changesSinceReview } from "#product/review-snapshots.ts";
import { parseContent } from "#product/sections.ts";
import {
  control,
  query,
  type Signed,
  startForTests,
} from "#product/test-client.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
  await control(base, { kind: "start-state", state: "docs" });
});
after(async () => {
  await control(base, { kind: "start-state", state: "sample" });
  await server.close();
});

const data = () => stewardData();

/** Signed in as one of the eight, in one step (the dev quick login's way). */
const signIn = async (_base: string, username: string): Promise<Signed> => {
  const answer = (await control(base, {
    kind: "sign-in",
    personId: `user-${username}`,
    token: true,
  })) as { accessToken?: string; token?: string };
  return { cookie: "", csrf: "", token: answer.accessToken ?? answer.token };
};
const byNumber = (number: string) => {
  const found = data().policies.find((p) => p.number === number);
  assert.ok(found, `no document ${number}`);
  return found;
};
const run = (number: string) =>
  data().runs.find((r) => r.policyId === byNumber(number).id);
const draftOf = (number: string) => {
  const policy = byNumber(number);
  return data().versions.find((v) => v.id === policy.currentDraftVersionId);
};
const sectionsOf = (contentJson: string) =>
  parseContent(contentJson) ?? new Map<string, string>();
/** A section's words after its heading line. */
const bodyOf = (contentJson: string, key: string) =>
  (sectionsOf(contentJson).get(key) ?? "")
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();

/** The documents and the slots that use them: the guide names these numbers. */
const NUMBERS = [
  "POL-EXPENSES-000001",
  "POL-RECORDS-000001",
  "PRC-TRAVEL-000001",
  "POL-FACILITIES-000001",
  "PRC-INCIDENT-000001",
  "POL-SECURITY-000001",
  "POL-SECURITY-000002",
  "POL-PEOPLE-000001",
  "PRC-PURCHASING-000001",
  "PRC-CONDUCT-000001",
  "POL-PURCHASING-000001",
  "POL-FACILITIES-000002",
  "POL-RECORDS-000002",
];

describe("the docs start state's data", () => {
  it("has the counts the guide relies on", () => {
    assert.deepEqual(
      {
        acknowledgements: data().acknowledgements.length,
        appendices: data().appendices.length,
        categories: data().categories.length,
        contacts: data().contactBlocks.length,
        definitions: data().definitions.length,
        people: data().people.length,
        policies: data().policies.length,
        references: data().references.length,
        reviewThreads: data().reviewThreads.length,
        runs: data().runs.length,
        versions: data().versions.length,
        workflows: data().workflowDefs.length,
      },
      {
        acknowledgements: 15,
        appendices: 3,
        categories: 15,
        contacts: 3,
        definitions: 5,
        people: 8,
        policies: 13,
        references: 3,
        reviewThreads: 4,
        runs: 12,
        versions: 17,
        workflows: 4,
      },
    );
  });

  it("keeps the document numbers the guide names, and nothing else numbered", () => {
    assert.deepEqual(
      data().policies.map((p) => p.number),
      NUMBERS,
    );
  });

  it("has the eight people and none of the sample's duplicates", () => {
    assert.deepEqual(
      data().people.map((p) => p.username),
      ["alice", "bob", "charlie", "dave", "erin", "frank", "grace", "heidi"],
    );
    for (const person of data().people) {
      assert.equal(
        person.secondFactor,
        false,
        `${person.username} has no second factor to enrol`,
      );
      assert.notEqual(person.disabled, true, `${person.username} is enabled`);
    }
  });

  it("only names people who exist, and documents that exist", () => {
    const people = new Set(data().people.map((p) => p.id));
    const versions = new Set(data().versions.map((v) => v.id));
    const policies = new Set(data().policies.map((p) => p.id));
    const who = (id: string, where: string) =>
      assert.ok(people.has(id), `${where} names ${id}, who is not there`);
    for (const category of data().categories) {
      for (const id of [
        ...category.owners,
        ...category.authorRule,
        ...category.approverRule,
      ])
        who(id, `category ${category.id}`);
      for (const rule of category.rules)
        if (rule.subjectKind === "USER")
          who(rule.subjectRef, `a rule of ${category.id}`);
    }
    for (const workflow of data().workflowDefs)
      for (const stage of workflow.stages)
        for (const id of [...stage.approvers, ...stage.vetoApproverIds])
          who(id, `workflow ${workflow.id}`);
    for (const run of data().runs) {
      assert.ok(
        versions.has(run.policyVersionId),
        `${run.id} runs over a version that exists`,
      );
      for (const stage of run.stages)
        for (const s of stage.seats) who(s.userId, run.id);
    }
    for (const policy of data().policies) {
      who(policy.ownerUserId, policy.number);
      for (const id of [
        policy.currentDraftVersionId,
        policy.currentPublishedVersionId,
      ])
        if (id) assert.ok(versions.has(id), `${policy.number} points at ${id}`);
    }
    for (const version of data().versions)
      assert.ok(
        policies.has(version.policyId),
        `${version.id} belongs to a policy`,
      );
    for (const ack of data().acknowledgements) {
      who(ack.userId, "an acknowledgement");
      assert.ok(versions.has(ack.policyVersionId));
    }
    for (const thread of data().reviewThreads) {
      who(thread.approverUserId, thread.id);
      for (const message of thread.messages)
        who(message.authorUserId, thread.id);
    }
  });

  it("quotes, in every reviewer thread, text that is in the version once", () => {
    for (const thread of data().reviewThreads) {
      const version = data().versions.find(
        (v) => v.id === thread.policyVersionId,
      );
      assert.ok(version, `${thread.id} is on a version that exists`);
      const text = [...sectionsOf(version.contentJson).values()].join("\n");
      assert.equal(
        text.split(thread.quote).length - 1,
        1,
        `${thread.id} quotes "${thread.quote}" exactly once`,
      );
    }
  });
});

describe("the states each guide screenshot needs", () => {
  it("has Bob's four drafts: half-written, ready, a revision, and one in the locked category", () => {
    const required = ["purpose", "scope", "policy-statement"];
    const half = draftOf("POL-FACILITIES-000002");
    assert.ok(half);
    assert.deepEqual(
      required.filter((key) => bodyOf(half.contentJson, key) === ""),
      ["policy-statement"],
      "one of three required sections is empty",
    );
    for (const number of ["POL-RECORDS-000002", "POL-EXPENSES-000001"]) {
      const draft = draftOf(number);
      assert.ok(draft);
      assert.equal(draft.status, "DRAFT");
      for (const key of required)
        assert.notEqual(
          bodyOf(draft.contentJson, key),
          "",
          `${number} fills ${key}`,
        );
    }
    // The revision is of a published document: that is what shows the Major, Minor, Fix block.
    assert.ok(byNumber("POL-EXPENSES-000001").currentPublishedVersionId);
    const locked = byNumber("POL-PURCHASING-000001");
    assert.equal(draftOf("POL-PURCHASING-000001")?.status, "DRAFT");
    const category = data().categories.find(
      (c) => c.id === locked.homeCategoryId,
    );
    assert.equal(category?.defaultTemplateLocked, true);
  });

  it("has a locked default template on Finance and an unlocked one on Information", () => {
    const finance = data().categories.find((c) => c.id === "category-finance");
    const information = data().categories.find(
      (c) => c.id === "category-information",
    );
    assert.equal(finance?.defaultTemplateLocked, true);
    assert.ok(finance?.defaultTemplateId);
    assert.equal(information?.defaultTemplateLocked, false);
    assert.ok(information?.defaultTemplateId);
  });

  it("has three levels, owners on the top level, and a category with no documents", () => {
    const depth = (id: string): number => {
      const parent = data().categories.find((c) => c.id === id)?.parentId;
      return parent ? 1 + depth(parent) : 1;
    };
    assert.equal(Math.max(...data().categories.map((c) => depth(c.id))), 3);
    for (const top of data().categories.filter((c) => c.parentId === null))
      assert.ok(top.owners.length > 0, `${top.name} has an owner`);
    assert.equal(
      data().policies.filter((p) => p.homeCategoryId === "category-devices")
        .length,
      0,
      "Devices is empty, for the Library's empty state",
    );
  });

  it("has the four workflows, one with two stages, a quorum and a veto", () => {
    assert.deepEqual(
      data().workflowDefs.map((w) => [w.name, w.stages.length]),
      [
        ["Single approver", 1],
        ["Two-stage review", 2],
        ["Committee with veto", 2],
        ["Executive review", 4],
      ],
    );
    const committee = data().workflowDefs.find(
      (w) => w.name === "Committee with veto",
    );
    assert.equal(committee?.vetoEnabled, true);
    assert.equal(committee?.stages[0]?.quorum, "majority");
  });

  it("has documents in review at stage 1 of 2, edited since a review, and a rejected one", () => {
    const remote = run("POL-PEOPLE-000001");
    assert.equal(remote?.stages.length, 2);
    assert.equal(remote?.currentStageIdx, 0);
    assert.equal(remote?.stages[0]?.seats[0]?.userId, "user-charlie");
    assert.equal(remote?.stages[0]?.seats[0]?.state, "pending");
    assert.equal(run("PRC-CONDUCT-000001")?.status, "APPROVAL_STATUS_REJECTED");
    const edited = draftOf("POL-SECURITY-000002");
    assert.ok(edited);
    const changed = changesSinceReview("user-charlie", edited);
    assert.equal(
      changed.filter((s) => s.changeType === "changed").length,
      2,
      "two sections changed since Charlie last reviewed",
    );
  });

  it("has Charlie's three approval lists, through the gateway as Charlie", async () => {
    const charlie = await signIn(base, "charlie");
    const answer = await query(
      base,
      "{ pendingTasks { policyTitle } upcomingApprovals { policyTitle stageName } }",
      charlie,
    );
    assert.equal(answer.body.errors, undefined, JSON.stringify(answer.body));
    const { pendingTasks, upcomingApprovals } = answer.body.data as {
      pendingTasks: { policyTitle: string }[];
      upcomingApprovals: { policyTitle: string; stageName: string }[];
    };
    assert.deepEqual(pendingTasks.map((t) => t.policyTitle).toSorted(), [
      "Acceptable Use Policy",
      "Remote Working Policy",
    ]);
    assert.deepEqual(upcomingApprovals, [
      {
        policyTitle: "Supplier Onboarding Procedure",
        stageName: "Security and finance",
      },
    ]);
    // In progress: a run still open whose seat Charlie has decided.
    const decided = data().runs.filter(
      (r) =>
        r.status === "APPROVAL_STATUS_IN_REVIEW" &&
        r.stages.some((s) =>
          s.seats.some(
            (x) => x.userId === "user-charlie" && x.state === "approved",
          ),
        ),
    );
    assert.deepEqual(
      decided.map((r) => byNumber("POL-SECURITY-000001").id === r.policyId),
      [true],
    );
  });

  it("has comments and suggested changes open, countered and agreed", () => {
    const states = data().reviewThreads.map((t) => {
      if (!t.suggestion) return "comment";
      if (t.suggestion.outcome === "AGREED") return "agreed";
      return t.suggestion.rounds.length > 1 ? "countered" : "open";
    });
    assert.deepEqual(states.toSorted(), [
      "agreed",
      "comment",
      "countered",
      "open",
    ]);
  });

  it("has Expense Claims with three published versions, and appendices in every state", () => {
    const policy = byNumber("POL-EXPENSES-000001");
    const published = data().versions.filter(
      (v) => v.policyId === policy.id && v.versionNo > 0,
    );
    assert.deepEqual(
      published.map((v) => v.versionNo),
      [1, 2, 3],
    );
    const [a, b, c] = data().appendices;
    assert.equal(a?.versions.filter((v) => v.state === "PUBLISHED").length, 2);
    assert.equal(
      a?.versions.some((v) => v.state === "DRAFT"),
      true,
    );
    assert.equal(
      b?.versions.every((v) => v.state === "DRAFT"),
      true,
      "B was never published",
    );
    assert.ok(c?.retiredAt, "C is retired");
  });

  it("has the libraries filled in and Records Retention linking to all four kinds", () => {
    assert.ok(data().definitions.length > 0);
    assert.ok(data().references.length > 0);
    assert.ok(data().contactBlocks.length > 0);
    const records = byNumber("POL-RECORDS-000001");
    for (const id of [
      records.currentPublishedVersionId,
      records.currentDraftVersionId,
    ]) {
      const links = id ? data().links[id] : undefined;
      assert.ok(links?.definitionIds.length, "a definition");
      assert.ok(links?.related.length, "a related policy");
      assert.ok(links?.referenceIds.length, "a reference");
      assert.ok(links?.contactBlockIds.length, "a contact");
    }
  });

  it("has a document Erin has not acknowledged, a sensitive one, and AI on", () => {
    const visitor = byNumber("POL-FACILITIES-000001");
    const acked = data().acknowledgements.filter(
      (a) => a.policyVersionId === visitor.currentPublishedVersionId,
    );
    assert.equal(
      acked.some((a) => a.userId === "user-erin"),
      false,
    );
    assert.ok(acked.length > 0, "everyone else did");
    assert.equal(byNumber("PRC-INCIDENT-000001").sensitivity, "SENSITIVE");
    assert.equal(data().aiSimulated, true);
  });

  it("starts a draft that Heidi can edit beside Bob (two people editing)", async () => {
    const heidi = await signIn(base, "heidi");
    const answer = await query(
      base,
      '{ policyByNumber(number: "POL-FACILITIES-000002") { number viewerCan { edit } } }',
      heidi,
    );
    assert.equal(answer.body.errors, undefined, JSON.stringify(answer.body));
    const found = (
      answer.body.data as { policyByNumber: { viewerCan: { edit: boolean } } }
    ).policyByNumber;
    assert.equal(found.viewerCan.edit, true);
  });
});

describe("Reset and Start fresh return to the docs state", () => {
  it("until another start state is chosen", async () => {
    await control(base, { kind: "reset" });
    assert.equal(data().policies.length, 13);
    await control(base, { kind: "fresh" });
    assert.equal(data().policies.length, 13);
  });
});
