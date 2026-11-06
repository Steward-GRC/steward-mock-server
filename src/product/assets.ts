// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's editor image routes (internal/assets), over core's AssetService, kept in
// memory:
//
// - POST /api/assets takes one multipart file under "file" and answers
//   {id, url, contentType, sizeBytes, filename}. Core's rules apply: not empty, at most 10 MiB, and
//   PNG, JPEG, GIF or WebP by what the bytes are (the declared type is ignored, SVG is refused).
//   Errors are {error} with the gateway's texts.
// - GET /api/assets/{id} serves the bytes back with the stored type. Like the gateway's, it needs
//   a session but not the CSRF token, so an <img src> can load it.
//
// Two /_mock switches try the error paths: uploads that fail as if the object store were down, and
// a 100 KB cap in place of 10 MB, so the too-large message shows without a huge file. Start fresh
// forgets the images (the metadata lives in the seeded data, the bytes only reachable through it).

import type { Action, ProductControl } from "#core/controls.ts";

import { sessionOf, sessionOfCookie } from "#core/auth.ts";
import { json, newId, refuse } from "#core/http.ts";
import { stewardData } from "#product/data.ts";

/** Core's MaxAssetBytes. */
export const MAX_ASSET_BYTES = 10 << 20;
/** The cap the "small" switch applies. */
export const SMALL_ASSET_BYTES = 100 << 10;
/** The slack the gateway allows the multipart framing. */
const MULTIPART_OVERHEAD = 64 << 10;
const ALLOWED = ["image/gif", "image/jpeg", "image/png", "image/webp"];

export interface AssetSettings {
  /** Uploads answer 503 "Failed to store image". */
  fail: boolean;
  /** Which size cap is on. */
  limit: "real" | "small";
}

export interface StoredAsset {
  contentType: string;
  createdBy: string;
  filename: string;
  id: string;
  sizeBytes: number;
}

/** The bytes, by asset id. Metadata is in the seeded data, so a reset forgets both. */
const bytes = new Map<string, Uint8Array>();

const capOf = (): number =>
  stewardData().assetSettings.limit === "small"
    ? SMALL_ASSET_BYTES
    : MAX_ASSET_BYTES;
const capText = (): string =>
  stewardData().assetSettings.limit === "small" ? "100 KB" : "10 MB";

const refusal = (status: number, error: string) => json({ error }, status);

/** The gateway's session gate: `safe` skips the CSRF token, as its safe-read variant does. */
const sessionRefusal = (request: Request, safe: boolean) => {
  if (safe ? sessionOfCookie(request) : sessionOf(request)) return;
  if (!safe && sessionOfCookie(request)) return refuse(403, "csrf");
  if (safe && request.headers.get("authorization")?.startsWith("Bearer ")) {
    return sessionOf(request) ? undefined : refuse(401, "unauthorized");
  }
  return refuse(401, "unauthorized");
};

/** Go's http.DetectContentType, as far as the allowed images and a refusal message need. */
const sniff = (data: Uint8Array): string => {
  const head = Buffer.from(data.subarray(0, 512)).toString("latin1");
  if (head.startsWith("\u0089PNG\r\n\u001A\n")) return "image/png";
  if (head.startsWith("\u00FF\u00D8\u00FF")) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a"))
    return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP")
    return "image/webp";
  return /[\u0000-\u0008\u000B\u000E-\u001A]/.test(head)
    ? "application/octet-stream"
    : "text/plain";
};

/** POST /api/assets. */
const upload = async (request: Request): Promise<Response> => {
  const { assetSettings } = stewardData();
  const tooLarge = `File too large — max upload size is ${capText()}`;
  if (
    Number(request.headers.get("content-length") ?? 0) >
    capOf() + MULTIPART_OVERHEAD
  )
    return refusal(
      400,
      `File too large or malformed upload — max upload size is ${capText()}`,
    );
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refusal(
      400,
      `File too large or malformed upload — max upload size is ${capText()}`,
    );
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return refusal(
      400,
      'Missing file — attach a single image under the "file" field',
    );
  if (file.size > capOf()) return refusal(400, tooLarge);
  const data = new Uint8Array(await file.arrayBuffer());
  // Core is what refuses empty and wrong-type files, so they come after the gateway's checks.
  if (assetSettings.fail) return refusal(503, "Failed to store image");
  if (data.length === 0) return refusal(400, "asset: empty upload");
  const contentType = sniff(data);
  if (!ALLOWED.includes(contentType))
    return refusal(
      400,
      `asset: unsupported content type: "${contentType}" (allowed: ${ALLOWED.join(", ")})`,
    );

  const data_ = stewardData();
  for (const id of bytes.keys()) if (!data_.assets[id]) bytes.delete(id);
  const id = newId("asset");
  const stored: StoredAsset = {
    contentType,
    createdBy: sessionOf(request)?.personId ?? "",
    filename: file.name.split(/[/\\]/).pop() ?? "",
    id,
    sizeBytes: data.length,
  };
  data_.assets[id] = stored;
  bytes.set(id, data);
  return json({
    contentType,
    filename: stored.filename,
    id,
    sizeBytes: stored.sizeBytes,
    url: `/api/assets/${id}`,
  });
};

/** GET /api/assets/{id}. */
const serve = (id: string): Response => {
  const stored = stewardData().assets[id];
  const data = bytes.get(id);
  if (!stored || !data) return refusal(404, "Asset not found");
  return new Response(data as BodyInit, {
    headers: {
      "cache-control": "private, max-age=86400, immutable",
      "content-length": String(data.length),
      "content-type": stored.contentType,
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
};

/** The asset routes, or undefined for a path they don't serve. */
export const assetRoutes = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  if (path === "/api/assets" && request.method === "POST")
    return sessionRefusal(request, false) ?? upload(request);
  const match = /^\/api\/assets\/([^/]+)$/.exec(path);
  if (match && request.method === "GET")
    return (
      sessionRefusal(request, true) ?? serve(decodeURIComponent(match[1] ?? ""))
    );
  return undefined;
};

/** POST /_mock/controls {kind: "asset-upload", mode: "fail" | "ok"}. */
const uploadSwitch: ProductControl = (body) => {
  stewardData().assetSettings.fail = body.mode === "fail";
  return { ...stewardData().assetSettings };
};

/** POST /_mock/controls {kind: "asset-limit", limit: "small" | "real"}. */
const limitSwitch: ProductControl = (body) => {
  stewardData().assetSettings.limit = body.limit === "small" ? "small" : "real";
  return { ...stewardData().assetSettings };
};

export const assetActions: ({ run: ProductControl } & Action)[] = [
  {
    body: { mode: "fail" },
    hint: "Image uploads answer 503 Failed to store image, as when the object store is down.",
    kind: "asset-upload",
    label: "Uploads fail",
    run: uploadSwitch,
    section: "Image uploads",
  },
  {
    body: { mode: "ok" },
    hint: "Image uploads work again.",
    kind: "asset-upload",
    label: "Uploads work",
    run: uploadSwitch,
    section: "Image uploads",
  },
  {
    body: { limit: "small" },
    hint: "Images over 100 KB are refused as too large, so the error shows without a huge file.",
    kind: "asset-limit",
    label: "Size limit 100 KB",
    run: limitSwitch,
    section: "Image uploads",
  },
  {
    body: { limit: "real" },
    hint: "The real limit: 10 MB. PNG, JPEG, GIF and WebP only, whatever the file says it is.",
    kind: "asset-limit",
    label: "Size limit 10 MB",
    run: limitSwitch,
    section: "Image uploads",
  },
];
