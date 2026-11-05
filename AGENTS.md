# AGENTS.md - steward-mock-server

Guide for AI agents working in this repository. Pair with `CLAUDE.md` (the working agreement).
Keep this file current when the layout, the wire protocol or the commands change.

## What this is

Steward's mock gateway: a standalone Node server that answers steward-gateway's wire protocol
(GraphQL at `/query`, sign-in under `/auth`, first run under `/setup`, the probes) from invented,
resettable data, on port 5175. steward-web's apps run in their normal live mode against it with
`GATEWAY_URL=http://localhost:5175/query`. The schema in `src/product/schema.graphql` is copied
from steward-gateway at the commit in `schema-refs.env`: bump the ref, run
`bash scripts/schema-copy.sh`, and commit both, keeping the ref the same as steward-web's.

## Layout

- `bin/steward-mock-server.mjs` - the command: reads `--port` and `--https-port`, then loads
  `src/serve.ts`.
- `src/serve.ts` - starts the server and prints the ready lines.
- `src/index.ts` - what in-process tests import.
- `src/core/` - `server.ts` (HTTP, HTTPS, websocket upgrade), `handle.ts` (routing, `/query`,
  CORS), `graphql.ts` (schema, execution, error codes), `websocket.ts` (both subscription
  protocols), `auth.ts` (`/auth/*`, cookie and bearer sessions), `setup.ts` (`/setup/*`),
  `health.ts`, `controls.ts` and `page.ts` (`/_mock`), `state.ts`, `events.ts`, `log.ts`.
- `src/product/` - `product.ts`, `schema.graphql`, `controls.ts`; `data.ts` builds the seed from
  `data/*.ts` (one module per domain); `resolvers.ts` merges `resolvers/*.ts` (one per domain);
  `access.ts` is the policy read model (who reads, edits and approves what).
- `src/product/web-operations/` - steward-web's operations, byte for byte at the commit its README
  names; `web-operations.test.ts` sends every one of them. Keep the folder out of the formatter.
- `src/core/server.test.ts` - the tests, against a real server on a free port;
  `src/core/test-client.ts` holds their helpers, and `src/product/web-client.ts` the product
  tests' (call a web operation by name as a sample person).

## Build, test, lint

- Install: `npm ci --ignore-scripts`
- Run: `npm start` (port 5180; `npm start -- --port 0` for a free one)
- Lint: `npm run lint` (oxlint, then `oxfmt --check`; `npm run format` fixes the formatting)
- Typecheck: `npm run typecheck`
- Test: `npm test`
- License headers: `task license` (check) and `task license:fix` (inject), Apache-2.0, two-line SPDX header for "2026 The Steward Authors"

## Logging

- `src/core/log.ts`: `LOG_LEVEL` (`trace` to `error`, `info` by default) and `LOG_FORMAT`
  (`console` or `json`). Requests log their method, path, status and time at `debug`.
- Never log a request or response body, a password, a code, a cookie or a token, even invented
  ones. Log the person's id instead.

## Template sync

Known divergence from the template's `src/core/`: `server.test.ts` is rewritten onto Steward's
people and fields, because the template's core tests use its example product. Drop the
divergence once the template's core tests run against their own fixture product.

This repo started from `the-rabbit-hole-tech/template-node-mock-server` at commit
`14159069615ceda41559fcbf38fffca3178b3f7d`. Take later
template fixes as `TEMPLATE.md` says, starting from that commit: `src/core/` moves file for
file, `src/product/` stays Steward's.

## Conventions and gotchas

- Node runs the TypeScript sources directly, so only erasable syntax works: no `enum`, no
  `namespace`, no parameter properties, and every relative import names its `.ts` file. Imports go
  through `#core/*` and `#product/*` (`package.json` `imports`).
- `src/core/graphql.ts` builds the schema on first use, not at load: the product's resolvers import
  its helpers, so a build at load time would read the resolvers before they exist.
- The controls have no sign-in. The server listens on loopback unless `HOST` says otherwise; never
  change that default.
- Anything the mock doesn't serve answers 501 `not_mocked`. Keep that: a client must find out at
  once that it called something nobody mocked.
- Health probes never fail, whatever the controls armed.
- File names are kebab-case.
