// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The files the seeded documents attach (bug log 214): a PDF and an image, with
// real bytes so a download opens. seedAssets() records them in the asset store on every reset.

import type { StoredAsset } from "#product/assets.ts";

import { keepBytes } from "#product/assets.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const pdf = (line: string): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const content = `BT /F1 18 Tf 72 760 Td (${line}) Tj ET`;
  objects.push(
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  );
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return encode(body);
};

/** The zip format's signatures: PK\x03\x04, PK\x01\x02 and PK\x05\x06 as little-endian numbers. */
/** A one-pixel PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

interface SeedFile {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  id: string;
}

const files = (): SeedFile[] => [
  {
    bytes: pdf("Steward mock: supplier terms"),
    contentType: "application/pdf",
    filename: "supplier-terms.pdf",
    id: "asset-seed-1",
  },
  {
    bytes: PNG,
    contentType: "image/png",
    filename: "close-timeline.png",
    id: "asset-seed-2",
  },
];

/** The sizes the seeded file cards show. */
export const FILE_SIZES: Record<string, number> = Object.fromEntries(
  files().map((file) => [file.id, file.bytes.length]),
);

/** The seeded files' metadata; their bytes are kept in the asset store as a side effect. */
export const seedAssets = (): Record<string, StoredAsset> => {
  const stored: Record<string, StoredAsset> = {};
  for (const file of files()) {
    keepBytes(file.id, file.bytes);
    stored[file.id] = {
      contentType: file.contentType,
      createdBy: "user-bob",
      filename: file.filename,
      id: file.id,
      sizeBytes: file.bytes.length,
    };
  }
  return stored;
};
