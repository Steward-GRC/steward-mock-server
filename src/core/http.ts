// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Small answers every route uses.

export const json = (
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response => {
  return Response.json(body, { headers, status });
};

/** A refusal in the gateway's plain shape: `{ "error": "<code>" }`. */
export const refuse = (
  status: number,
  error: string,
  message?: string,
): Response => json(message ? { error, message } : { error }, status);

/** The request's JSON body, or an empty object when it has none or it doesn't parse. */
export const readJson = async <T extends object>(
  request: Request,
): Promise<Partial<T>> => {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null
      ? (body as Partial<T>)
      : {};
  } catch {
    return {};
  }
};

/** A cookie's value from a Cookie header. */
export const cookieOf = (
  header: null | string,
  name: string,
): null | string => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
};

export const newId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
