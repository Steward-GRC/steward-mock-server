#!/usr/bin/env node
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
// Starts the mock gateway: mock-server [--port <n>] [--https-port <n>]. Port 0 picks a free one;
// the ready line names the port it got. --https-port needs MOCK_TLS_CERT and MOCK_TLS_KEY.
// Node runs the TypeScript sources directly (type stripping, Node 24 and later): no build step.

const flags = process.argv.slice(2);
const flag = (name) => {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
};

const port = flag("--port");
const httpsPort = flag("--https-port");
for (const value of [port, httpsPort]) {
  if (value !== undefined && !/^\d+$/.test(value)) {
    console.error("usage: mock-server [--port <n>] [--https-port <n>]");
    process.exit(2);
  }
}
if (
  httpsPort !== undefined &&
  !(process.env.MOCK_TLS_CERT && process.env.MOCK_TLS_KEY)
) {
  console.error(
    "--https-port needs MOCK_TLS_CERT and MOCK_TLS_KEY (a certificate and its key)",
  );
  process.exit(2);
}
if (port !== undefined) process.env.PORT = port;
if (httpsPort !== undefined) process.env.HTTPS_PORT = httpsPort;

await import("../src/serve.ts");
