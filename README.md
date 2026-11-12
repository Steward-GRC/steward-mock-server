# steward-mock-server 🧩

> 🧭 Standalone in-memory mock of the whole Steward gateway API, shared by web, iOS and Android.

Steward's staff and admin apps talk to steward-gateway. To work on a screen without the whole
backend running, they talk to this instead: one Node process on port 5175 that answers the
gateway's paths in the gateway's shapes (`/query`, `/auth/*`, `/setup/*`, the probes), from
invented data that every client shares and anyone can put back with one click at `/_mock`. The
schema is steward-gateway's own, pinned to one commit in `schema-refs.env`. Fields the clients
need before the gateway ships them (for now `searchPolicies`, from steward-gateway#41, and the appendix life cycle) live apart
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
  an HTTP status), expire every session, put the sample data back, start fresh, start as a new
  install, or switch to the demo start state (no documents). A product adds its own buttons.
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

3. Open the controls at `http://localhost:5175/_mock`, or sign in from a client with a person's
   username and the password set for them (the seed's are `<username>-password`, and the Users card
   on `/_mock` changes them), then any six digits except `000000`. A refused sign-in answers an
   `error` code and a `message` a client can show.

### Sample data

The library is the design brief's sample organisation, so a screen compares 1:1 with its design
frame: the Workplace, People, Finance and Information categories; documents such as the Desk
Booking Policy (`POL-FACILITIES-000001`) and the Expense Claims Policy (`POL-EXPENSES-000002`); the
Finance team, Facilities team, All staff and Approvers groups; the Standard 2-stage and Finance
sign-off workflows; and the Standard Policy and Step-by-step Procedure templates. The people are
the eight below.

Every document's content is a Lexical document, as the editor saves it and steward-core reads it,
with real headings: the Desk Booking Policy is the design's reader frame (Purpose, Scope, Booking a
desk with its "Changing a booking" sub-section, Responsibilities as a table, and Appendix A: Desk
zones). Section keys are core's: a slug of each top-level heading (`booking-a-desk`), `-2`, `-3`
for a repeated heading, and `body` for text before the first one. `diffVersions` answers one entry
per section of the pinned template, keyed and word-diffed as core does.

### A new install

