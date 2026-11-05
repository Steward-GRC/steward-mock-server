// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// steward-gateway's reference-document routes (internal/documents), behind its session check:
//
// - POST /documents/extract takes a multipart upload under "file" and answers {title, content}:
//   plain text from a .txt, .md, .docx or .rtf file, read the way the gateway reads it. A .pdf or
//   legacy .doc file that looks like one answers SAMPLE_TEXT instead, since parsing those formats
//   is out of the mock's reach; one that doesn't is refused as the gateway refuses it.
// - POST /documents/validate-url takes {url}, refuses what the gateway's URL guard refuses, and
//   answers {readable, reason?, title?, finalUrl?} from the URL's shape alone, never fetching it:
//   a sign-in path needs a login, a host under .invalid couldn't be reached (the mock's
//   convention, for the unreachable state), and anything else is readable, titled from its host
//   and path.

import { inflateRawSync } from "node:zlib";

import { sessionOf, sessionOfCookie } from "#core/auth.ts";
import { json, refuse } from "#core/http.ts";

/** The gateway's MaxUploadBytes, and the slack it allows the multipart wrapping. */
const MAX_UPLOAD = 10 << 20;
const MULTIPART_OVERHEAD = 64 << 10;
/** The gateway's MaxContentChars. */
const MAX_CONTENT = 200_000;
/** The gateway's maxRequestBodyBytes for validate-url. */
const MAX_URL_BODY = 64 << 10;

/** What a PDF or legacy Word upload answers, since the mock doesn't parse those formats. */
export const SAMPLE_TEXT =
  "Sample reference document. The mock doesn't read PDF or legacy Word files, so every one answers this text: desks are booked through the booking page, a booking holds the desk until 10:00, and the Facilities team keeps the desk zones up to date.";

const refusal = (status: number, error: string) => json({ error }, status);

/** The gateway's session middleware: a session (cookie with its CSRF token, or bearer). */
const sessionRefusal = (request: Request): Response | undefined => {
  if (sessionOf(request)) return undefined;
  return sessionOfCookie(request)
    ? refuse(403, "csrf")
    : refuse(401, "unauthorized");
};

/** The gateway's normalizeText: valid UTF-8, no control characters, single spaces, trimmed. */
const normalize = (bytes: string | Uint8Array): string => {
  const text =
    typeof bytes === "string"
      ? bytes
      : new TextDecoder("utf-8").decode(bytes).replaceAll("�", "");
  return text
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll(/[\t\n\f\r ]+/g, " ")
    .trim();
};

class ExtractError extends Error {}

const startsWith = (data: Uint8Array, prefix: string) => {
  const trimmed = Buffer.from(data).toString("latin1").trimStart();
  return trimmed.startsWith(prefix);
};

/** Zip's record signatures ("PK\x01\x02", "PK\x05\x06"), little-endian. */
const CENTRAL_HEADER = Buffer.from("PK\u0001\u0002", "latin1").readUInt32LE(0);
const END_OF_DIRECTORY = Buffer.from("PK\u0005\u0006", "latin1").readUInt32LE(
  0,
);

/** The entries of a zip archive by name, or undefined when it isn't one. */
const zipEntries = (data: Buffer): Map<string, () => Buffer> | undefined => {
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--)
    if (data.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  if (end === -1) return undefined;
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const entries = new Map<string, () => Buffer>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL_HEADER)
      return undefined;
    const method = data.readUInt16LE(at + 10);
    const size = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      const start =
        local +
        30 +
        data.readUInt16LE(local + 26) +
        data.readUInt16LE(local + 28);
      const stored = data.subarray(start, start + size);
      if (method === 0) return stored;
      if (method === 8) return inflateRawSync(stored);
      throw new Error("zip: unsupported compression algorithm");
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

const unescapeXml = (text: string) =>
  text.replaceAll(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#"))
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });

/** The elements that start a new line in docx text: paragraphs and breaks. */
const BREAKS = new Set(["br", "cr", "p"]);

