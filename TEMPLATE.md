# Using the template 🧩

> 🧭 How a product turns this template into its own mock gateway, and how it keeps taking the template's fixes afterwards

The template is two halves. `src/core/` is the server every product shares: the routes, the
sign-in, the websocket, the controls and the state. `src/product/` is what one product fills in:
its name, its schema, its data, its resolvers and its own controls. A product changes
`src/product/` and leaves `src/core/` alone, so a fix to the core moves into every product file for
file.

## 🧾 What a product fills in

| File                          | What it holds                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/product/product.ts`      | The one object the core is handed: the settings (name, default port, GraphQL path, session cookie, version header, the root fields anyone may read before signing in) and the four files below. |
| `src/product/schema.graphql`  | The gateway's GraphQL schema, or the part of it the mock serves. Copy it from the gateway; don't write one by hand.                                                                             |
| `src/product/data.ts`         | The invented data, made fresh on every reset: the people who can sign in, and the product's own records.                                                                                        |
| `src/product/resolvers.ts`    | What each field answers, by type and field name, reading and changing `mockState.data`.                                                                                                         |
| `src/product/controls.ts`     | The product's own buttons on `/_mock`, and the counts it shows.                                                                                                                                 |
| `src/product/product.test.ts` | The product's own tests, through the core. Replace them with tests for what the product fills in.                                                                                               |

Everything in `src/product/` today is a small invented example (items with an owner and a status)
that exercises every path: a public field, signed-in reads, a role-gated mutation and a
subscription. Replace it; don't build around it.

## 🚀 Start a product's mock, in order

### Before you start

- Node.js 24 or later.
- The product's repository, created on GitHub from this template ("Use this template"), named
  `<product>-mock-server`, and cloned locally.

### Steps

1. Install the dependencies. Always pass `--ignore-scripts`:

   ```bash
   npm ci --ignore-scripts
   ```

2. Re-brand it. In the settings in `src/product/product.ts`, set `name`, `port` (one no other
   product's mock uses, since several often run at once), `graphqlPath` (the real gateway's,
   `/query` on a gqlgen gateway), `sessionCookie` (the real gateway's cookie name) and
   `versionHeader` (the real gateway's). In `package.json`, set `name`, `description`, the
   `repository`, `homepage` and `bugs` URLs, and rename the `mock-server` command under `bin` to
   `<product>-mock-server`. Put the product's name in the README's title and first lines.

3. Copy the gateway's schema into `src/product/schema.graphql`.

4. Write the invented data in `src/product/data.ts`. Keep the people's shape (the sign-in routes
   read `username`, `email`, `roles`, `secondFactor` and `disabled`), use example.org addresses,
   and invent every name and record. Never copy real customer or production data into it.

5. Write the resolvers in `src/product/resolvers.ts`. Start with the fields the clients call
   first; anything without a resolver answers `null`, or an error where the schema says non-null.
   Use `signedIn(context)` and `withRole(context, role)` for the gateway's checks, throw
   `MockError` with the gateway's codes, and `publish` a change on a topic so the matching
   subscription hears it.

6. Add the product's controls in `src/product/controls.ts`: the things that happen elsewhere and
   that a client needs to see happen (a new record arriving, an approval coming in).

7. When the gateway's sign-in differs from `/auth/login` and `/auth/verify` (another path, an
   identity provider's flow), change `src/core/auth.ts` to match it, change the sign-in tests in
   `src/core/server.test.ts` to match, and say in the PR which part of the core moved. That's the
   one part of the core a product is expected to change; every other file in `src/core/` stays the
   template's, byte for byte.

8. Replace the sample's tests in `src/product/product.test.ts` with the product's own. The core's
   tests run against a fixture product of their own (`src/core/test-fixture.ts`), never
   `src/product/`, so they pass unchanged whatever the product is.

9. Run the checks, then commit in one PR and say in its body which template commit the product
   started from (`git log -1 --format=%H` before step 2). That commit is where the next sync
   starts.

   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

## 🔁 Taking later template fixes

A fix to the core lands here first; each product then takes it in its own PR, commit by commit.

1. Add the template as a second remote, once, and fetch it:

   ```bash
   git remote add template https://github.com/the-rabbit-hole-tech/template-node-mock-server.git
   git fetch template
   ```

2. On a branch, list the template commits since the last sync and take each fix:

   ```bash
   git log --oneline <last-synced>..template/main
   git cherry-pick -x <commit>
   ```

   `-x` records the template commit in the product's commit message, so the next sync knows where
   to start.

3. A conflict in `src/product/` keeps the product's side. A conflict in `src/core/` is a place the
   product changed the core (the GraphQL path, the sign-in): keep the product's change and the
   template's fix around it.

4. Run the checks and open the PR.

## 📐 What belongs here, and what doesn't

- ✅ **In the template:** what every product's mock does the same way: the server, the wire
  protocol's transport, sessions and tokens, the websocket, the controls, the state and its reset.
- 🚫 **Not in the template:** any product's name, schema, data or rules. That stays in the
  product's repo.
- 🔄 **Kept current:** when a product's mock improves or fixes a shared part, the same change comes
  back here in that wave, then goes out to the other products.
