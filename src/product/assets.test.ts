// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's editor image routes (internal/assets): POST /api/assets takes a multipart
// "file", keeps it, and answers {id, url, contentType, sizeBytes, filename}; GET /api/assets/{id}
// serves the bytes back. The limits and refusal texts are the gateway's and core's: 10 MiB, PNG,
// JPEG, GIF and WebP only (sniffed from the bytes, never the declared type). A /_mock switch makes
// the next uploads fail, and another lowers the size cap so the too-large error can be tried.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { MAX_ASSET_BYTES } from "#product/assets.ts";
import {
  control,
  headersFor,
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { signInAs } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let erin: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  erin = await signInAs(base, "user-erin");
});

const bytesOf = (text: string) => Uint8Array.from(Buffer.from(text, "latin1"));
const PNG = bytesOf("\u0089PNG\r\n\u001A\n\u0001\u0002\u0003\u0004");
const JPEG = bytesOf("\u00FF\u00D8\u00FF\u00E0\u0000\u0010JF");
const GIF = bytesOf("GIF89a\u0001\u0000\u0001\u0000");
const WEBP = bytesOf("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ");

const upload = async (
  data: Uint8Array,
  name = "pic.png",
  declared = "image/png",
  signed: null | Signed = erin,
) => {
  const form = new FormData();
  form.append("file", new Blob([data as BlobPart], { type: declared }), name);
  const answer = await fetch(`${base}/api/assets`, {
    body: form,
    headers: signed ? headersFor(signed) : {},
    method: "POST",
  });
  return {
    body: (await answer.json()) as Record<string, unknown>,
    status: answer.status,
  };
};

describe("POST /api/assets", () => {
  it("keeps an image and serves the same bytes back at its url", async () => {
    const stored = await upload(PNG, "logo.png");
    assert.equal(stored.status, 200);
    assert.deepEqual(
      { ...stored.body, id: "x", url: "x" },
      {
        contentType: "image/png",
        filename: "logo.png",
        id: "x",
        sizeBytes: PNG.length,
        url: "x",
      },
    );
    assert.equal(stored.body.url, `/api/assets/${String(stored.body.id)}`);

    const back = await fetch(`${base}${String(stored.body.url)}`, {
      headers: headersFor(erin),
    });
    assert.equal(back.status, 200);
    assert.equal(back.headers.get("content-type"), "image/png");
    assert.equal(back.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await back.arrayBuffer()), PNG);
  });

  it("accepts JPEG, GIF and WebP, and takes the type from the bytes", async () => {
    for (const [data, type] of [
      [JPEG, "image/jpeg"],
      [GIF, "image/gif"],
      [WEBP, "image/webp"],
    ] as const) {
      // Declared as something else on purpose: the bytes decide.
      const stored = await upload(data, "x", "application/octet-stream");
      assert.equal(stored.status, 200);
      assert.equal(stored.body.contentType, type);
    }
  });

  it("refuses a file that isn't an allowed image, whatever it claims to be", async () => {
    const text = await upload(
      new TextEncoder().encode("just some words"),
      "notes.png",
      "image/png",
    );
    assert.equal(text.status, 400);
    assert.match(String(text.body.error), /unsupported content type/);
    assert.match(
      String(text.body.error),
      /image\/gif, image\/jpeg, image\/png, image\/webp/,
    );
    const svg = await upload(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "a.svg",
      "image/svg+xml",
    );
    assert.equal(svg.status, 400);
  });

  it("refuses an empty file and a request with no file", async () => {
    const empty = await upload(new Uint8Array());
    assert.equal(empty.status, 400);
    assert.match(String(empty.body.error), /empty/i);
    const answer = await fetch(`${base}/api/assets`, {
      body: new FormData(),
      headers: headersFor(erin),
      method: "POST",
    });
    assert.equal(answer.status, 400);
    assert.match(
      String(((await answer.json()) as { error: string }).error),
      /Missing file/,
    );
  });

  it("refuses a file over the size cap with the gateway's text", async () => {
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    big.set(PNG);
    const refused = await upload(big);
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /too large.*10 MB/);
    const atCap = new Uint8Array(MAX_ASSET_BYTES);
    atCap.set(PNG);
    assert.equal((await upload(atCap)).status, 200);
  });

  it("needs a session, and the CSRF token that goes with a cookie", async () => {
    assert.equal((await upload(PNG, "a.png", "image/png", null)).status, 401);
    const browser = await signIn(base, "erin");
    const noCsrf = await fetch(`${base}/api/assets`, {
      body: (() => {
        const form = new FormData();
        form.append("file", new Blob([PNG as BlobPart]), "a.png");
        return form;
      })(),
      headers: { cookie: browser.cookie },
      method: "POST",
    });
    assert.equal(noCsrf.status, 403);
    // The same cookie reads an image without the token, as an <img src> does.
    const stored = await upload(PNG, "a.png", "image/png", browser);
    assert.equal(stored.status, 200);
    const img = await fetch(`${base}${String(stored.body.url)}`, {
      headers: { cookie: browser.cookie },
    });
    assert.equal(img.status, 200);
  });
});

describe("GET /api/assets/{id}", () => {
  it("answers 404 for an id that was never stored, and 401 without a session", async () => {
    const missing = await fetch(`${base}/api/assets/nope`, {
      headers: headersFor(erin),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Asset not found" });
    const stored = await upload(PNG);
    const anon = await fetch(`${base}${String(stored.body.url)}`);
    assert.equal(anon.status, 401);
  });

  it("forgets the images on Start fresh", async () => {
    const stored = await upload(PNG);
    startFresh();
    const again = await signInAs(base, "user-erin");
    const gone = await fetch(`${base}${String(stored.body.url)}`, {
      headers: headersFor(again),
    });
    assert.equal(gone.status, 404);
  });
});

describe("the /_mock upload switches", () => {
  it("makes uploads fail the way a store that is down does, until switched back", async () => {
    await control(base, { kind: "asset-upload", mode: "fail" });
    const failed = await upload(PNG);
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { error: "Failed to store image" });
    await control(base, { kind: "asset-upload", mode: "ok" });
    assert.equal((await upload(PNG)).status, 200);
  });

  it("lowers the size cap so a small file is too large, and restores it", async () => {
    await control(base, { kind: "asset-limit", limit: "small" });
    const refused = await upload(
      new Uint8Array(200_000)
        .fill(0)
        .map((_, index) => (index < PNG.length ? PNG[index]! : 0)),
    );
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /too large.*100 KB/);
    await control(base, { kind: "asset-limit", limit: "real" });
    assert.equal((await upload(PNG)).status, 200);
  });

  it("is on the /_mock page as buttons", async () => {
    const html = (await (await fetch(`${base}/_mock/controls`)).json()) as {
      actions: { kind: string }[];
    };
    assert.ok(html.actions.some((a) => a.kind === "asset-upload"));
    assert.ok(html.actions.some((a) => a.kind === "asset-limit"));
  });
});
