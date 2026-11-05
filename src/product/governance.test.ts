// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Policy governance (steward-web's A11), as steward-gateway, steward-core and steward-delivery
// answer it: deleting a never-published policy, retiring one, changing its owner, moving it to
// another category under a new number, the PDF export and its download link, and magic links.

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
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

const alice = () => signInAs(base, "user-alice");
const bob = () => signInAs(base, "user-bob");
const erin = () => signInAs(base, "user-erin");

const lastAudit = () => stewardData().audit.at(-1);

const DELETE = `mutation ($id: ID!) { deletePolicy(id: $id) }`;
const RETIRE = `mutation ($id: ID!) { retirePolicy(id: $id) { id retiredAt } }`;
const OWNER = `mutation ($policyId: ID!, $ownerUserId: ID!) {
  setPolicyOwner(policyId: $policyId, ownerUserId: $ownerUserId) { id ownerUserId }
}`;
const MOVE = `mutation ($policyId: ID!, $homeCategoryId: ID!) {
  movePolicy(policyId: $policyId, homeCategoryId: $homeCategoryId) { id number homeCategoryId }
}`;
const EXPORT = `mutation ($id: ID!) { requestPDFExport(policyVersionId: $id) { jobId } }`;
const LINK = `query ($jobId: ID!) { pdfDownloadLink(jobId: $jobId) { signedUrl expiresAt } }`;
const MAGIC = `mutation ($id: ID!, $sensitive: Boolean!) {
  createMagicLink(policyVersionId: $id, sensitive: $sensitive) { token expiresAt }
}`;
const REVOKE = `mutation ($token: String!) { revokeMagicLink(token: $token) }`;

const LISTING = `query { policies(categoryId: "category-facilities") { id } }`;

describe("deletePolicy", () => {
  it("deletes a never-published policy for its author, and audits it", async () => {
    assert.deepEqual(
      (await ask(await bob(), DELETE, { id: "policy-5" })).data,
      {
        deletePolicy: true,
      },
    );
    assert.equal(
      stewardData().policies.some((p) => p.id === "policy-5"),
      false,
    );
    assert.equal(
      stewardData().versions.some((v) => v.policyId === "policy-5"),
      false,
    );
    assert.equal(lastAudit()?.action, "policy.deleted");
    assert.equal(lastAudit()?.subject, "policy:policy-5");
  });

  it("refuses a policy that was ever published", async () => {
    const { code, message } = await ask(await bob(), DELETE, {
      id: "policy-1",
    });
    assert.equal(code, "FailedPrecondition");
    assert.equal(
      message,
      "delete policy: PolicyStore.DeletePolicy policy-1: policy has a published version and cannot be deleted",
    );
  });

  it("refuses someone who can't author it, and an unknown policy", async () => {
    assert.equal(
      (await ask(await erin(), DELETE, { id: "policy-5" })).code,
      "PermissionDenied",
    );
    assert.equal(
      (await ask(await alice(), DELETE, { id: "policy-nowhere" })).code,
      "NotFound",
    );
  });
});