`MOCK_START=install` (or the controls page's "New install start state", or `MOCK_FRESH_INSTALL=1`) boots what
a real gateway has after its first boot: the basic setup (the category tree, templates and their
versions, workflows, groups, organisations and settings) and empty libraries, with no documents
and nobody to sign in as. `GET /setup/state` says `needsSetup: true`, so steward-web's admin app
opens first-run setup at `/admin/setup`.

The setup screens ask for the administrator's name, username, email and password (twice) and the
setup token (`mock-setup-token`, or `MOCK_SETUP_TOKEN`), then offer single sign-on now or later
(organisation, domain, identity provider and its settings). `POST /setup/bootstrap` makes the
first administrator, a site admin and the root admin, and signs nobody in, as the gateway does:
the screens then go to sign-in, where the new administrator signs in with those credentials and
can make the first policy.

The three start states, from most to least data:

| State              | People                      | Documents | First-run setup |
| ------------------ | --------------------------- | --------- | --------------- |
| `sample` (default) | the eight named, and extras | yes       | no              |
| `demo`             | the eight named             | none      | no              |
| `install`          | nobody                      | none      | yes             |

Reset and Start fresh return to the chosen state. For `install` they also sign everyone out and
bring first-run setup back, since the first administrator is gone. "Start as a new install" on
the controls page does the same once from any state, and leaves the chosen state alone.

### Who to sign in as

| Username  | Role                              | What they see                                                                                                                                                                                          |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alice`   | site admin                        | Everything; sensitive policies obfuscated until they break glass. The root admin. Asks for a second factor (an authenticator app, "Work phone").                                                       |
| `bob`     | author                            | The library, their drafts (sensitive ones too), authoring in every category.                                                                                                                           |
| `charlie` | approver                          | Published policies, the Travel Booking Procedure approval waiting on them, the Finance team group. Has an authenticator app and a passkey ("MacBook Touch ID").                                        |
| `dave`    | privacy officer, compliance admin | The report case queue and the compliance screens. Has to enrol a second factor first. Has a deny exception on the Lost Device Procedure.                                                               |
| `erin`    | reader                            | Published, non-sensitive policies only. Owes acknowledgements for the Expense Claims and Visitor Sign-in policies; has acknowledged Desk Booking. Has an allow exception on the Archive Access Policy. |
| `frank`   | none                              | Disabled: sign-in fails as the gateway's does.                                                                                                                                                         |
| `grace`   | template admin                    | The templates. Signs in with no second factor.                                                                                                                                                         |
| `heidi`   | group manager                     | Manages the Facilities team (My groups: Dave, Erin and Heidi), with no second factor.                                                                                                                  |

Everyone signs in with `<username>-password`.

### Roles and groups

Who someone is and what they may do comes from the mock's own store of people, which you edit in
the Users card on `/_mock`: each person's **roles** (the template's field) and **groups** (Steward's
own). Both are read on every request, so an edit applies to the next call with no new sign-in.

On the card, **Roles** is a dropdown of Steward's real roles (with `root`), **Groups** a dropdown of the
platform groups and a "Manages <group>" for each, and an info box says what every role and group grants, so none is a bare name.
Both lists come from `src/product/users-card.ts`, which reads the same table the permissions resolvers do.

- **Roles** are Steward's: `site-admin`, `author`, `approver`, `privacy-officer`,
  `compliance-admin` and `template-admin`. They decide permissions as identity's do. `root` among
  them makes the person a root admin, which the User type reports as `isRoot` rather than a role.
- **Groups** are free text. Each one is an IdP group, which the category access rules match, and
  a membership of the platform group with the same name ("All staff", "Finance team", "Facilities
  team", "Approvers"). "Manages <group>" makes the person that platform group's manager instead;
  that's mock only, since identity keeps managers apart. No group grants a role, as on the gateway.
- An edit on `/_mock` writes the store as it is: no Steward rules, checks or audit entries. When
  it changes someone's groups, roles, password or disabled flag, or adds or removes a person, the
  mock publishes this on `liveEvents`, so a signed-in app can refresh them:
  `{"type": "user.permissions_changed", "entityId": "user:<id>", "groupId": null, "actorUserId": null, "at": "<RFC 3339>"}`.
  `liveEvents` needs the audit log's read permission, as on the gateway.
- Steward's own admin mutations (`grantRole`, `grantRoot`, `addUserToGroup` and the rest) keep the
  gateway's rules and audit, and write the same roles and groups, so either side's change shows on
  the other.

Rights follow steward-gateway: the category rules decide who authors and approves, a draft is only
its editors', and the case queue is the officers' alone. A draft goes for review with
`submitWorkflow` on its home category's workflow; each approval that meets a stage's quorum moves
the run on, the last one publishes the policy, and a rejection marks run and policy rejected. Ask is simulated: `searchAndAnswer` quotes and cites the
published sections the signed-in person may read, `topPolicyQuestions` lists the questions asked, and `aiHealth` says available. The
**Simulated AI off** button on `/_mock` brings back the down service: `aiHealth` says `ai_service_unavailable`. The **AI provider** buttons simulate the model provider failing while the service answers: `aiHealth` says `provider_unavailable` and `providerReason` is `auth_failed`, `provider_error`, `not_configured`, `jobs_unavailable` (the ai service has no Kubernetes API, so the job submits fail too) or null (no reason); `providerReason` is null in every other state. **AI limit reached** simulates the organisation's monthly or the person's daily limit: `aiHealth` says `limit_reached` and the submits are refused with `FailedPrecondition`; a provider outage or the service being down is reported in its place. With the simulation on, `aiConfig` and `aiRetrievalConfig` answer a default config for a site admin (the settings changes still fail as the unreachable service). The AI jobs are
simulated too (generate a draft, review, revise, enrichment suggestions): a submit returns a job id, the job runs for about
2.5 seconds (`MOCK_AI_JOB_MS` changes it), `aiJob` and the `aiJobResult` subscription report it, and `aiJobResultContent` returns a
made-up result marked as simulated: sections, review findings, a change set. With the simulation off they fail as the gateway does while the ai
service is down. The admin AI settings answer that way on both settings.
The co-editing relay passes edits between the browsers on a draft and keeps the editor's
checkpoints the way steward-collab does: the content becomes the draft's saved content, the Yjs
state starts the next room after everyone has left, and the sender is told it was kept.

### Settings

| Variable                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                        | The HTTP port (default 5175). `--port` on the command line wins.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `HOST`                                        | Where to listen. Loopback by default, because the controls have no sign-in; set `0.0.0.0` to reach it from a phone on the same network.                                                                                                                                                                                                                                                                                                                                              |
| `HTTPS_PORT`, `MOCK_TLS_CERT`, `MOCK_TLS_KEY` | Also serve HTTPS, for a client that refuses plain HTTP (an iOS app). `--https-port` on the command line sets the port.                                                                                                                                                                                                                                                                                                                                                               |
| `MOCK_CORS_ORIGINS`                           | Comma-separated origins allowed to call it with credentials, for a web client served from another port without a proxy.                                                                                                                                                                                                                                                                                                                                                              |
| `MOCK_SESSION_COOKIE`                         | The session cookie's name, when a client reads the real gateway's name.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MOCK_FRESH_INSTALL`                          | `1` is the same as `MOCK_START=install`: a new install, so clients walk first-run setup.                                                                                                                                                                                                                                                                                                                                                                                             |
| `MOCK_START`                                  | `sample` (the default): the sample data, with its documents and eight named people. `demo`: the people, category tree, templates, workflows and groups, and no documents. `install`: a brand-new install, the basic setup (categories, templates, workflows, groups, empty libraries) and nobody to sign in as; first-run setup makes the first admin. Reset and Start fresh return to the chosen state; for `install` that means back to first-run setup, with everyone signed out. |
| `MOCK_SETUP_TOKEN`                            | The setup token first-run setup asks for (the gateway's `SETUP_TOKEN`). Default `mock-setup-token`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `MOCK_SERVER_VERSION`                         | The version the probes report.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LOG_LEVEL`, `LOG_FORMAT`                     | `trace` to `error`; `console` or `json`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Two people on two machines

To let someone else co-edit a draft with you against this mock, each person signs in as their own
person (the dev login lists them) in their own browser, so each has their own session cookie. Open
the mock and the web server to the network:

1. Start the mock with `HOST=0.0.0.0` (the controls have no sign-in, so do this on a network you
   trust).
2. Point the web server at it with `GATEWAY_URL=http://<this machine>:5175/query`. The browser never
   talks to the mock itself: it calls the web server's own `/query`, `/api/assets` and
   `/collab/ws/<draft>`, which relay to the mock and carry the person's session cookie, so the
   other machine only needs to reach the web server.
3. If a web client is served from a different origin than the one it calls, list that origin in
   `MOCK_CORS_ORIGINS`.
4. Both people open the same draft. Each edit reaches the other at once; every few seconds each
   side's autosave writes the draft, and the room's last checkpoint is what a person who joins
   later starts from.

One person in two tabs is one collaborator twice, not two collaborators.

### Starting a policy

A new policy starts from the template asked for, else from its category's default template (the
nearest category up the chain that sets one, or sets none). `setPolicyTemplate` changes it: with
`none: true` the policy is freeform and, if the author has not written in the starting draft yet,
the draft starts again blank; with a template its sections are put in the same way. A document with no text, spaces alone
not counting, can't be submitted for review (`submitWorkflow` answers a failed precondition).

### Locking a category's template

`setCategoryTemplateLock` (site admin) locks the template a category names: a policy created under
it, or under a category that inherits that template, must use it. `createPolicy` with another
template and `setPolicyTemplate` to freeform or another template answer a failed precondition. A
category with no default template can't be locked, and clearing its default lifts the lock.

### Appendices

An appendix belongs to a policy or procedure, never to one of its versions, and has a life of its
own: `createPolicyAppendix` makes a draft, `saveAppendixDraft` autosaves into it, `publishAppendix`
(authors and above) makes it the version readers see, and a later edit is a new draft beside the
published row. `retireAppendix` keeps it (hidden from readers, restorable with `restoreAppendix`);
only a site admin deletes one for good (`deleteAppendixForever`). Every version of a policy shows
the latest published appendices as its `appendices`. `appendixDiff` (draft against published) is for
authors, site admins and compliance only. Appendices take no part in an approval and nobody
comments on them. The older version-bound mutations (`addAppendix`, `updateAppendix`,
`deleteAppendix`, `reorderAppendices`) still answer: what they save is published at once.

A new appendix with a blank or missing title is called "Appendix A", "Appendix B" and so on: the
letter of its place, moving on while another appendix of the policy (retired ones too) has that
title. Renaming stays open. The seeded appendices already have titles that differ within a policy.

`contributors` on an appendix, and on each of its versions, lists everyone who ever saved or
published it (a co-editing checkpoint counts), in the order they first did, with their name and
`active` (a disabled or removed person stays listed with `active: false`). It is empty for anyone
who may not see the diff. `publishedVersions` lists the published rows latest first for the
Published tab drop-down (a reader gets the latest only); `versions` stays oldest first.
`appendixDiff(id, contentJson)` diffs the given text, not saved, against the published row, so the
diff can follow what the author is typing.

### Definitions, related items, references and contacts

The library items are not versioned. What a policy or procedure links to is stored WITH the policy
version (`policyVersionLinks`), so the links are approved with it, stay as approved once it is
published, and are copied into a new draft (from the rejected version after a rejection, otherwise
from the published one). `setVersionDefinitions`, `setVersionRelated`, `setVersionReferences` and
`setVersionContacts` replace one kind of link and only work while the version is a draft, in review
or withdrawn (otherwise FAILED_PRECONDITION); linking never creates a draft.

- Definitions are unique by title across the whole library (case and surrounding spaces ignored;
  a duplicate is ALREADY_EXISTS) and listed alphabetically.
- Related items name another policy and a relationship type from the fixed list
  (`relationshipTypes`: is related to / is related by, supersedes / is superseded by, depends on / is
  required by, implements / is implemented by, references / is referenced by). The other policy
  reads the link under the inverse type, from the linking policy's published version.
- References and contacts keep the order the author gave.
- The older per-policy queries (`relatedPolicies`, `policyReferences`, `policyContactBlocks`,
  `policyDefinitionEntries`) answer the policy's published version, else its draft. `usedByCount`
  counts policies, once each, whose published version or open draft links the item.

### The build commit

The mock reads the commit it started from (`git rev-parse --short HEAD`) once at start, shows it in
the /_mock header beside the version, and answers it as JSON at `GET /_mock/version`
(`{ name, version, commit }`) so a script can compare it with main.

### Co-editing inside an appendix

`issueAppendixCollabToken` (whoever may edit the policy) mints a token for the appendix's own room,
`/collab/ws/appendix:<id>`, away from the policy's draft. A checkpoint from that room becomes the
appendix's draft content (a draft is started from the published row if there is none) and leaves
what readers see alone until the appendix is published; a retired appendix has no room.

### Suggested changes and the review

A review thread can carry a suggestion: replacement text for the quoted words (`addReviewThread` with
`suggestedText`). The two sides take turns: `counterReviewSuggestion` answers with different text and
passes the turn, and `closeReviewSuggestion` ends it with an outcome and resolves the thread.

| Outcome      | Who and when                                                |
| ------------ | ----------------------------------------------------------- |
| `CHANGED`    | the author, on the author's turn: the text is taken         |
| `REMOVED`    | the author, on the author's turn: the note is dropped       |
| `AGREED`     | the approver, on the approver's turn: a counter is accepted |
| `NOT_AGREED` | the side whose turn it is, with a reason                    |
| `WITHDRAWN`  | the side that proposed first, while it is not their turn    |

The author is whoever may edit the policy and holds no seat on the version's run; anyone with a seat
acts as an approver. Each thread is with ONE approver: an approver's own thread is with that approver
and the author, and the author names the approver (`toUserId`) when writing first. An approver sees
only their own threads and cannot reply to, resolve, delete or answer anyone else's; the author sees
every thread and who wrote what. The mock keeps the rounds and the outcome and never changes the saved
document: the client applies an accepted text and saves the draft. Readers whose view is obfuscated get
no proposed text. The tests in `review-suggestions.test.ts` and `review-threads.test.ts` are the
reference for the Go services.

An approval and a rejection are votes against the stage's quorum. The stage is rejected as soon as the
approvals still possible (seats that have not voted plus those already given) can no longer reach the
number it needs, as well as when the rejects reach it: with two seats and a majority, one approve and
one reject is a rejection. A group counts the same way against its own required number. A rejection is
final: the rejected version stays as it was, and the author's next save starts a new draft that needs a
full new submission. Withdrawing a submission in review returns it to Draft.

A stage's quorum is `one`, `majority`, `all` or `nofm`, which takes `quorumN`, the approvals the stage
needs (a field the pinned gateway schema does not carry yet, so it sits in `schema-pending.graphql`).
Saving a workflow refuses an N below one, an N on another quorum and an N above the approvers named.
`submitWorkflow` refuses an N above the stage's votes, its approvers plus each group unit with
members. Approvers who cannot read the policy are not seated, and when the votes left cannot meet the
quorum the home category's owners are seated as individuals. `nofm.test.ts` is the reference.

An approver who sends comments back (`REQUEST_CHANGES`) keeps the seat pending with `comment` null, and the seat shows `changesRequested` (the latest comment) and `changesRequestedAt`, which stay after the seat decides and are null for a reader who sees the policy obfuscated. `changes-requested.test.ts` is the reference.

While a version is in review the author keeps editing it (`saveDraft` and the co-editing checkpoints
are accepted) and its status stays In review. Each approver is shown what changed since the text they
last reviewed: `versionChangesSinceReview` returns the sections that changed (an empty list when none did), and the snapshot moves forward
when that approver comments, replies, votes, sends comments (`SIGNAL_TYPE_REQUEST_CHANGES`: the seat
stays open and no status changes) or calls `markVersionReviewed`. The author has no such view, and
someone with no seat on the run is refused with `PermissionDenied`.

## 🎛️ Controls

`POST /_mock/controls` with a JSON body takes a `kind`; `GET /_mock/controls` returns what's going
on, `GET /_mock/state` the whole state, and `GET /_mock/people` the people who can sign in. Neither
ever includes a password: a person shows `hasPassword` instead, so a dev quick-login widget can
read the list live and offer exactly those people.

| Kind             | Body                                   | What it does                                                                                                                                                                           |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sign-in`        | `personId`, `token`                    | A sign-in in one step with the person's own password, skipping the second factor, for a dev quick-login widget; `token: true` returns a bearer token. A refusal says why in `message`. |
| `fail-next`      | `mode` (`graphql` or `http`), `status` | The next GraphQL call fails once.                                                                                                                                                      |
| `expire-session` | `personId` (optional)                  | Ends sessions; open websockets close with 4401.                                                                                                                                        |
| `reset`          |                                        | The sample data back; everyone stays signed in.                                                                                                                                        |
| `fresh`          | `firstRun`                             | Back to first boot: everyone signed out, and first-run setup when `firstRun` is true.                                                                                                  |

The maintenance cycle has its own kinds, and its own card on the page:

| Kind                   | Body                            | What it does                                                                                                                        |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `maintenance-announce` | `startsAt`, `endsAt`, `message` | A window ahead, which every client reads.                                                                                           |
| `maintenance-start`    | `endsAt`, `message` (optional)  | Maintenance on now, gated the way steward-gateway gates it (below): only GraphQL operations are refused, and `/readyz` stays ready. |
| `maintenance-update`   | `startsAt`, `endsAt`, `message` | Extend or change the window, announced or on.                                                                                       |
| `maintenance-end`      |                                 | Back to normal.                                                                                                                     |
| `maintenance-cancel`   |                                 | Drop an announcement that hasn't started.                                                                                           |

The people who can sign in have kinds of their own, and the Users card on the page:

| Kind            | Body                                                                                        | What it does                                                                               |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `person-add`    | `username`, and `name`, `email`, `roles`, `password`, `secondFactor`, `disabled` (optional) | Someone new who can sign in; `roles` is a list or a comma-separated string.                |
| `person-update` | `personId`, and any of the fields above                                                     | Changes what it's given. A password counts from the next sign-in; an empty one is ignored. |
| `person-remove` | `personId`                                                                                  | Takes the person out and ends their sessions.                                              |

A product's own person fields (`personFields`) are set the same way, by their key, and show in the
Users card. Reset and start fresh put the seed people back, and no maintenance. Steward answers the window the way
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
- **Reassigning a person's policies:** `reassignUserPolicies` moves every policy one person owns to
  another and rewrites the category rules that name them, each change audited, as steward-core
  does before an account is deleted.
- **Password and welcome email:** `resetUserPassword` answers true for a local account and
  replaces its password; `resendWelcomeEmail` answers true and sends
  nothing.
- **Root admins:** `requestStepUpOtp` "emails" the caller a code, which is any six digits but
  `000000` and works once; `grantRoot` and `revokeRoot` take it, from a root admin only, and the
  last root admin can't lose it.
- **Acting as someone:** `startImpersonation` makes every request on that admin's session (only
  that one) run as the target for 30 minutes, until `stopImpersonation`. `impersonationStatus`
  reports it, `diagnostics` names the real admin with the target as `actingAs`, the start and stop
  are audited under the admin, and the gateway's high-risk mutations are refused meanwhile with
  `IMPERSONATION_DENIED`.

### Profile pages

The signed-in person's own security and notification settings answer as steward-gateway does from
steward-identity and steward-obligations:

- **Second factors:** `enrollTotpBegin` hands out an authenticator app secret and
  `enrollTotpConfirm` takes any six digits but `000000` to switch it on. `myWebauthnCredentials`
  lists the person's passkeys oldest first (Charlie starts with "MacBook Touch ID").
  `webauthnRegisterBegin` and `webauthnRegisterFinish` add one, taking any well-formed credential
  because there's no authenticator behind the mock, and store it under the `id` it carries, so it
  signs in afterwards; an id already registered is refused. `renameMfaMethod` and
  `removeWebauthnCredential` work on one passkey, `removeFactor` with `passkey` removes them all,
  and the email factor can't be renamed or removed. Refusals
  the gateway turns into plain errors (already enrolled, nothing to confirm) come back as
  `INTERNAL`, as they do from the gateway.
- **Sessions:** `revokeMySessions` ends every session the person has, this one included, and
  answers how many.
- **Notifications:** `notificationSettings` answers obligations' defaults for anyone who saved
  nothing (email and in-app on, push off; every category immediate but informational, which is
  daily; digest at 08:00 on Mondays). Alice has saved choices: push on, workflow mail daily with
  approvals still immediate, and a 07:00 digest. `notificationTypeCatalog` lists the 27 types
  obligations' taxonomy classifies. `setCategoryCadence`, `setTypeCadence`, `setDigestWindow` and
  `setNotificationChannels` save the caller's choices; turning off a compliance, security or
  transactional category or type is refused with `NOTIFY_PREF_MANDATORY_OFF`, and an unknown type
  or a digest hour or day out of range with `NOTIFY_PREF_INVALID`.

### Acknowledgement activity

`ackActivity(policyVersionId, groupId, days)` answers the completion chart as steward-obligations
does: one entry per UTC day from `days - 1` days ago through today, oldest first, with empty days
included (a window of zero or less is 30 days). `acks` counts every acknowledgement of the version
that day, and `views` counts the distinct people the policy asks to acknowledge who viewed it that
day (`recordView` writes a view). The group is accepted and ignored, as obligations ignores it.
`completionReport`'s `viewedNotAckedCount` comes from the same views: the people in that
audience who ever viewed the version and haven't acknowledged it, so the chart and the report agree.
The seed spreads acknowledgements and views by Alice, Dave, Grace and Heidi, and views by the
others, over the last 90 days on the Desk Booking, Visitor Sign-in and Expense Claims policies,
dated from when the mock starts, so 30- and 90-day charts both show bars. Erin, Bob and Charlie
keep the obligations described above.

### Policy governance

The admin policy screen's governance actions answer as steward-gateway, steward-core and
steward-delivery do:

- `deletePolicy` deletes a policy that was never published, with its versions, for anyone who may
  author it; a policy that was ever published is refused (`FailedPrecondition`).
- `retirePolicy` sets `retiredAt` (once), hides the policy from category listings and ends its
  acknowledgement obligations; its history and completed acknowledgements stay.
- `setPolicyOwner` and `movePolicy` are for site admins. A move takes the next number in the
  target category's sequence (a counter that never goes back, as core's does); a move to the
  category it's in already does nothing.
- `requestPDFExport` answers a job that's ready at once. `pdfDownloadLink` answers a link, valid
  15 minutes, to `/delivery/pdf/<jobId>.pdf` on the mock, which serves a one-page sample PDF for
  every job (set `MOCK_PUBLIC_URL` when the mock isn't on `http://localhost:5175`).
- `createMagicLink` answers a 64-character token that lasts 30 days, or 48 hours for a sensitive
  link; `revokeMagicLink` is for site admins and answers true even for a token it doesn't know,
  as delivery does. A version the caller can't read in full is "policy version not found" for
  both the export and the link.

Each writes the services' audit entry: `policy.deleted`, `policy.retired`,
`policy.owner_changed`, `policy.moved`, `magic_link.created` and `magic_link.revoked`.

### Reference documents

Generate with AI's reference documents use steward-gateway's `POST /documents/extract` and
`POST /documents/validate-url`, with its shapes, limits and refusal texts, behind a signed-in
session.

- **Extract** (multipart, the file under `file`, up to 10 MB) answers `{title, content}`. Text and
  Markdown, Word (`.docx`) and RTF files are read the way the gateway reads them. A PDF or legacy
  Word (`.doc`) file that looks like one answers a fixed sample text instead, since the mock
  doesn't parse those formats; one that doesn't look like one is refused as the gateway does.
- **Validate a URL** (`{url}`) refuses what the gateway's URL guard refuses (a scheme other than
  http or https, no host, `localhost`, `.local` and `.internal` hosts, private, loopback and
  link-local addresses), then answers from the URL's shape without fetching it: a path with a
  sign-in marker (`login`, `signin`, `sign-in`, `/sso`, `authwall`) "requires a login", a host under
  `.invalid` "couldn't be reached", and anything else is readable, titled from its host and path.

