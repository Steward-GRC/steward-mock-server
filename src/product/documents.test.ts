// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's reference-document routes (internal/documents), which Generate with AI uses:
// POST /documents/extract turns an upload into plain text, and POST /documents/validate-url
// checks a URL. The shapes, limits and refusal texts are the gateway's.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import type { RunningMockServer } from "#core/server.ts";

import {
  headersFor,
  post,
  type Signed,
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

const upload = async (
  name: string,
  data: string | Uint8Array,
  field = "file",
  signed: null | Signed = erin,
) => {
  const form = new FormData();
  form.append(field, new Blob([data as BlobPart]), name);
  const answer = await fetch(`${base}/documents/extract`, {
    body: form,
    headers: signed ? headersFor(signed) : {},
    method: "POST",
  });
  return {
    body: (await answer.json()) as Record<string, unknown>,
    status: answer.status,
  };
};

/** Zip's record signatures ("PK\x03\x04" and so on), little-endian. */
const LOCAL_HEADER = Buffer.from("PK\u0003\u0004", "latin1").readUInt32LE(0);
const CENTRAL_HEADER = Buffer.from("PK\u0001\u0002", "latin1").readUInt32LE(0);
const END_OF_DIRECTORY = Buffer.from("PK\u0005\u0006", "latin1").readUInt32LE(
  0,
);

/** The OLE compound-file signature a legacy Word file starts with. */
const OLE_MAGIC = [...Buffer.from("d0cf11e0a1b11ae1", "hex")];

/** A zip archive of the given entries, the first stored and the rest deflated. */
const zip = (entries: [string, string][]): Uint8Array => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [index, [name, text]] of entries.entries()) {
    const raw = Buffer.from(text);
    const method = index === 0 ? 0 : 8;
    const stored = method === 0 ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Desk zones</w:t></w:r></w:p>
<w:p><w:r><w:t>Quiet zone</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">floor 2 &amp; 3</w:t></w:r></w:p>
</w:body></w:document>`;

describe("POST /documents/extract", () => {
  it("reads a text or markdown file, normalising its whitespace", async () => {
    assert.deepEqual(
      await upload(
        "Desk notes.md",
        "# Desk zones\n\n  Quiet zone,\tteam zone.\u0007\n",
      ),
      {
        body: {
          content: "# Desk zones Quiet zone, team zone.",
          title: "Desk notes",
        },
        status: 200,
      },
    );
  });

  it("reads a Word document's paragraphs and runs", async () => {
    const docx = zip([
      ["[Content_Types].xml", "<Types/>"],
      ["word/document.xml", DOCUMENT_XML],
    ]);
    assert.deepEqual(await upload("Zones.docx", docx), {
      body: { content: "Desk zones Quiet zone floor 2 & 3", title: "Zones" },
      status: 200,
    });
  });

  it("refuses a Word document that isn't one, or has no body", async () => {
    assert.deepEqual(await upload("Broken.docx", "not a zip"), {
      body: {
        error:
          "This file doesn't look like a valid Word (.docx) file — check the file and try again",
      },
      status: 400,
    });
    assert.deepEqual(await upload("Empty.docx", zip([["other.xml", "<x/>"]])), {
      body: {
        error:
          "This .docx file is missing word/document.xml — it may be corrupt",
      },
      status: 400,
    });
  });

  it("reads RTF text, skipping its font and colour tables, and drops a lone escaped byte as the gateway does", async () => {
    const rtf =
      String.raw`{\rtf1\ansi{\fonttbl{\f0 Times;}}{\colortbl;\red0\green0\blue0;}` +
      String.raw`\f0 Desk zones\par Quiet \'e9 zone\tab two\}}`;
    assert.deepEqual(await upload("Zones.rtf", rtf), {
      body: { content: "Desk zones Quiet zone two}", title: "Zones" },
      status: 200,
    });
  });

  it("answers the fixed sample text for a PDF or a legacy Word file, which it can't parse", async () => {
    const pdf = await upload("Guide.pdf", "%PDF-1.7\n...");
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.title, "Guide");
    assert.match(String(pdf.body.content), /^Sample reference document/);
    const document = await upload(
      "Old.doc",
      new Uint8Array([...OLE_MAGIC, 0, 0]),
    );
    assert.equal(document.status, 200);
    assert.match(String(document.body.content), /^Sample reference document/);
  });

  it("refuses a PDF, legacy Word or RTF file that isn't one", async () => {
    for (const [name, error] of [
      [
        "Fake.pdf",
        "This file doesn't look like a valid PDF — check the file and try again",
      ],
      [
        "Fake.doc",
        "This file doesn't look like a valid legacy Word (.doc) file — check the file and try again",
      ],
      [
        "Fake.rtf",
        "This file doesn't look like a valid RTF file — check the file and try again",
      ],
    ])
      assert.deepEqual(await upload(name ?? "", "plain words"), {
        body: { error },
        status: 400,
      });
  });

  it("refuses an unsupported type, a missing file and an oversized one", async () => {
    assert.deepEqual(await upload("Sheet.xlsx", "x"), {
      body: {
        error:
          "Unsupported file type: .xlsx — attach a PDF, Word (.docx or .doc), RTF, Markdown, or text file",
      },
      status: 400,
    });
    assert.deepEqual(await upload("Notes.txt", "x", "attachment"), {
      body: {
        error: 'Missing file — attach a single file under the "file" field',
      },
      status: 400,
    });
    assert.deepEqual(
      await upload("Big.txt", new Uint8Array(10 * 1024 * 1024 + 1)),
      {
        body: { error: "File too large — max upload size is 10 MB" },
        status: 400,
      },
    );
  });

  it("needs a signed-in session", async () => {
    assert.deepEqual(await upload("Notes.txt", "x", "file", null), {
      body: { error: "unauthorized" },
      status: 401,
    });
  });
});

