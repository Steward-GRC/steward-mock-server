// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-delivery's PDF exports and magic links (internal/grpcsvc/delivery.go, internal/magiclink).
// There's no renderer or object store behind the mock: an export is ready as soon as it's asked
// for, and its signed URL points at GET /delivery/pdf/<jobId>.pdf here, which serves one small
// sample PDF for every job. The jobs and links are part of the data, so a reset clears them.

import { createHash, randomBytes } from "node:crypto";

import { settings } from "#core/product.ts";
import { stewardData } from "#product/data.ts";

/** delivery's PDF_LINK_TTL default. */
export const PDF_LINK_MS = 15 * 60_000;
/** delivery's MAGIC_LINK_NONSENSITIVE_TTL and MAGIC_LINK_SENSITIVE_TTL defaults. */
export const MAGIC_LINK_MS = 30 * 24 * 3_600_000;
export const SENSITIVE_MAGIC_LINK_MS = 48 * 3_600_000;

export interface MagicLink {
  createdBy: string;
  expiresAt: number;
  policyVersionId: string;
  revokedAt: null | number;
  sensitive: boolean;
}

export interface PdfJob {
  policyVersionId: string;
  requestedBy: string;
}

const jobs = () => stewardData().pdfJobs;
const links = () => stewardData().magicLinks;

/** A new export job, named as delivery names it. */
export const createPdfJob = (policyVersionId: string, requestedBy: string) => {
  const nanos =
    BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  const jobId = `pdf-${policyVersionId}-${String(nanos)}`;
  jobs()[jobId] = { policyVersionId, requestedBy };
  return jobId;
};

export const pdfJob = (jobId: string): PdfJob | undefined => jobs()[jobId];

/** Where the mock serves the sample PDF: MOCK_PUBLIC_URL, or this machine on the mock's port. */
const origin = () =>
  process.env.MOCK_PUBLIC_URL?.replace(/\/+$/, "") ??
  `http://localhost:${String(settings().port)}`;

/** A job's download link, as delivery's signer answers it, valid for PDF_LINK_MS. */
export const signedPdfUrl = (jobId: string, expiresAt: number) =>
  `${origin()}/delivery/pdf/${encodeURIComponent(jobId)}.pdf?expires=${String(Math.floor(expiresAt / 1000))}`;

/** delivery's generateToken: 32 random bytes as hex. */
export const createMagicLink = (
  policyVersionId: string,
  createdBy: string,
  sensitive: boolean,
) => {
  const token = randomBytes(32).toString("hex");
  const expiresAt =
    Date.now() + (sensitive ? SENSITIVE_MAGIC_LINK_MS : MAGIC_LINK_MS);
  links()[token] = {
    createdBy,
    expiresAt,
    policyVersionId,
    revokedAt: null,
    sensitive,
  };
  return { expiresAt, token };
};

/** delivery's Revoke: marks a live token revoked; an unknown one changes nothing. */
export const revokeMagicLink = (token: string) => {
  const link = links()[token];
  if (link && link.revokedAt === null) link.revokedAt = Date.now();
};

/** delivery's Fingerprint: the first 8 bytes of the token's SHA-256, as hex. */
export const fingerprint = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

/** A one-page PDF saying it's the mock's sample. */
const SAMPLE_PDF = (() => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const text = "BT /F1 18 Tf 72 760 Td (Steward mock: sample policy PDF) Tj ET";
  objects.push(
    `<< /Length ${String(text.length)} >>\nstream\n${text}\nendstream`,
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
  return body;
})();

/** GET /delivery/pdf/<jobId>.pdf: the sample PDF for a known job. */
export const deliveryRoutes = (
  request: Request,
  path: string,
): Response | undefined => {
  if (request.method !== "GET" || !path.startsWith("/delivery/pdf/"))
    return undefined;
  const jobId = decodeURIComponent(
    path.slice("/delivery/pdf/".length).replace(/\.pdf$/, ""),
  );
  if (!pdfJob(jobId)) return new Response("not found", { status: 404 });
  return new Response(SAMPLE_PDF, {
    headers: {
      "content-disposition": `inline; filename="${jobId}.pdf"`,
      "content-type": "application/pdf",
    },
  });
};
