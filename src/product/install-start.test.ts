// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The new-install start state, end to end the way steward-web walks it: the clients ask whether
// setup is needed, the setup token and the first admin go to /setup/bootstrap, the admin signs in
// with those credentials and makes the first policy. A brand-new install has the basic setup
// (categories, templates, workflows, groups) and none of the sample people or documents.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { mockState } from "#core/state.ts";
import { stewardData } from "#product/data.ts";
import {
  control,
  post,
  query,
  SETUP_TOKEN,
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
  await control(base, { kind: "start-state", state: "sample" });
  await server.close();
});
beforeEach(() => startFresh());

const setupState = async () =>
  (await (await fetch(`${base}/setup/state`)).json()) as {
    needsSetup: boolean;
  };

const bootstrap = (body: Record<string, unknown>) =>
  post(base, "/setup/bootstrap", {
    email: "Root@Example.org",
    name: "Root Admin",
    password: "a-long-password",
    setupToken: SETUP_TOKEN,
    username: "Root",
    ...body,
  });

describe("Start as a new install", () => {
  it("is a clean install: the basic setup, no people, no documents", async () => {
    await control(base, { firstRun: true, kind: "fresh" });
    const data = stewardData();
    assert.deepEqual(data.people, []);
    assert.deepEqual(
      [data.policies, data.versions, data.runs, data.audit].map(
        (x) => x.length,
      ),
      [0, 0, 0, 0],
    );
    assert.deepEqual(
      [data.definitions, data.references, data.contactBlocks].map(
        (x) => x.length,
      ),
      [0, 0, 0],
      "the libraries are empty",
    );
    assert.ok(data.categories.length > 0, "the category tree stays");
    assert.ok(data.templates.length > 0, "templates stay");
    assert.ok(data.workflowDefs.length > 0, "workflows stay");
    assert.ok(data.platformGroups.length > 0, "groups stay");
    const people = new Set<string>();
    for (const category of data.categories) {
      for (const id of [
        ...category.owners,
        ...category.authorRule,
        ...category.approverRule,
      ])
        people.add(id);
    }
    for (const workflow of data.workflowDefs)
      for (const stage of workflow.stages)
        for (const id of [...stage.approvers, ...stage.vetoApproverIds])
          people.add(id);
    assert.deepEqual(
      [...people],
      [],
      "nothing names a person who is not there",
    );
    assert.equal((await setupState()).needsSetup, true);
  });

  it("walks setup, signs the new admin in and lets them make the first policy", async () => {
    await control(base, { firstRun: true, kind: "fresh" });

    assert.equal((await bootstrap({ setupToken: "wrong" })).status, 403);
    assert.equal((await bootstrap({ password: "" })).status, 400);
    assert.equal(
      (await setupState()).needsSetup,
      true,
      "a refusal changes nothing",
    );

    const done = await bootstrap({});
    assert.equal(done.status, 200);
    const { userId } = (await done.json()) as { userId: string };
    assert.ok(userId);
    assert.equal((await setupState()).needsSetup, false);
    assert.equal((await bootstrap({})).status, 409, "setup runs once");
    assert.equal(mockState.sessions.size, 0, "bootstrap signs nobody in");

    const admin = await signIn(base, "root", false, "a-long-password");
    assert.ok(
      admin.cookie,
      "the new admin signs in with the setup credentials",
    );
    const me = await query(base, "{ me { userId roles isRoot } }", admin);
    assert.equal(me.body.errors, undefined, JSON.stringify(me.body));
    const who = (
      me.body.data as {
        me: { isRoot: boolean; roles: string[]; userId: string };
      }
    ).me;
    assert.equal(who.userId, userId);
    assert.equal(who.isRoot, true, "the first admin is the root admin");
    assert.ok(who.roles.includes("site-admin"));

    const tree = await query(base, "{ categoryTree { id } }", admin);
    const [home] = (tree.body.data as { categoryTree: { id: string }[] })
      .categoryTree;
    assert.ok(home, "the category tree is there to file a policy under");
    const created = await query(
      base,
      `mutation ($home: ID!) {
        createPolicy(homeCategoryId: $home, title: "First policy", sensitivity: STANDARD) { id title }
      }`,
      admin,
      { home: home?.id },
    );
    assert.equal(created.body.errors, undefined, JSON.stringify(created.body));
    assert.equal(
      (created.body.data as { createPolicy: { title: string } }).createPolicy
        .title,
      "First policy",
    );
  });

  it("has none of the sample people to sign in as", async () => {
    await control(base, { firstRun: true, kind: "fresh" });
    const answer = await post(base, "/auth/login", {
      password: "alice-password",
      username: "alice",
    });
    assert.notEqual(answer.status, 200);
  });
});

describe("the new install start state", () => {
  it("is what Reset and Start fresh return to, setup included", async () => {
    await control(base, { kind: "start-state", state: "install" });
    assert.equal((await setupState()).needsSetup, true);
    await bootstrap({});
    assert.equal((await setupState()).needsSetup, false);
    await control(base, { kind: "reset" });
    assert.deepEqual(stewardData().people, []);
    assert.equal((await setupState()).needsSetup, true);
    await control(base, { kind: "fresh" });
    assert.equal((await setupState()).needsSetup, true);
  });

  it("leaves the demo and sample start states as they were", async () => {
    await control(base, { kind: "start-state", state: "install" });
    await control(base, { kind: "start-state", state: "demo" });
    assert.equal((await setupState()).needsSetup, false);
    assert.equal(stewardData().policies.length, 0);
    assert.ok(stewardData().people.some((p) => p.username === "alice"));
    await control(base, { kind: "start-state", state: "sample" });
    assert.ok(stewardData().policies.length > 0);
  });
});