/** The gateway's docxXMLToText: character data, a newline per paragraph and break, a tab per tab. */
const docxText = (xml: string): string => {
  let out = "";
  for (const [token] of xml.matchAll(
    /<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g,
  )) {
    if (token.startsWith("<![CDATA[")) {
      out += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith("<")) {
      out += unescapeXml(token);
      continue;
    }
    if (/^<[/?!]/.test(token)) continue;
    const local = /^<([^\s/>]+)/.exec(token)?.[1]?.split(":").pop();
    if (BREAKS.has(local ?? "")) out += "\n";
    else if (local === "tab") out += "\t";
  }
  return out;
};

const docx = (data: Uint8Array): string => {
  const entries = zipEntries(Buffer.from(data));
  if (!entries)
    throw new ExtractError(
      "This file doesn't look like a valid Word (.docx) file — check the file and try again",
    );
  const body = entries.get("word/document.xml");
  if (!body)
    throw new ExtractError(
      "This .docx file is missing word/document.xml — it may be corrupt",
    );
  let xml: string;
  try {
    xml = body().toString("utf8");
  } catch (error) {
    throw new ExtractError(
      `Failed to read .docx contents: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalize(docxText(xml));
};

const byte = (char: string) => char.codePointAt(0) ?? 0;
const OPEN = byte("{");
const CLOSE = byte("}");
const BACKSLASH = byte("\\");
const MINUS = byte("-");
const NEWLINE = byte("\n");
const RETURN = byte("\r");
const QUOTE = byte("'");
const SPACE = byte(" ");
const TAB = byte("\t");
/** The characters a backslash makes literal. */
const LITERALS = new Set([BACKSLASH, CLOSE, OPEN]);

/** The groups whose text an RTF reader never shows. */
const RTF_SKIP = new Set([
  "colortbl",
  "fonttbl",
  "generator",
  "info",
  "stylesheet",
]);

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;

/** The gateway's extractRTFText: a byte scanner over groups and control words. */
const rtf = (data: Uint8Array): string => {
  if (!startsWith(data, String.raw`{\rtf`))
    throw new ExtractError(
      "This file doesn't look like a valid RTF file — check the file and try again",
    );
  const out: number[] = [];
  const skip = [false];
  const top = () => skip.at(-1) === true;
  let index = 0;
  /** A control word (letters, an optional signed number, one optional space) after a backslash. */
  const controlWord = () => {
    const start = index;
    while (index < data.length && isAlpha(data[index] as number)) index++;
    const word = Buffer.from(data.subarray(start, index)).toString("latin1");
    if (
      index < data.length &&
      (data[index] === MINUS || isDigit(data[index] as number))
    ) {
      if (data[index] === MINUS) index++;
      while (index < data.length && isDigit(data[index] as number)) index++;
    }
    if (index < data.length && data[index] === SPACE) index++;
    if (!top()) {
      if (word === "par" || word === "line") out.push(NEWLINE);
      else if (word === "tab") out.push(TAB);
    }
    if (RTF_SKIP.has(word)) skip[skip.length - 1] = true;
  };
  /** What follows a backslash: an escaped brace or backslash, a hex byte, or a control word. */
  const escaped = () => {
    const next = data[index] as number;
    if (LITERALS.has(next)) {
      if (!top()) out.push(next);
      index++;
      return;
    }
    if (next !== QUOTE) {
      controlWord();
      return;
    }
    index++;
    if (index + 1 < data.length) {
      const hex = Buffer.from(data.subarray(index, index + 2)).toString(
        "latin1",
      );
      if (/^[\da-f]{2}$/i.test(hex) && !top())
        out.push(Number.parseInt(hex, 16));
      index += 2;
    }
  };
  while (index < data.length) {
    const c = data[index] as number;
    switch (c) {
      case BACKSLASH: {
        index++;
        if (index < data.length) escaped();
        break;
      }
      case CLOSE: {
        if (skip.length > 1) skip.pop();
        index++;
        break;
      }
      case OPEN: {
        skip.push(top());
        index++;
        break;
      }
      default: {
        if (!top() && c !== RETURN && c !== NEWLINE) out.push(c);
        index++;
      }
    }
  }
  return normalize(Uint8Array.from(out));
};

/** The OLE compound file signature a legacy Word document starts with. */
const OLE_MAGIC = [...Buffer.from("d0cf11e0a1b11ae1", "hex")];

/** The gateway's extractText, by extension. */
const extractText = (filename: string, data: Uint8Array): string => {
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot).toLowerCase();
  switch (extension) {
    case ".doc": {
      if (!OLE_MAGIC.every((byte, index) => data[index] === byte))
        throw new ExtractError(
          "This file doesn't look like a valid legacy Word (.doc) file — check the file and try again",
        );
      return SAMPLE_TEXT;
    }
    case ".docx": {
      return docx(data);
    }
    case ".md":
    case ".txt": {
      return normalize(data);
    }
    case ".pdf": {
      if (!startsWith(data, "%PDF"))
        throw new ExtractError(
          "This file doesn't look like a valid PDF — check the file and try again",
        );
      return SAMPLE_TEXT;
    }
    case ".rtf": {
      return rtf(data);
    }
    default: {
      throw new ExtractError(
        `Unsupported file type: ${extension} — attach a PDF, Word (.docx or .doc), RTF, Markdown, or text file`,
      );
    }
  }
};

const MALFORMED_UPLOAD =
  "File too large or malformed upload — max upload size is 10 MB";
const TOO_LARGE = "File too large — max upload size is 10 MB";

/** POST /documents/extract. */
const extract = async (request: Request): Promise<Response> => {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD + MULTIPART_OVERHEAD)
    return refusal(400, MALFORMED_UPLOAD);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refusal(400, MALFORMED_UPLOAD);
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return refusal(
      400,
      'Missing file — attach a single file under the "file" field',
    );
  if (file.size > MAX_UPLOAD) return refusal(400, TOO_LARGE);
  const data = new Uint8Array(await file.arrayBuffer());
  const filename = file.name.split(/[/\\]/).pop() ?? "";
  let content: string;
  try {
    content = extractText(filename, data);
  } catch (error) {
    if (error instanceof ExtractError) return refusal(400, error.message);
    throw error;
  }
  const dot = filename.lastIndexOf(".");
  return json({
    content: [...content].slice(0, MAX_CONTENT).join(""),
    title: dot === -1 ? filename : filename.slice(0, dot),
  });
};

/** A URL split the way Go's url.Parse splits it, as far as the guard needs. */
interface ParsedUrl {
  host: string;
  hostname: string;
  /** The URL as url.URL's String writes it back: the scheme lowercased. */
  href: string;
  path: string;
  scheme: string;
}

const parseUrl = (raw: string): ParsedUrl | undefined => {
  const scheme = /^([a-z][\d+.a-z-]*):/i.exec(raw)?.[1] ?? "";
  const rest = scheme ? raw.slice(scheme.length + 1) : raw;
  let host = "";
  let tail = rest;
  if (scheme && rest.startsWith("//")) {
    const authority = /^\/\/([^#/?]*)/.exec(rest)?.[1] ?? "";
    tail = rest.slice(2 + authority.length);
    host = authority.slice(authority.lastIndexOf("@") + 1);
  }
  let hostname = host;
  let port = "";
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) return undefined;
    hostname = host.slice(1, close);
    port = host.slice(close + 1);
    if (port && !port.startsWith(":")) return undefined;
    port = port.slice(1);
  } else if (host.includes(":")) {
    hostname = host.slice(0, host.lastIndexOf(":"));
    port = host.slice(host.lastIndexOf(":") + 1);
  }
  if (port && !/^\d+$/.test(port)) return undefined;
  if (/[\s"<>\\^`{|}]/.test(hostname)) return undefined;
  const path = /^[^#?]*/.exec(tail)?.[0] ?? "";
  return {
    host,
    hostname,
    href: scheme.toLowerCase() + raw.slice(scheme.length),
    path,
    scheme: scheme.toLowerCase(),
  };
};

const ipv4 = (host: string): number[] | undefined => {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p)))
    return undefined;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
};

