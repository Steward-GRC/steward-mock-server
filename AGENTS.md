# AGENTS.md - template-node-mock-server

Guide for AI agents working in this repository. Pair with `CLAUDE.md` (the working agreement).
Keep this file current when the layout, the wire protocol or the commands change.

## What this is

Starting point for a product's mock gateway: a standalone Node server that speaks the gateway's
wire protocol with resettable invented data. It's a public template: products clone it into their
own `<product>-mock-server` repo and fill in `src/product/`. Two things to understand before
changing it:

- **`src/core/` is shared, `src/product/` is not.** Nothing in `src/core/` may name a product or
  read a product's records directly; it reaches the product only through the five files in
  `src/product/`. A fix to the core lands here and goes to every product as a cherry-pick
  (TEMPLATE.md), so keep core files and their names stable.
- **Every answer goes through the product's schema.** Resolvers return plain data; GraphQL
  execution against `src/product/schema.graphql` shapes it. Don't build response bodies for
  `/query` by hand.

## Layout

- `bin/mock-server.mjs` - the command: reads `--port` and `--https-port`, then loads
  `src/serve.ts`.
- `src/serve.ts` - starts the server and prints the ready lines.
- `src/index.ts` - what in-process tests import.
- `src/core/` - `server.ts` (HTTP, HTTPS, websocket upgrade), `handle.ts` (routing, `/query`,
  CORS), `graphql.ts` (schema, execution, error codes), `websocket.ts` (both subscription
  protocols), `auth.ts` (`/auth/*`, cookie and bearer sessions), `setup.ts` (`/setup/*`),
  `health.ts`, `controls.ts` and `page.ts` (`/_mock`), `state.ts`, `events.ts`, `log.ts`.
- `src/product/` - `product.ts`, `schema.graphql`, `data.ts`, `resolvers.ts`, `controls.ts`.
- `src/core/server.test.ts` - the tests, against a real server on a free port;
  `src/core/test-client.ts` holds their helpers.

## Build, test, lint

- Install: `npm ci --ignore-scripts`
- Run: `npm start` (port 5180; `npm start -- --port 0` for a free one)
- Lint: `npm run lint` (oxlint, then `oxfmt --check`; `npm run format` fixes the formatting)
- Typecheck: `npm run typecheck`
- Test: `npm test`
- License headers: `task license` (check) and `task license:fix` (inject), MIT "2026 Shane"

## Logging

- `src/core/log.ts`: `LOG_LEVEL` (`trace` to `error`, `info` by default) and `LOG_FORMAT`
  (`console` or `json`). Requests log their method, path, status and time at `debug`.
- Never log a request or response body, a password, a code, a cookie or a token, even invented
  ones. Log the person's id instead.

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
