# steward-mock-server 🧩

> 🧭 Standalone in-memory mock of the whole Steward gateway API, shared by web, iOS and Android.

Steward's staff and admin apps talk to steward-gateway. To work on a screen without the whole
backend running, they talk to this instead: one Node process on port 5175 that answers the
gateway's paths in the gateway's shapes (`/query`, `/auth/*`, `/setup/*`, the probes), from
invented data that every client shares and anyone can put back with one click at `/_mock`. The
schema is steward-gateway's own, pinned to one commit in `schema-refs.env`. Fields the clients
need before the gateway ships them (for now `searchPolicies`, from steward-gateway#41) live apart
in `src/product/schema-pending.graphql` and leave it once the pinned copy carries them.

## ✨ Highlights

- 🔌 **The gateway's wire protocol:** GraphQL at `POST /query` and `GET /query`, a websocket on the
  same path for subscriptions (`graphql-transport-ws`, and the older `graphql-ws` that some mobile
  clients still speak), sign-in under `/auth/*`, first-run setup under `/setup/*`, the
  `/livez`, `/readyz` and `/healthz` probes, and the editor's co-editing relay at
  `/collab/ws/<draftId>` (the session cookie and the token from `issueCollabToken`).
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

   It listens on `http://localhost:5175`. Pass `-- --port 0` for a free port; the ready line says
   which one it got.

3. Open the controls at `http://localhost:5175/_mock`, or sign in from a client: any person listed
   at `/_mock/people`, any password except `wrong-password`, then any six digits except `000000`.

### Sample data

The library is the design brief's sample organisation, so a screen compares 1:1 with its design
frame: the Workplace, People, Finance and Information categories; documents such as the Desk
Booking Policy (`POL-FACILITIES-000001`) and the Expense Claims Policy (`POL-EXPENSES-000002`); the
Finance team, Facilities team, All staff and Approvers groups; the Standard 2-stage and Finance
sign-off workflows; and the Standard Policy and Step-by-step Procedure templates. The people are
the six below.

Every document's content is a Lexical document, as the editor saves it and steward-core reads it,
with real headings: the Desk Booking Policy is the design's reader frame (Purpose, Scope, Booking a
desk with its "Changing a booking" sub-section, Responsibilities as a table, and Appendix A: Desk
zones). Section keys are core's: a slug of each top-level heading (`booking-a-desk`), `-2`, `-3`
for a repeated heading, and `body` for text before the first one. `diffVersions` answers one entry
per section of the pinned template, keyed and word-diffed as core does.

### Who to sign in as

