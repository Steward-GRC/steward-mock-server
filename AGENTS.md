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
  `health.ts`, `controls.ts` and `page.ts` (`/_mock`), `maintenance.ts` (the maintenance window
  and the refusal while it's on), `state.ts`, `events.ts`, `log.ts`.
- `src/core/product.ts` - the Product contract; `src/core/test-fixture.ts` - the fixture product
  the core tests serve.
- `src/product/` - `product.ts` (Steward as a Product), `routes.ts` (the gateway's sign-in and
  `/setup/bootstrap`), `sso.ts` (the IdP test link, `/auth/sso/start` with a test token, and
  the `/admin/idp/*` imports from invented fixtures), `schema.graphql`, `controls.ts`; `data.ts` builds the seed from
  `data/*.ts` (one module per domain); `resolvers.ts` merges `resolvers/*.ts` (one per domain);
  `access.ts` is the policy read model (who reads, edits and approves what); `audit-actions.ts`
  lists the audit action names the services write, the only ones `record` takes; `collab.ts` is
  the co-editing relay at `/collab/ws/<draftId>` (the product's `sockets` hook) and the tokens
  `issueCollabToken` mints for it.
- `src/product/web-operations/` - steward-web's operations, byte for byte at the commit its README
  names; `web-operations.test.ts` sends every one of them. Keep the folder out of the formatter.
- `src/core/server.test.ts` - the core's tests, against a real server on a free port, serving the
  fixture; `src/core/test-client.ts` holds their helpers. `src/product/*.test.ts` test Steward,
  through `src/product/test-client.ts` (Steward's product and its sign-in) and
  `src/product/web-client.ts` (call a web operation by name as a sample person).

## Build, test, lint

- Install: `npm ci --ignore-scripts`
- Run: `npm start` (port 5175; `npm start -- --port 0` for a free one)
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

- Last synced to `the-rabbit-hole-tech/template-node-mock-server` release **v1.3.1**
  (`aeadfce`). The next sync starts there, tag to tag, as `TEMPLATE.md` says. That release is
  metadata only: it never becomes a tag here.
- `src/core/` is the template's file for file; only the two SPDX lines differ (Steward's holder).
  Steward's sign-in and first-run bootstrap are product routes in `src/product/routes.ts`, which
  answer before the core's `/auth` and `/setup`.
- One gap until the template has a setting for it: `/query` without a session answers 401 with a
  GraphQL error, where steward-gateway answers 401 `{"error":"unauthorized"}`, and 403
  `{"error":"csrf"}` for a cookie without its CSRF token. steward-web reacts to the status, so it
  behaves the same.

## Versioning

This repo's version always matches steward-web's. It's released only together with steward-web,
through Steward's release flow on the owner's Yes, never on its own. The release drafter only
drafts.

## Conventions and gotchas

- Node runs the TypeScript sources directly, so only erasable syntax works: no `enum`, no
  `namespace`, no parameter properties, and every relative import names its `.ts` file. Imports go
  through `#core/*` and `#product/*` (`package.json` `imports`).
- `src/core/graphql.ts` builds the schema on first use, not at load: the product's resolvers import
  its helpers, so a build at load time would read the resolvers before they exist.
- The controls have no sign-in. The server listens on loopback unless `HOST` says otherwise; never
  change that default.
- While maintenance is on (`src/core/maintenance.ts`), the gateway paths and new websockets get
  the product's maintenance refusal and `/readyz` says not ready; `/livez`, `/healthz`, `/_mock`
  and the product's maintenance fields keep answering.
- A route that throws answers 500 `internal` (logged), never a hung request. A websocket upgrade
  on any path but the GraphQL one goes to the product's `sockets` hook; nothing there answers 404.
  Product routes run after the health probes, the controls and the GraphQL path, and before
  `/auth` and `/setup`.
- Anything the mock doesn't serve answers 501 `not_mocked`. Keep that: a client must find out at
  once that it called something nobody mocked.
- Health probes never fail, whatever the controls armed.
- File names are kebab-case.