### Editor images

The editor's image card uses steward-gateway's `POST /api/assets` and `GET /api/assets/{id}`, with
its shapes, limits and refusal texts, behind a signed-in session. The images live in memory and
Start fresh forgets them.

- **Upload** (multipart, the file under `file`, up to 10 MB) answers
  `{id, url, contentType, sizeBytes, filename}`; the `url` is `/api/assets/{id}`. Only PNG, JPEG,
  GIF and WebP are accepted, judged by the bytes and not by the declared type (SVG is refused). An
  empty file, a missing `file` and an oversized one answer 400 with the gateway's `{error}` text.
  A cookie session needs its CSRF token, as for any write.
- **Read** serves the bytes with the stored type. A cookie session needs no CSRF token, so an
  `<img src>` loads it. An unknown id answers 404 `Asset not found`.
- **Controls** (the Image uploads section of `/_mock`): `{"kind":"asset-upload","mode":"fail"}`
  makes uploads answer 503 `Failed to store image` until `"mode":"ok"`, and
  `{"kind":"asset-limit","limit":"small"}` lowers the cap to 100 KB so the too-large error shows
  without a huge file (`"limit":"real"` puts 10 MB back).

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

### Acknowledgement due dates

`dueAt` on `myObligations`, the roster's pending entries and every overdue entry of the completion
report is the version's publish time plus the due days (steward-obligations' `ACK_DUE_DAYS`): 14 by
default, or the `ACK_DUE_DAYS` environment variable. `ack-due-days` with `days` sets it from the
controls; 0 turns due dates off, so every `dueAt` is null. A reset brings back the default.

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

