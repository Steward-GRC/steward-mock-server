// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's editor asset routes (internal/assets), over core's AssetService, kept in
// memory:
//
// - POST /api/assets takes one multipart file under "file" and answers
//   {id, url, contentType, sizeBytes, filename}. Not empty, at most 10 MiB, and an image or an
//   ordinary attachment (PDF, Word, video, text and the like) by what the bytes are: the declared
//   type is ignored, and a name that says something else is refused. HTML, SVG, XML, scripts,
//   executables, archives and macro-enabled Office files are refused whatever they are called.
//   This is the demo's simple check, not the real rules (steward-core#36). Errors are {error}.
// - GET /api/assets/{id} serves the bytes back with the stored type: an image inline, any other
//   file as a download. Like the gateway's, it needs a session but not the CSRF token, so an
//   <img src> can load it.
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
const IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

/** Keeps the bytes of a seeded file; the metadata is in the seeded data (data/files.ts). */
export const keepBytes = (id: string, data: Uint8Array): void => {
  bytes.set(id, data);
};

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

/** What the bytes are: the stored type, and the extensions a name may carry for it. */
interface Detected {
  contentType: string;
  extensions: string[];
  /** A kind that is never stored, with the words for the refusal. */
  never?: string;
}

const MIME: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain; charset=utf-8",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const startsWith = (data: Uint8Array, text: string, at = 0): boolean =>
  data.length >= at + text.length &&
  [...text].every((char, index) => data[at + index] === char.codePointAt(0));

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

/** A simple, byte-based stand-in for the real check: signatures and a look inside zip names. */
const detect = (data: Uint8Array, name: string): Detected => {
  const image = IMAGE_TYPES.has(sniff(data)) ? sniff(data) : undefined;
  if (image) {
    const extensions =
      image === "image/jpeg" ? ["jpg", "jpeg"] : [image.slice(6)];
    return { contentType: image, extensions };
  }
  const extension = extensionOf(name);
  if (
    startsWith(data, "MZ") ||
    startsWith(data, "\u007FELF") ||
    startsWith(data, "#!")
  )
    return {
      contentType: "",
      extensions: [],
      never: "an executable or script",
    };
  if (
    [
      "\u00CA\u00FE\u00BA\u00BE",
      "\u00CE\u00FA\u00ED\u00FE",
      "\u00CF\u00FA\u00ED\u00FE",
    ].some((magic) => startsWith(data, magic))
  )
    return { contentType: "", extensions: [], never: "an executable" };
  if (startsWith(data, "%PDF-"))
    return { contentType: "application/pdf", extensions: ["pdf"] };
  if (startsWith(data, "\u00D0\u00CF\u0011\u00E0\u00A1\u00B1\u001A\u00E1")) {
    const latin = Buffer.from(data).toString("latin1");
    if (latin.includes("VBA"))
      return { contentType: "", extensions: [], never: "a file with macros" };
    return {
      contentType: MIME[extension] ?? MIME.doc!,
      extensions: ["doc", "xls", "ppt"],
    };
  }
  if (startsWith(data, "PK\u0003\u0004")) {
    const latin = Buffer.from(data).toString("latin1");
    if (latin.includes("vbaProject.bin"))
      return { contentType: "", extensions: [], never: "a file with macros" };
    if (latin.includes("word/"))
      return { contentType: MIME.docx!, extensions: ["docx"] };
    if (latin.includes("xl/"))
      return { contentType: MIME.xlsx!, extensions: ["xlsx"] };
    if (latin.includes("ppt/"))
      return { contentType: MIME.pptx!, extensions: ["pptx"] };
    const odf =
      /application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)/.exec(
        latin,
      )?.[1];
    if (odf) {
      const odfExtension = {
        presentation: "odp",
        spreadsheet: "ods",
        text: "odt",
      }[odf]!;
      return { contentType: MIME[odfExtension]!, extensions: [odfExtension] };
    }
    return { contentType: "", extensions: [], never: "an archive" };
  }
  if (startsWith(data, "ftyp", 4))
    return startsWith(data, "qt  ", 8)
      ? { contentType: "video/quicktime", extensions: ["mov"] }
      : { contentType: "video/mp4", extensions: ["mp4", "m4v"] };
  if (startsWith(data, "\u001AE\u00DF\u00A3"))
    return { contentType: "video/webm", extensions: ["webm"] };
  if (startsWith(data, String.raw`{\rtf`))
    return { contentType: "application/rtf", extensions: ["rtf"] };
  // text: valid UTF-8 with no binary bytes, and nothing a browser would run or render as a page
  let words: string;
  try {
    words = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { contentType: "", extensions: [], never: "an unknown binary file" };
  }
  if (words.includes("\u0000"))
    return { contentType: "", extensions: [], never: "an unknown binary file" };
  if (/^\s*<[!?a-z]/i.test(words) || /<script|javascript:/i.test(words))
    return {
      contentType: "",
      extensions: [],
      never: "a web page, script or markup",
    };
  const textType = MIME[extension];
  return {
    contentType: textType ?? MIME.txt!,
    extensions: ["txt", "md", "csv"],
  };
};

/** Content-Disposition for a download, with the name quoted and encoded. */
const attachment = (name: string): string =>
  `attachment; filename="${name.replaceAll(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

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
      'Missing file — attach a single file under the "file" field',
    );
  if (file.size > capOf()) return refusal(400, tooLarge);
  const data = new Uint8Array(await file.arrayBuffer());
  // Core is what refuses empty and wrong-type files, so they come after the gateway's checks.
  if (assetSettings.fail) return refusal(503, "Failed to store image");
  if (data.length === 0) return refusal(400, "asset: empty upload");
  const name = file.name.split(/[/\\]/).pop() ?? "";
  const found = detect(data, name);
  if (found.never)
    return refusal(
      400,
      `asset: files of this kind are not allowed (${found.never})`,
    );
  const extension = extensionOf(name);
  if (extension && !found.extensions.includes(extension))
    return refusal(
      400,
      `asset: the contents of "${name}" do not match its name (found ${found.contentType})`,
    );
  const { contentType } = found;

  const data_ = stewardData();
  for (const id of bytes.keys()) if (!data_.assets[id]) bytes.delete(id);
  const id = newId("asset");
  const stored: StoredAsset = {
    contentType,
    createdBy: sessionOf(request)?.personId ?? "",
    filename: name,
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
      ...(IMAGE_TYPES.has(stored.contentType)
        ? {}
        : { "content-disposition": attachment(stored.filename) }),
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
    hint: "Uploads answer 503 Failed to store image, as when the object store is down.",
    kind: "asset-upload",
    label: "Uploads fail",
    run: uploadSwitch,
    section: "Uploads",
  },
  {
    body: { mode: "ok" },
    hint: "Uploads work again.",
    kind: "asset-upload",
    label: "Uploads work",
    run: uploadSwitch,
    section: "Uploads",
  },
  {
    body: { limit: "small" },
    hint: "Files over 100 KB are refused as too large, so the error shows without a huge file.",
    kind: "asset-limit",
    label: "Size limit 100 KB",
    run: limitSwitch,
    section: "Uploads",
  },
  {
    body: { limit: "real" },
    hint: "The real limit: 10 MB. Images and ordinary attachments only, by what the bytes are, whatever the file says it is.",
    kind: "asset-limit",
    label: "Size limit 10 MB",
    run: limitSwitch,
    section: "Uploads",
  },
];
