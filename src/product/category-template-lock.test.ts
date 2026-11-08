// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// A category can lock its default template (steward-web#262, steward-core#38, steward-gateway#88):
// a policy created under it, or under a category that inherits its template, must use that
// template, so freeform and any other template are refused, at creation and afterwards. Only a
// site admin sets the lock, and it needs a default template to lock.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

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

const as = (user: string) => signInAs(base, `user-${user}`);

const LOCK = `mutation ($id: ID!, $locked: Boolean!) {
  setCategoryTemplateLock(id: $id, locked: $locked) { id defaultTemplateId defaultTemplateLocked }
}`;
const CREATE = `mutation ($homeCategoryId: ID!, $templateId: ID) {
  createPolicy(homeCategoryId: $homeCategoryId, templateId: $templateId, sensitivity: STANDARD, title: "A document") {
    id templateId templateNone
  }
}`;
const SET_TEMPLATE = `mutation ($policyId: ID!, $templateId: ID, $none: Boolean!) {
  setPolicyTemplate(policyId: $policyId, templateId: $templateId, none: $none) { id templateId templateNone }
}`;

// Finance names Standard Policy (template-1) as its default; Expenses inherits it.
const FINANCE = "category-finance";
const EXPENSES = "category-expenses";

const lock = async (id = FINANCE) => {
  const answer = await ask(await as("alice"), LOCK, { id, locked: true });
  assert.equal(answer.code, undefined, answer.message);
  return answer;
};

describe("setting the lock", () => {
  it("locks a category that names a default template", async () => {
    const answer = await lock();
    assert.deepEqual(answer.data.setCategoryTemplateLock, {
      defaultTemplateId: "template-1",
      defaultTemplateLocked: true,
      id: FINANCE,
    });
  });

  it("is for a site admin", async () => {
    const answer = await ask(await as("bob"), LOCK, {
      id: FINANCE,
      locked: true,
    });
    assert.equal(answer.code, "PermissionDenied");
  });

  it("needs a default template to lock", async () => {
    const answer = await ask(await as("alice"), LOCK, {
      id: "category-travel",
      locked: true,
    });
    assert.equal(answer.code, "FailedPrecondition");
  });

  it("can be lifted again", async () => {
    await lock();
    const answer = await ask(await as("alice"), LOCK, {
      id: FINANCE,
      locked: false,
    });
    assert.equal(
      (
        answer.data.setCategoryTemplateLock as {
          defaultTemplateLocked: boolean;
        }
      ).defaultTemplateLocked,
      false,
    );
  });
});

describe("creating under a locked category", () => {
  it("uses the category's template when none is asked for", async () => {
    await lock();
    const answer = await ask(await as("bob"), CREATE, {
      homeCategoryId: FINANCE,
    });
    assert.equal(answer.code, undefined, answer.message);
    // it follows the category's template rather than naming its own, so it is not freeform
    assert.equal(
      (answer.data.createPolicy as { templateNone: boolean }).templateNone,
      false,
    );
  });

  it("accepts the locked template when it is named", async () => {
    await lock();
    const answer = await ask(await as("bob"), CREATE, {
      homeCategoryId: FINANCE,
      templateId: "template-1",
    });
    assert.equal(answer.code, undefined, answer.message);
  });

  it("refuses another template", async () => {
    await lock();
    const answer = await ask(await as("bob"), CREATE, {
      homeCategoryId: FINANCE,
      templateId: "template-2",
    });
    assert.equal(answer.code, "FailedPrecondition");
    assert.match(answer.message ?? "", /requires/);
  });

  it("holds under a category that inherits the template", async () => {
    await lock();
    const answer = await ask(await as("alice"), CREATE, {
      homeCategoryId: EXPENSES,
      templateId: "template-3",
    });
    assert.equal(answer.code, "FailedPrecondition");
  });

  it("lets any template through once the lock is lifted", async () => {
    await lock();
    await ask(await as("alice"), LOCK, { id: FINANCE, locked: false });
    const answer = await ask(await as("bob"), CREATE, {
      homeCategoryId: FINANCE,
      templateId: "template-2",
    });
    assert.equal(answer.code, undefined, answer.message);
  });
});

const made = async () => {
  const answer = await ask(await as("bob"), CREATE, {
    homeCategoryId: FINANCE,
  });
  assert.equal(answer.code, undefined, answer.message);
  return (answer.data.createPolicy as { id: string }).id;
};

describe("changing the template afterwards", () => {
  it("refuses freeform and another template, and allows the locked one", async () => {
    const policyId = await made();
    await lock();
    const author = await as("bob");
    const none = await ask(author, SET_TEMPLATE, { none: true, policyId });
    assert.equal(none.code, "FailedPrecondition");
    const other = await ask(author, SET_TEMPLATE, {
      none: false,
      policyId,
      templateId: "template-2",
    });
    assert.equal(other.code, "FailedPrecondition");
    const same = await ask(author, SET_TEMPLATE, {
      none: false,
      policyId,
      templateId: "template-1",
    });
    assert.equal(same.code, undefined, same.message);
  });
});
