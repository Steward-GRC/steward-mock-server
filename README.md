# steward-mock-server 🧩

> 🧭 Standalone in-memory mock of the whole Steward gateway API, shared by web, iOS and Android.

Steward's staff and admin apps talk to steward-gateway. To work on a screen without the whole
backend running, they talk to this instead: one Node process on port 5175 that answers the
gateway's paths in the gateway's shapes (`/query`, `/auth/*`, `/setup/*`, the probes), from
invented data that every client shares and anyone can put back with one click at `/_mock`. The
schema is steward-gateway's own, pinned to one commit in `schema-refs.env`.

## ✨ Highlights

- 🔌 **The gateway's wire protocol:** GraphQL at `POST /query` and `GET /query`, a websocket on the
  same path for subscriptions (`graphql-transport-ws`, and the older `graphql-ws` that some mobile
  clients still speak), sign-in under `/auth/*`, first-run setup under `/setup/*`, and the
  `/livez`, `/readyz` and `/healthz` probes.
- 📐 **Answers shaped by the real schema:** every operation runs against the product's own GraphQL
  schema, so clients get only the fields they asked for, and a query the gateway would refuse is
  refused here too, with the same error codes.
- 👥 **One state for every client:** a browser signs in with a cookie and a CSRF token, a phone
  with a bearer token, and both read and change the same invented data. A change one client makes
  reaches every open subscription.
- 🎛️ **A controls page at `/_mock`:** sign someone in, fail the next call (as a GraphQL error or
  an HTTP status), expire every session, put the sample data back, start fresh, or start as a new
  install. A product adds its own buttons.
- 🧪 **Usable from a client's tests:** start it on a free port, or call `handle` with a `Request`
  and no port at all.
- 🪶 **No build step:** Node 24 runs the TypeScript sources directly. Two runtime dependencies:
  `graphql` and `ws`.

## 🚀 Run it

### Before you start

- Node.js 24 or later (`.nvmrc` has the version CI uses).

### Steps

1. Install the dependencies. Always pass `--ignore-scripts`:

   ```bash
   npm ci --ignore-scripts
   ```

2. Start the mock:

   ```bash
   npm start
   ```

   It listens on `http://localhost:5180`. Pass `-- --port 0` for a free port; the ready line says
   which one it got.

3. Open the controls at `http://localhost:5180/_mock`, or sign in from a client: any person listed
   at `/_mock/people`, any password except `wrong-password`, then any six digits except `000000`.

### Who to sign in as

| Username     | Role            | What they see                                                                                     |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------- |
| `demo-admin` | site admin      | Everything; sensitive policies obfuscated until they break glass. Asks for a second factor.       |
| `alovelace`  | author          | The library, her drafts (sensitive ones too), authoring in every category.                        |
| `ghopper`    | approver        | Published policies, the Data Classification approval waiting on her, the IT Security staff group. |
| `mhamilton`  | privacy officer | The report case queue. Has to enrol a second factor first.                                        |
| `kjohnson`   | reader          | Published, non-sensitive policies only.                                                           |
| `hlamarr`    | none            | Disabled: sign-in fails as the gateway's does.                                                    |

Rights follow steward-gateway: the category rules decide who authors and approves, a draft is only
its editors', and the case queue is the officers' alone. Steward AI isn't mocked: `aiHealth` says
`ai_service_unavailable` and every AI call answers as the gateway does while the ai service is down.

### Settings

| Variable                                      | What it does                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                        | The HTTP port (default 5180). `--port` on the command line wins.                                                                        |
| `HOST`                                        | Where to listen. Loopback by default, because the controls have no sign-in; set `0.0.0.0` to reach it from a phone on the same network. |
| `HTTPS_PORT`, `MOCK_TLS_CERT`, `MOCK_TLS_KEY` | Also serve HTTPS, for a client that refuses plain HTTP (an iOS app). `--https-port` on the command line sets the port.                  |
| `MOCK_CORS_ORIGINS`                           | Comma-separated origins allowed to call it with credentials, for a web client served from another port without a proxy.                 |
| `MOCK_SESSION_COOKIE`                         | The session cookie's name, when a client reads the real gateway's name.                                                                 |
| `MOCK_FRESH_INSTALL`                          | `1` starts it as a new install, so clients walk first-run setup.                                                                        |
| `MOCK_SERVER_VERSION`                         | The version the probes report.                                                                                                          |
| `LOG_LEVEL`, `LOG_FORMAT`                     | `trace` to `error`; `console` or `json`.                                                                                                |

## 🎛️ Controls

`POST /_mock/controls` with a JSON body takes a `kind`; `GET /_mock/controls` returns what's going
on, and `GET /_mock/state` the whole state.

| Kind             | Body                                   | What it does                                                                          |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `sign-in`        | `personId`, `token`                    | A finished sign-in in one step; `token: true` returns a bearer token.                 |
| `fail-next`      | `mode` (`graphql` or `http`), `status` | The next GraphQL call fails once.                                                     |
| `expire-session` | `personId` (optional)                  | Ends sessions; open websockets close with 4401.                                       |
| `reset`          |                                        | The sample data back; everyone stays signed in.                                       |
| `fresh`          | `firstRun`                             | Back to first boot: everyone signed out, and first-run setup when `firstRun` is true. |

The sample product adds `add-item` and `finish-items`.

## 📦 Use it from a client's tests

From another repo, run it as its own process and point the client at the port it prints:

```bash
node ../steward-mock-server/bin/steward-mock-server.mjs --port 0
```

Between test cases, `POST /_mock/controls` with `{"kind":"fresh"}` puts everything back. Node
doesn't run TypeScript from inside `node_modules`, so installing the mock as a dependency won't
start it; a clone beside the client, or a container, will.

Inside this repo, `src/index.ts` exports `startMockServer`, `handle` and `startFresh` for tests
that run it in-process.

## 🧩 Start a product's mock from it

[TEMPLATE.md](TEMPLATE.md) says how a product clones the template, re-brands it and fills in its
own protocol and data, and how it takes the template's later fixes.

## 🛠 Develop

```bash
npm run lint       # oxlint, then oxfmt --check (npm run format fixes the formatting)
npm run typecheck  # tsc
npm test           # node --test, against a real server on a free port
```

## 🙏 Acknowledgements

Steward was originally written by [@Bugs5382](https://github.com/Bugs5382).

## ⚖️ License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