| Username  | Role            | What they see                                                                                                                                                                                          |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alice`   | site admin      | Everything; sensitive policies obfuscated until they break glass. The root admin. Asks for a second factor (an authenticator app, "Work phone").                                                       |
| `bob`     | author          | The library, their drafts (sensitive ones too), authoring in every category.                                                                                                                           |
| `charlie` | approver        | Published policies, the Travel Booking Procedure approval waiting on them, the Finance team group. Has an authenticator app and a passkey ("MacBook Touch ID").                                        |
| `dave`    | privacy officer | The report case queue. Has to enrol a second factor first. Has a deny exception on the Lost Device Procedure.                                                                                          |
| `erin`    | reader          | Published, non-sensitive policies only. Owes acknowledgements for the Expense Claims and Visitor Sign-in policies; has acknowledged Desk Booking. Has an allow exception on the Archive Access Policy. |
| `frank`   | none            | Disabled: sign-in fails as the gateway's does.                                                                                                                                                         |

Rights follow steward-gateway: the category rules decide who authors and approves, a draft is only
its editors', and the case queue is the officers' alone. A draft goes for review with
`submitWorkflow` on its home category's workflow; each approval that meets a stage's quorum moves
the run on, the last one publishes the policy, and a rejection marks run and policy rejected. Steward AI isn't mocked: `aiHealth` says
`ai_service_unavailable` and every AI call answers as the gateway does while the ai service is down.
The co-editing relay passes edits between the browsers on a draft but doesn't keep the editor's
checkpoints the way steward-collab does: the editor's Save button writes the draft.

### Settings

| Variable                                      | What it does                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                        | The HTTP port (default 5175). `--port` on the command line wins.                                                                        |
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

The maintenance cycle has its own kinds, and its own card on the page:

| Kind                   | Body                            | What it does                                                                                                                        |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `maintenance-announce` | `startsAt`, `endsAt`, `message` | A window ahead, which every client reads.                                                                                           |
| `maintenance-start`    | `endsAt`, `message` (optional)  | Maintenance on now, gated the way steward-gateway gates it (below): only GraphQL operations are refused, and `/readyz` stays ready. |
| `maintenance-update`   | `startsAt`, `endsAt`, `message` | Extend or change the window, announced or on.                                                                                       |
| `maintenance-end`      |                                 | Back to normal.                                                                                                                     |
| `maintenance-cancel`   |                                 | Drop an announcement that hasn't started.                                                                                           |

Reset and start fresh put it back to no maintenance. Steward answers the window the way
steward-gateway does:

- **Announced:** `globalSettings.announcement` is a `warning` announcement with the window's
  message (or a line naming the window when it has none), and `maintenance.enabled` stays false.
  Nothing is locked.
- **On:** `globalSettings.maintenance` reports `enabled: true` with the message. GraphQL answers
  only operations whose root fields are all on the gateway's whitelist (`globalSettings`, `me`,
  `__schema`, `__type`); anything else answers 200 with the gateway's `MAINTENANCE` error. A site
  admin runs every operation, as on the gateway, so the admin console stays open to them. The same
  goes for each operation on the GraphQL websocket: a site admin's subscription runs, and anyone
  else's beyond the whitelist fails with `MAINTENANCE`.
- **Everything else stays open,** as the gateway's gate is GraphQL only: sign-in (`/auth`),
  `/setup`, the SSO admin routes, `GET /maintenance`, every other route, new websockets (GraphQL
  and co-editing), and `/readyz`, which stays ready.
- `GET /maintenance` answers `{enabled, message}`, as the gateway's public route does.
- A site admin's `setGlobalSettings` is the gateway's maintenance switch: saving
  `maintenance.enabled` true starts maintenance with its message, and saving it false ends it,
  just as `maintenance-start` and `maintenance-end` do.

Steward adds `idp-test-outcome`, `expire-test-links`, `needs-onboarding` and `sign-in-methods`
below.

### User administration

The admin user screens answer as steward-gateway and steward-identity do:

- **Policy exceptions:** `setUserPolicyOverride` stores or (with no effect) clears a person's
  exception for one policy number, and `policyOverrides` on a user lists them. The exceptions are
  shown and kept, but the mock's read model doesn't apply them.
- **Second factors:** `userFactors` lists the authenticator app, each passkey and the implicit
  email factor, and `removeUserMfaFactor` and `renameUserMfaFactor` change them. Removing one
  takes it off sign-in too. `myFactors` is the signed-in person's own list (one passkey entry,
  unlabelled); Erin has only the email factor, so steward-web nudges her towards a stronger one.
- **Password and welcome email:** `resetUserPassword` answers true for a local account (the
  password isn't kept, since any password signs in); `resendWelcomeEmail` answers true and sends
  nothing.
- **Root admins:** `requestStepUpOtp` "emails" the caller a code, which is any six digits but
  `000000` and works once; `grantRoot` and `revokeRoot` take it, from a root admin only, and the
  last root admin can't lose it.
- **Acting as someone:** `startImpersonation` makes every request on that admin's session (only
  that one) run as the target for 30 minutes, until `stopImpersonation`. `impersonationStatus`
  reports it, `diagnostics` names the real admin with the target as `actingAs`, the start and stop
  are audited under the admin, and the gateway's high-risk mutations are refused meanwhile with
  `IMPERSONATION_DENIED`.

### Category access

Each category keeps its own access rules (`categoryRuleset`, `setCategoryRuleset`), as
steward-core stores them; the admin console shows an ancestor's rules by reading that category's.
The seed follows the design's A5 frame:

- **Workplace:** Everyone may read.
- **Workplace › Facilities:** the Facilities team may do everything; All staff may read and
  acknowledge, and may not author.
- **Finance:** Everyone may read. Alice owns it.
- **Finance › Expenses:** the Finance team may do everything; Erin may not approve or author; All
  staff may read.

Group rules match a person's IdP groups: Bob is in All staff, Charlie in the Finance team and All
staff, and Erin in All staff and the Facilities team. `simulateCategory` evaluates the chain as
steward-authz does, with its reasons ("rule #2 deny group All staff", "↳ Workplace #1 allow
everyone", "owner (auto read/approve/author)", "no rule → default deny"); an empty `userId` is the
baseline for no one in particular. The rules drive the simulator only: who reads, approves and
authors elsewhere in the mock still follows each category's owners and approve and author lists.

### Onboarding

`needs-onboarding` with `personId` (and `needsOnboarding: false` to clear it) marks a person as
still owing first-run onboarding, so `me.needsOnboarding` is true and steward-web shows the welcome
page (G10). `completeOnboarding` clears it the gateway's way: the terms must be accepted, a sent
first or last name sets the name (derived as "first last"), a sent non-empty email replaces the
email, and a sent username must be non-empty (`InvalidArgument`) and free (`AlreadyExists`). The
"Erin owes onboarding" button on `/_mock` marks Erin. A reset clears it.

### Sign-in methods

`/auth/config` answers what steward-gateway's does, and `sign-in-methods` switches each method, so
every variant of the sign-in page shows. Everything is on after a reset or a fresh start.

| Body field           | Values            | What it does                                                                                                                                                                                                                         |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sso`                | `true` or `false` | `ssoAvailable`, and whether `/auth/discover` sends everyone to SSO or to the password.                                                                                                                                               |
| `passkey`            | `true` or `false` | `passkeyEnabled`; off, passkey sign-in answers 404 `passkey_unavailable`.                                                                                                                                                            |
| `passwordReset`      | `true` or `false` | The gateway has no switch for it: steward-web offers the reset whenever `/auth/config` answers. Off answers like a gateway without the reset routes: `/auth/config` and the reset routes 404, and the page offers the password only. |
| `defaultLoginMethod` | `local` or `sso`  | The method the page shows first.                                                                                                                                                                                                     |