describe("retirePolicy", () => {
  it("retires a published policy, hides it from listings and ends its acknowledgements", async () => {
    const reader = await erin();
    const owed = await ask(reader, "query { myObligations { policyId } }");
    assert.ok(
      (owed.data.myObligations as { policyId: string }[]).some(
        (o) => o.policyId === "policy-10",
      ),
    );
    const retired = await ask(await bob(), RETIRE, { id: "policy-10" });
    assert.equal(retired.code, undefined);
    const { retiredAt } = retired.data.retirePolicy as { retiredAt: string };
    assert.match(retiredAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(lastAudit()?.action, "policy.retired");
    const listed = (await ask(reader, LISTING)).data.policies as {
      id: string;
    }[];
    assert.ok(!listed.some((p) => p.id === "policy-10"));
    const after = await ask(reader, "query { myObligations { policyId } }");
    assert.ok(
      !(after.data.myObligations as { policyId: string }[]).some(
        (o) => o.policyId === "policy-10",
      ),
    );
  });

  it("refuses someone who can't author it", async () => {
    assert.equal(
      (await ask(await erin(), RETIRE, { id: "policy-10" })).code,
      "PermissionDenied",
    );
  });
});

describe("setPolicyOwner", () => {
  it("lets a site admin change the owner, and audits it", async () => {
    const answer = await ask(await alice(), OWNER, {
      ownerUserId: "user-charlie",
      policyId: "policy-1",
    });
    assert.deepEqual(answer.data.setPolicyOwner, {
      id: "policy-1",
      ownerUserId: "user-charlie",
    });
    assert.equal(lastAudit()?.action, "policy.owner_changed");
  });

  it("is a site admin's alone, and needs a policy", async () => {
    assert.equal(
      (
        await ask(await bob(), OWNER, {
          ownerUserId: "user-bob",
          policyId: "policy-1",
        })
      ).code,
      "PermissionDenied",
    );
    assert.equal(
      (
        await ask(await alice(), OWNER, {
          ownerUserId: "user-bob",
          policyId: "policy-nowhere",
        })
      ).code,
      "NotFound",
    );
  });
});

describe("movePolicy", () => {
  it("moves a policy and renumbers it in the target category's sequence", async () => {
    const answer = await ask(await alice(), MOVE, {
      homeCategoryId: "category-travel",
      policyId: "policy-9",
    });
    assert.deepEqual(answer.data.movePolicy, {
      homeCategoryId: "category-travel",
      id: "policy-9",
      number: "POL-TRAVEL-000002",
    });
    assert.equal(lastAudit()?.action, "policy.moved");
  });

  it("does nothing for the category it's in already", async () => {
    const audited = stewardData().audit.length;
    const answer = await ask(await alice(), MOVE, {
      homeCategoryId: "category-facilities",
      policyId: "policy-9",
    });
    assert.deepEqual(answer.data.movePolicy, {
      homeCategoryId: "category-facilities",
      id: "policy-9",
      number: "POL-FACILITIES-000001",
    });
    assert.equal(stewardData().audit.length, audited);
  });

  it("refuses an unknown category and a non-admin", async () => {
    const unknown = await ask(await alice(), MOVE, {
      homeCategoryId: "category-nowhere",
      policyId: "policy-9",
    });
    assert.equal(unknown.code, "NotFound");
    assert.equal(unknown.message, "target category not found");
    assert.equal(
      (
        await ask(await bob(), MOVE, {
          homeCategoryId: "category-travel",
          policyId: "policy-9",
        })
      ).code,
      "PermissionDenied",
    );
  });
});

describe("the PDF export", () => {
  it("answers a job, then a link to a sample PDF the mock serves", async () => {
    const reader = await erin();
    const job = await ask(reader, EXPORT, { id: "version-11" });
    const { jobId } = job.data.requestPDFExport as { jobId: string };
    assert.match(jobId, /^pdf-version-11-\d+$/);
    const link = await ask(reader, LINK, { jobId });
    const { expiresAt, signedUrl } = link.data.pdfDownloadLink as {
      expiresAt: string;
      signedUrl: string;
    };
    const lifetime = Date.parse(expiresAt) - Date.now();
    assert.ok(lifetime > 14 * 60_000 && lifetime <= 15 * 60_000, expiresAt);
    const url = new URL(signedUrl);
    assert.equal(url.pathname, `/delivery/pdf/${jobId}.pdf`);
    const pdf = await fetch(`${base}${url.pathname}${url.search}`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.match(await pdf.text(), /^%PDF-/);
  });

  it("refuses an unknown or empty job, and a version the reader can't read in full", async () => {
    const reader = await erin();
    const unknown = await ask(reader, LINK, { jobId: "pdf-nowhere" });
    assert.equal(unknown.code, "PDF_EXPORT_NOT_FOUND");
    assert.equal(unknown.message, "That PDF export doesn't exist.");
    const empty = await ask(reader, LINK, { jobId: "" });
    assert.equal(empty.code, "INVALID_REQUEST");
    assert.equal(empty.message, "job_id is required.");
    const obfuscated = await ask(await alice(), EXPORT, { id: "version-9" });
    assert.equal(obfuscated.code, "NotFound");
    assert.equal(obfuscated.message, "policy version not found");
  });
});

describe("magic links", () => {
  it("makes a link that lasts 30 days, or 48 hours for a sensitive one, and audits it", async () => {
    const reader = await erin();
    const plain = (
      await ask(reader, MAGIC, { id: "version-11", sensitive: false })
    ).data.createMagicLink as { expiresAt: string; token: string };
    assert.match(plain.token, /^[\da-f]{64}$/);
    const days = (Date.parse(plain.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, plain.expiresAt);
    assert.equal(lastAudit()?.action, "magic_link.created");
    assert.equal(lastAudit()?.subject, "policy_version:version-11");
    const sensitive = (
      await ask(reader, MAGIC, { id: "version-11", sensitive: true })
    ).data.createMagicLink as { expiresAt: string };
    const hours = (Date.parse(sensitive.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours > 47.9 && hours <= 48, sensitive.expiresAt);
  });

  it("revokes a link for a site admin, and audits it", async () => {
    const { token } = (
      await ask(await erin(), MAGIC, { id: "version-11", sensitive: false })
    ).data.createMagicLink as { token: string };
    assert.deepEqual((await ask(await alice(), REVOKE, { token })).data, {
      revokeMagicLink: true,
    });
    assert.equal(lastAudit()?.action, "magic_link.revoked");
    assert.match(lastAudit()?.subject ?? "", /^magic_link:[\da-f]{16}$/);
  });

  it("refuses a non-admin's revoke, an empty token, and an unreadable version", async () => {
    assert.equal(
      (await ask(await erin(), REVOKE, { token: "x" })).code,
      "PermissionDenied",
    );
    assert.equal(
      (await ask(await alice(), REVOKE, { token: "" })).code,
      "INVALID_REQUEST",
    );
    assert.equal(
      (await ask(await alice(), MAGIC, { id: "version-9", sensitive: true }))
        .code,
      "NotFound",
    );
  });
});
