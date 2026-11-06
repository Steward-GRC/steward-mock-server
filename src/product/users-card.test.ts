// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The Users card on /_mock for Steward: Roles is a dropdown of Steward's real roles, Groups a
// dropdown of the platform groups (and "Manages <group>"), and an info box says what each role and
// group grants, so none is a bare name. The roles and what they grant come from the same table the
// permissions resolvers use, so the legend can't drift from what a role does.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { platformGroups } from "#product/data/admin.ts";
import { ROLE_GRANTS } from "#product/resolvers/users.ts";
import { startForTests } from "#product/test-client.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});

const card = async () => {
  const html = await (await fetch(`${base}/_mock`)).text();
  const from = html.indexOf('id="users"');
  return html.slice(from, html.indexOf("</section>", from));
};

describe("the Users card", () => {
  it("picks roles from Steward's real roles, root included", async () => {
    const html = await card();
    assert.match(html, /<details class="choices" id="user-roles"/);
    for (const role of [...Object.keys(ROLE_GRANTS), "root"])
      assert.match(
        html,
        new RegExp(`<input class="choice" type="checkbox" value="${role}"`),
        `${role} is a choice`,
      );
    assert.doesNotMatch(html, /<input id="user-roles"/);
  });

  it("says in the info box what each role grants", async () => {
    const html = await card();
    assert.match(html, /<aside class="info" id="users-legend"/);
    for (const [role, grants] of Object.entries(ROLE_GRANTS)) {
      const entry = new RegExp(`<dt>${role}</dt><dd>([^<]*)</dd>`).exec(html);
      assert.ok(entry, `${role} is explained`);
      for (const grant of grants)
        assert.ok(entry[1]?.includes(grant), `${role} says it grants ${grant}`);
    }
    assert.match(html, /<dt>root<\/dt><dd>[^<]*root admin/);
    assert.match(html, /<dt>\(no role\)<\/dt><dd>[^<]*reader/);
  });

  it("picks groups from the platform groups and says how they work", async () => {
    const html = await card();
    for (const { name } of platformGroups()) {
      assert.match(html, new RegExp(`value="${name}"`));
      assert.match(html, new RegExp(`value="Manages ${name}"`));
      assert.match(html, new RegExp(`<dt>${name}</dt>`));
    }
    assert.match(html, /<dt>Manages &lt;group&gt;<\/dt>/);
  });
});
