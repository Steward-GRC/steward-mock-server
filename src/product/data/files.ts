// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The files the seeded documents attach (bug log 214): a PDF and an image, with
// real bytes so a download opens. seedAssets() records them in the asset store on every reset.

import { crc32, deflateSync } from "node:zlib";

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

const WIDTH = 480;
const HEIGHT = 270;

type Rectangle = [number, number, number, number, string];

/** A flat picture of a booking portal's home screen, drawn from rectangles: [x, y, w, h, RRGGBB]. */
const SCREEN: Rectangle[] = [
  [0, 0, WIDTH, HEIGHT, "f3f1ec"],
  [0, 0, WIDTH, 36, "5b2a5e"],
  [16, 10, 90, 16, "e9dcea"],
  [330, 10, 134, 16, "8a5a8d"],
  [40, 62, 400, 30, "ffffff"],
  [52, 72, 120, 10, "c9c4bb"],
  [40, 110, 124, 110, "ffffff"],
  [40, 110, 124, 8, "3d7f6a"],
  [52, 134, 60, 10, "2b2b2b"],
  [52, 154, 100, 8, "c9c4bb"],
  [52, 170, 90, 8, "c9c4bb"],
  [178, 110, 124, 110, "ffffff"],
  [178, 110, 124, 8, "3b6ea5"],
  [190, 134, 60, 10, "2b2b2b"],
  [190, 154, 100, 8, "c9c4bb"],
  [190, 170, 90, 8, "c9c4bb"],
  [316, 110, 124, 110, "ffffff"],
  [316, 110, 124, 8, "c7792b"],
  [328, 134, 60, 10, "2b2b2b"],
  [328, 154, 100, 8, "c9c4bb"],
  [328, 170, 90, 8, "c9c4bb"],
  [340, 190, 88, 22, "5b2a5e"],
];

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
};

/** A PNG without metadata: RGB, one filter byte per row, deflated. */
const png = (rectangles: Rectangle[]): Uint8Array => {
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (WIDTH * 3 + 1);
    for (let x = 0; x < WIDTH; x++) {
      const hit = rectangles.findLast(
        ([left, top, width, height]) =>
          x >= left && x < left + width && y >= top && y < top + height,
      );
      const colour = hit?.[4] ?? "ffffff";
      raw.set(Buffer.from(colour, "hex"), row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
};

const PNG = png(SCREEN);

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
