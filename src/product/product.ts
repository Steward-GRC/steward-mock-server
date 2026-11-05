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
// Who this mock is. A product changes these values (and the files beside this one) when it
// clones the template; nothing in src/core names a product.

export const product = {
  /** The product's name, on the controls page and in the ready line. */
  name: "Example",
  /** The port the mock listens on unless --port or PORT says otherwise. */
  port: 5180,
  /**
   * Root fields anyone may ask for before signing in. An operation runs without a session only
   * when every root field it selects is in this list.
   */
  publicFields: ["serverInfo"],
  /** The session cookie. Take the real gateway's name, so a client's live code reads it unchanged. */
  sessionCookie: process.env.MOCK_SESSION_COOKIE || "example_session",
  /** The version the mock reports: a release shape clients can parse. */
  version: process.env.MOCK_SERVER_VERSION || "v0.1.0-mock",
  /** The response header the health probes carry the version in. */
  versionHeader: "Example-Version",
};
