#!/usr/bin/env node
// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Starts the mock gateway: steward-mock-server [--port <n>] [--https-port <n>]. Port 0 picks a free one;
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
    console.error("usage: steward-mock-server [--port <n>] [--https-port <n>]");
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