const groupsOf = (part: string) => (part ? part.split(":") : []);

/** IPv6 text as its eight 16-bit groups, or undefined. */
const ipv6 = (host: string): number[] | undefined => {
  if (!host.includes(":")) return undefined;
  let text = host;
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (embedded) {
    const v4 = ipv4(embedded[1] ?? "");
    if (!v4) return undefined;
    text =
      text.slice(0, -(embedded[1] ?? "").length) +
      `${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = groupsOf(halves[0] ?? "");
  const tail = groupsOf(halves[1] ?? "");
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[\da-f]{1,4}$/i.test(g)))
    return undefined;
  return all.map((g) => Number.parseInt(g, 16));
};

/** Go's IsLoopback, IsPrivate, IsLinkLocalUnicast, IsLinkLocalMulticast and IsUnspecified. */
const blockedIp = (host: string): boolean | undefined => {
  let v4 = ipv4(host);
  const v6 = v4 ? undefined : ipv6(host);
  if (!v4 && !v6) return undefined;
  if (v6 && v6.slice(0, 5).every((g) => g === 0) && v6[5] === 65_535)
    v4 = [
      (v6[6] ?? 0) >> 8,
      (v6[6] ?? 0) & 255,
      (v6[7] ?? 0) >> 8,
      (v6[7] ?? 0) & 255,
    ];
  if (v4) {
    const [a = 0, b = 0, c = 0] = v4;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 224 && b === 0 && c === 0) ||
      v4.every((o) => o === 0)
    );
  }
  const groups = v6 ?? [];
  const first = groups[0] ?? 0;
  return (
    groups.every((g, index) => g === (index === 7 ? 1 : 0)) ||
    groups.every((g) => g === 0) ||
    (first & 65_024) === 64_512 ||
    (first & 65_472) === 65_152 ||
    (first & 65_295) === 65_282
  );
};

const LOGIN_MARKERS = ["login", "signin", "sign-in", "/sso", "authwall"];

const MALFORMED_URL_REQUEST =
  'Malformed request — expected JSON {"url": "https://..."}';

/** POST /documents/validate-url. */
const validateUrl = async (request: Request): Promise<Response> => {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_URL_BODY)
    return refusal(400, MALFORMED_URL_REQUEST);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refusal(400, MALFORMED_URL_REQUEST);
  }
  if (body !== null && (typeof body !== "object" || Array.isArray(body)))
    return refusal(400, MALFORMED_URL_REQUEST);
  const given = (body as { url?: unknown } | null)?.url;
  if (given !== undefined && given !== null && typeof given !== "string")
    return refusal(400, MALFORMED_URL_REQUEST);
  const raw = (given ?? "").trim();
  if (!raw) return refusal(400, "Missing url — provide a URL to check");
  const url = parseUrl(raw);
  if (!url)
    return refusal(400, `Invalid URL — could not parse ${JSON.stringify(raw)}`);
  if (url.scheme !== "http" && url.scheme !== "https")
    return refusal(
      400,
      `Unsupported URL scheme ${JSON.stringify(url.scheme)} — only http and https are allowed`,
    );
  if (!url.hostname || !url.host)
    return refusal(400, "Invalid URL — missing host");
  const lower = url.hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  )
    return refusal(
      400,
      "This URL points to a blocked host — internal/local addresses are not allowed",
    );
  if (blockedIp(url.hostname))
    return refusal(
      400,
      "This URL points to a blocked address — internal/private/link-local addresses are not allowed",
    );
  const title =
    url.path === "" || url.path === "/"
      ? url.hostname
      : url.hostname + url.path;
  if (lower.endsWith(".invalid"))
    return json({ readable: false, reason: "couldn't be reached", title });
  const path = url.path.toLowerCase();
  if (LOGIN_MARKERS.some((marker) => path.includes(marker)))
    return json({
      finalUrl: url.href,
      readable: false,
      reason: "requires a login",
      title,
    });
  return json({ finalUrl: url.href, readable: true, title });
};

/** The document routes, or undefined for a path they don't serve. */
export const documentRoutes = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  if (request.method !== "POST") return undefined;
  if (path !== "/documents/extract" && path !== "/documents/validate-url")
    return undefined;
  const refused = sessionRefusal(request);
  if (refused) return refused;
  return path === "/documents/extract"
    ? extract(request)
    : validateUrl(request);
};
