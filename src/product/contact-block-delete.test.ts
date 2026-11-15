// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// deleteContactBlock, as the gateway and steward-core answer it: a library admin deletes the block
// and gets true; the join tables cascade, so a block a policy version links to is detached from
// every version rather than refused; an unknown block is NotFound; and, as no contact block change
// is audited, nothing is written to the audit log.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  query,
  type Signed,
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

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  return { code: body.errors?.[0]?.extensions.code, data: body.data ?? {} };
};

const DELETE = "mutation ($id: ID!) { deleteContactBlock(id: $id) }";
const BLOCKS = "query { contactBlocks(includeArchived: true) { id } }";
const LINKS = `query ($id: ID!) {
  policyVersionLinks(policyVersionId: $id) { contacts { id } }
}`;

const blockIds = async (signed: Signed) =>
  ((await ask(signed, BLOCKS)).data.contactBlocks as { id: string }[]).map(
    (b) => b.id,
  );

// policy-1's published version-2 links contact-block-3 then contact-block-1.
const PUBLISHED = "version-2";

describe("deleteContactBlock", () => {
  it("deletes the block for a library admin and answers true", async () => {
    const admin = await signInAs(base, "user-alice");
    assert.ok((await blockIds(admin)).includes("contact-block-2"));
    const answer = await ask(admin, DELETE, { id: "contact-block-2" });
    assert.equal(answer.code, undefined);
    assert.equal(answer.data.deleteContactBlock, true);
    assert.ok(!(await blockIds(admin)).includes("contact-block-2"));
    assert.ok(
      !stewardData().contactBlocks.some((b) => b.id === "contact-block-2"),
    );
  });

  it("detaches a block a policy version links to instead of refusing", async () => {
    const admin = await signInAs(base, "user-alice");
    const before = (
      (await ask(admin, LINKS, { id: PUBLISHED })).data.policyVersionLinks as {
        contacts: { id: string }[];
      }
    ).contacts.map((c) => c.id);
    assert.deepEqual(before, ["contact-block-3", "contact-block-1"]);
    const answer = await ask(admin, DELETE, { id: "contact-block-1" });
    assert.equal(answer.data.deleteContactBlock, true);
    const after = (
      (await ask(admin, LINKS, { id: PUBLISHED })).data.policyVersionLinks as {
        contacts: { id: string }[];
      }
    ).contacts.map((c) => c.id);
    assert.deepEqual(after, ["contact-block-3"]);
    for (const links of Object.values(stewardData().links))
      assert.ok(!links.contactBlockIds.includes("contact-block-1"));
  });

  it("writes no audit entry, as steward-core audits no contact block change", async () => {
    const admin = await signInAs(base, "user-alice");
    const audited = stewardData().audit.length;
    await ask(admin, DELETE, { id: "contact-block-2" });
    assert.equal(stewardData().audit.length, audited);
  });

  it("is NotFound for a block that does not exist, and for one already deleted", async () => {
    const admin = await signInAs(base, "user-alice");
    assert.equal(
      (await ask(admin, DELETE, { id: "contact-block-999" })).code,
      "NotFound",
    );
    await ask(admin, DELETE, { id: "contact-block-2" });
    assert.equal(
      (await ask(admin, DELETE, { id: "contact-block-2" })).code,
      "NotFound",
    );
  });

  it("is refused to someone who does not administer the library", async () => {
    const bob = await signInAs(base, "user-bob");
    const answer = await ask(bob, DELETE, { id: "contact-block-2" });
    assert.equal(answer.code, "PermissionDenied");
    assert.ok(
      stewardData().contactBlocks.some((b) => b.id === "contact-block-2"),
    );
  });
});
