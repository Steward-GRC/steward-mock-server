/*
MIT License

Copyright (c) 2026 Shane

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/
// Small answers every route uses.

export const json = (
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response => {
  return Response.json(body, { headers, status });
};

/** A refusal in the gateway's plain shape: `{ "error": "<code>" }`. */
export const refuse = (status: number, error: string): Response =>
  json({ error }, status);

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
