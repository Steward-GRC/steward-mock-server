// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Start the mock from the command line (bin/steward-mock-server.mjs sets the environment).

import { readFileSync } from "node:fs";

import { WRONG_CODE, WRONG_PASSWORD } from "#core/auth.ts";
import { settings, useProduct } from "#core/product.ts";
import { startMockServer } from "#core/server.ts";
import { steward } from "#product/product.ts";

useProduct(steward);

const httpsPort = process.env.HTTPS_PORT;
const certificate = process.env.MOCK_TLS_CERT;
const key = process.env.MOCK_TLS_KEY;

const server = await startMockServer({
  host: process.env.HOST,
  port: Number(process.env.PORT ?? settings().port),
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
console.log(`${settings().name} mock gateway ready ${base}`);
if (server.https) {
  const { port } = server.https.address() as { port: number };
  console.log(`  https    https://localhost:${String(port)}`);
}
console.log(
  `  graphql  ${base}${settings().graphqlPath} (POST, and the websocket on the same path)`,
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
