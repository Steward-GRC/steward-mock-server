// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Start the mock from the command line (bin/mock-server.mjs sets the environment).

import { readFileSync } from "node:fs";

import { WRONG_CODE, WRONG_PASSWORD } from "#core/auth.ts";
import { GRAPHQL_PATH } from "#core/handle.ts";
import { startMockServer } from "#core/server.ts";
import { product } from "#product/product.ts";

const httpsPort = process.env.HTTPS_PORT;
const certificate = process.env.MOCK_TLS_CERT;
const key = process.env.MOCK_TLS_KEY;

const server = await startMockServer({
  host: process.env.HOST,
  port: Number(process.env.PORT ?? product.port),
  tls:
    httpsPort && certificate && key
      ? {
          cert: readFileSync(certificate),
          key: readFileSync(key),
          port: Number(httpsPort),
        }
      : undefined,
});

const base = `http://localhost:${String(server.port)}`;
console.log(`${product.name} mock gateway ready ${base}`);
if (server.https) {
  const { port } = server.https.address() as { port: number };
  console.log(`  https    https://localhost:${String(port)}`);
}
console.log(
  `  graphql  ${base}${GRAPHQL_PATH} (POST, and the websocket on the same path)`,
);
console.log(`  controls ${base}/_mock`);
console.log(
  `  sign in  any person at ${base}/_mock/people, any password but "${WRONG_PASSWORD}",`,
);
console.log(`           then any six-digit code but ${WRONG_CODE}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
