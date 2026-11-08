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

  it("refuses a file whose bytes don't match its name, whatever it claims to be", async () => {
    const text = await upload(
      new TextEncoder().encode("just some words"),
      "notes.png",
      "image/png",
    );
    assert.equal(text.status, 400);
    assert.match(String(text.body.error), /do not match/);
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

// Ordinary attachments for the File card (steward-core#36 proposes the list; this is the demo's).
const PDF = bytesOf("%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n1 0 obj");
const OLE = bytesOf(
  "\u00D0\u00CF\u0011\u00E0\u00A1\u00B1\u001A\u00E1\u0000\u0000",
);
const zipWith = (...names: string[]) =>
  bytesOf(`PK\u0003\u0004${names.join("\u0000PK\u0001\u0002")}`);
const DOCX = zipWith("[Content_Types].xml", "word/document.xml");
const XLSX = zipWith("[Content_Types].xml", "xl/workbook.xml");
const PPTX = zipWith("[Content_Types].xml", "ppt/presentation.xml");
const MP4 = bytesOf("\u0000\u0000\u0000\u0018ftypmp42\u0000\u0000\u0000\u0000");
const MOV = bytesOf("\u0000\u0000\u0000\u0014ftypqt  \u0000\u0000\u0000\u0000");
const WEBM = bytesOf("\u001AE\u00DF\u00A3\u0001\u0000");
const text = (words: string) => new TextEncoder().encode(words);

describe("POST /api/assets with attachment files", () => {
  const accepted: [string, Uint8Array, string, string][] = [
    ["report.pdf", PDF, "application/pdf", "application/pdf"],
    ["letter.doc", OLE, "application/msword", "application/msword"],
    ["sheet.xls", OLE, "application/vnd.ms-excel", "application/vnd.ms-excel"],
    [
      "deck.ppt",
      OLE,
      "application/vnd.ms-powerpoint",
      "application/vnd.ms-powerpoint",
    ],
    [
      "letter.docx",
      DOCX,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ],
    [
      "sheet.xlsx",
      XLSX,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
    [
      "deck.pptx",
      PPTX,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/octet-stream",
    ],
    ["clip.mp4", MP4, "video/mp4", "video/mp4"],
    ["clip.mov", MOV, "video/quicktime", "video/quicktime"],
    ["clip.webm", WEBM, "video/webm", "video/webm"],
    [
      "notes.txt",
      text("Visitors sign in.\n"),
      "text/plain; charset=utf-8",
      "text/plain",
    ],
    [
      "notes.md",
      text("# Title\n\n- one\n"),
      "text/markdown; charset=utf-8",
      "text/markdown",
    ],
    ["rows.csv", text("a,b\n1,2\n"), "text/csv; charset=utf-8", "text/csv"],
  ];

  for (const [name, data, stored, declared] of accepted) {
    it(`keeps ${name} and serves it back as a download`, async () => {
      const sent = await upload(data, name, declared);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body.contentType, stored);
      assert.equal(sent.body.filename, name);
      const got = await fetch(`${base}${String(sent.body.url)}`, {
        headers: headersFor(erin),
      });
      assert.equal(got.status, 200);
      assert.equal(got.headers.get("content-type"), stored);
      assert.match(
        String(got.headers.get("content-disposition")),
        new RegExp(
          `^attachment; filename="${name.replace(".", String.raw`\.`)}"`,
        ),
      );
      assert.equal(got.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(new Uint8Array(await got.arrayBuffer()), data);
    });
  }

  it("keeps serving an image inline", async () => {
    const sent = await upload(PNG);
    const got = await fetch(`${base}${String(sent.body.url)}`, {
      headers: headersFor(erin),
    });
    assert.equal(got.headers.get("content-disposition"), null);
  });

  it("takes the kind from the bytes, and refuses a name that says something else", async () => {
    const asPdf = await upload(DOCX, "letter.pdf", "application/pdf");
    assert.equal(asPdf.status, 400);
    assert.match(String(asPdf.body.error), /do not match/);
    const asTxt = await upload(PDF, "notes.txt", "text/plain");
    assert.equal(asTxt.status, 400);
    const asDocx = await upload(OLE, "letter.docx", "application/octet-stream");
    assert.equal(asDocx.status, 400);
  });

  it("refuses never-allowed kinds, even renamed", async () => {
    const refused: [string, Uint8Array][] = [
      ["page.html", text("<!DOCTYPE html><html><body>hi</body></html>")],
      ["notes.txt", text("<html><script>alert(1)</script></html>")],
      ["report.pdf", text("<html><body>not a pdf</body></html>")],
      ["image.svg", text('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ["data.xml", text('<?xml version="1.0"?><a/>')],
      ["run.sh", text("#!/bin/sh\necho hi\n")],
      ["notes.txt", text("#!/bin/sh\necho hi\n")],
      ["setup.exe", bytesOf("MZ\u0090\u0000\u0003\u0000")],
      ["report.pdf", bytesOf("MZ\u0090\u0000\u0003\u0000")],
      ["tool.bin", bytesOf("\u007FELF\u0002\u0001\u0001")],
      [
        "macro.docm",
        zipWith(
          "[Content_Types].xml",
          "word/document.xml",
          "word/vbaProject.bin",
        ),
      ],
      [
        "letter.docx",
        zipWith(
          "[Content_Types].xml",
          "word/document.xml",
          "word/vbaProject.bin",
        ),
      ],
      ["bundle.zip", bytesOf("PK\u0003\u0004data.txt")],
    ];
    for (const [name, data] of refused) {
      const answer = await upload(data, name, "application/octet-stream");
      assert.equal(answer.status, 400, `${name} should be refused`);
    }
  });

  it("applies the same size cap to files, and the Uploads fail switch", async () => {
    await control(base, { kind: "asset-limit", limit: "small" });
    const big = await upload(
      Uint8Array.from([...PDF, ...new Uint8Array(101 << 10)]),
      "big.pdf",
      "application/pdf",
    );
    assert.equal(big.status, 400);
    assert.match(String(big.body.error), /too large/);
    await control(base, { kind: "asset-limit", limit: "real" });
    await control(base, { kind: "asset-upload", mode: "fail" });
    const failed = await upload(PDF, "r.pdf", "application/pdf");
    assert.equal(failed.status, 503);
  });
});