How to walk each method:

- **Password:** any person, any password but `wrong-password`; Alice and Charlie then give any six
  digits but `000000`, and Dave enrols an authenticator first.
- **SSO:** a pass-through test, not the gateway's SSO flow. While SSO is on, `POST /auth/discover`
  sends anyone to the connection `mock-sso`, and `GET /auth/sso/start` signs the person straight
  in: whoever `identifier` names (email or username), or Erin when it names nobody the mock can
  sign in. It redirects to `/home` with the session cookie, or to
  `/login?pendingMfa=<id>&mfaFactors=...` when the person has a second factor (Alice, Charlie).
  It needs no connection or state, and there's no callback.
- **Password reset:** request a code for any address (the answer is always the same), then confirm
  with any six digits but `000000` and any new password. The mock sends no mail and doesn't keep
  the new password, since any password signs in. A person without a local password, like Charlie,
  gets the gateway's invalid-code refusal.
- **Passkey:** there's no authenticator behind the mock, so it doesn't check signatures. The
  options it hands out are valid WebAuthn request options for the host the caller used, and the
  answer counts as the passkey whose `id` (or `rawId`) it carries, the way steward-gateway's own
  tests fake the ceremony. Charlie's passkey id is the base64url of `mock-passkey:charlie`
  (`bW9jay1wYXNza2V5OmNoYXJsaWU`). Post `{"id":"bW9jay1wYXNza2V5OmNoYXJsaWU"}` as the
  `credentialJson` to `/auth/passkey/login/finish`, or to `/auth/mfa/verify` with `kind: "passkey"`
  after `/auth/mfa/webauthn/begin`. In a browser, a Chrome DevTools virtual authenticator holding a
  resident credential with that id for `localhost` completes the prompt.

## 📦 Use it from a client's tests

From another repo, run it as its own process and point the client at the port it prints:

```bash
node ../steward-mock-server/bin/steward-mock-server.mjs --port 0
```

Between test cases, `POST /_mock/controls` with `{"kind":"fresh"}` puts everything back. Node
doesn't run TypeScript from inside `node_modules`, so installing the mock as a dependency won't
start it; a clone beside the client, or a container, will.

Inside this repo, `src/index.ts` exports `useProduct`, `startMockServer`, `handle` and `startFresh`
for tests that run it in-process: hand it a product first, then start it.

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