- **Password:** any person with their password (`<username>-password` unless the Users card
  changed it); Alice and Charlie then give any six
  digits but `000000`, and Dave enrols an authenticator first.
- **SSO:** a pass-through test, not the gateway's SSO flow. While SSO is on, `POST /auth/discover`
  sends anyone to the connection `mock-sso`, and `GET /auth/sso/start` signs the person straight
  in: whoever `identifier` names (email or username), or Erin when it names nobody the mock can
  sign in. It redirects to `/home` with the session cookie, or to
  `/login?pendingMfa=<id>&mfaFactors=...` when the person has a second factor (Alice, Charlie).
  It needs no connection or state, and there's no callback.
- **Password reset:** request a code for any address (the answer is always the same), then confirm
  with any six digits but `000000` and any new password. The mock sends no mail; the new password
  replaces the old one. A person without a local password, like Charlie,
  gets the gateway's invalid-code refusal.
- **Passkey:** there's no authenticator behind the mock, so it doesn't check signatures. The
  options it hands out are valid WebAuthn options, and the answer counts as the passkey whose
  `id` (or `rawId`) it carries, the way steward-gateway's own
  tests fake the ceremony. Charlie's passkey id is the base64url of `mock-passkey:charlie`
  (`bW9jay1wYXNza2V5OmNoYXJsaWU`). Post `{"id":"bW9jay1wYXNza2V5OmNoYXJsaWU"}` as the
  `credentialJson` to `/auth/passkey/login/finish`, or to `/auth/mfa/verify` with `kind: "passkey"`
  after `/auth/mfa/webauthn/begin`. In a browser, a Chrome DevTools virtual authenticator holding a
  resident credential with that id for `localhost` completes the prompt. The relying-party id is
  identity's `WEBAUTHN_RP_ID`: the host of `MOCK_PUBLIC_URL` when it's set, else the host the
  request came on. For passkey registration, which runs over GraphQL, that's the host the session
  signed in on; a session started from the controls gets identity's default, `localhost`.

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