const check = async (body: unknown, signed: null | Signed = erin) => {
  const answer = await fetch(`${base}/documents/validate-url`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(signed ? headersFor(signed) : {}),
    },
    method: "POST",
  });
  return {
    body: (await answer.json()) as Record<string, unknown>,
    status: answer.status,
  };
};

/** A host under the reserved .invalid name, which the mock answers as unreachable. */
const UNREACHABLE = ["gone", "invalid"].join(".");

describe("POST /documents/validate-url", () => {
  it("answers a public URL readable, titled from its host and path", async () => {
    assert.deepEqual(
      await check({ url: "https://standards.example.com/iso/27001" }),
      {
        body: {
          finalUrl: "https://standards.example.com/iso/27001",
          readable: true,
          title: "standards.example.com/iso/27001",
        },
        status: 200,
      },
    );
    assert.deepEqual(await check({ url: "  http://example.org/  " }), {
      body: {
        finalUrl: "http://example.org/",
        readable: true,
        title: "example.org",
      },
      status: 200,
    });
  });

  it("answers a sign-in page as needing a login", async () => {
    assert.deepEqual(
      await check({ url: "https://intranet.example.com/SignIn?next=/x" }),
      {
        body: {
          finalUrl: "https://intranet.example.com/SignIn?next=/x",
          readable: false,
          reason: "requires a login",
          title: "intranet.example.com/SignIn",
        },
        status: 200,
      },
    );
  });

  it("answers a .invalid host as unreachable, by the mock's convention", async () => {
    assert.deepEqual(await check({ url: `https://${UNREACHABLE}/page` }), {
      body: {
        readable: false,
        reason: "couldn't be reached",
        title: `${UNREACHABLE}/page`,
      },
      status: 200,
    });
  });

  it("refuses what the gateway refuses, before any fetch", async () => {
    const refusals: [unknown, string][] = [
      ["{", 'Malformed request — expected JSON {"url": "https://..."}'],
      [{ url: 5 }, 'Malformed request — expected JSON {"url": "https://..."}'],
      [{ url: "  " }, "Missing url — provide a URL to check"],
      [
        { url: "ftp://example.org/a" },
        'Unsupported URL scheme "ftp" — only http and https are allowed',
      ],
      [
        { url: "example.org/a" },
        'Unsupported URL scheme "" — only http and https are allowed',
      ],
      [{ url: "https:///path" }, "Invalid URL — missing host"],
      [
        { url: "http://localhost:8080/" },
        "This URL points to a blocked host — internal/local addresses are not allowed",
      ],
      [
        { url: "https://printer.internal/" }, // scrub:allow=fqdn
        "This URL points to a blocked host — internal/local addresses are not allowed",
      ],
      [
        { url: "http://10.1.2.3/" }, // scrub:allow=private-ip
        "This URL points to a blocked address — internal/private/link-local addresses are not allowed",
      ],
      [
        { url: "http://[::1]/" },
        "This URL points to a blocked address — internal/private/link-local addresses are not allowed",
      ],
      [
        { url: "http://169.254.169.254/latest" },
        "This URL points to a blocked address — internal/private/link-local addresses are not allowed",
      ],
    ];
    for (const [body, error] of refusals)
      assert.deepEqual(
        await check(body),
        { body: { error }, status: 400 },
        String(error),
      );
  });

  it("needs a signed-in session", async () => {
    assert.deepEqual(await check({ url: "https://example.org/" }, null), {
      body: { error: "unauthorized" },
      status: 401,
    });
  });
});

describe("a cookie session without its CSRF token", () => {
  it("is refused as the gateway refuses it", async () => {
    // The controls' one-step sign-in, so this doesn't depend on the sample passwords.
    const signed = await post(base, "/_mock/controls", {
      kind: "sign-in",
      personId: "user-bob",
    });
    const cookie =
      (signed.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    assert.match(cookie, /^steward_sid=/);
    const answer = await fetch(`${base}/documents/validate-url`, {
      body: JSON.stringify({ url: "https://example.org/" }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    });
    assert.equal(answer.status, 403);
    assert.deepEqual(await answer.json(), { error: "csrf" });
  });
});
