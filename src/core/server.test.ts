// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The core's tests. They run against the test-only fixture product (src/core/test-fixture.ts),
// never src/product, so they pass unchanged in a product that replaced the sample.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";

import type { RunningMockServer } from "#core/server.ts";

import { listen } from "#core/events.ts";
import { handle } from "#core/handle.ts";
import { MAINTENANCE_CHANGED } from "#core/maintenance.ts";
import {
  control,
  GOOD_CODE,
  headersFor,
  openSocket,
  post,
  query,
  signIn,
  startForTests,
  startFresh,
  WRONG_CODE,
} from "#core/test-client.ts";
import { fixture, FIXTURE_VERSION } from "#core/test-fixture.ts";

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});

describe("health", () => {
  it("answers every probe with the product's version header", async () => {
    for (const path of ["/livez", "/readyz", "/healthz"]) {
      const answer = await fetch(`${base}${path}`);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("fixture-version"), FIXTURE_VERSION);
    }
  });

  it("stays up when the controls armed a failure", async () => {
    await control(base, { kind: "fail-next", mode: "http", status: 503 });
    assert.equal((await fetch(`${base}/livez`)).status, 200);
  });
});

describe("sign-in", () => {
  it("refuses a wrong password, an unknown person and a disabled account", async () => {
    assert.equal(
      (
        await post(base, "/auth/login", {
          password: "wrong-password",
          username: "ben",
        })
      ).status,
      401,
    );
    assert.equal(
      (await post(base, "/auth/login", { password: "x", username: "nobody" }))
        .status,
      401,
    );
    assert.equal(
      (await post(base, "/auth/login", { password: "x", username: "dot" }))
        .status,
      403,
    );
  });

  it("asks for the second factor and refuses the wrong code", async () => {
    const login = (await (
      await post(base, "/auth/login", { password: "x", username: "ada" })
    ).json()) as Record<string, string>;
    assert.equal(login.mfaRequired, true);
    assert.equal(
      (
        await post(base, "/auth/verify", {
          code: WRONG_CODE,
          pendingId: login.pendingId,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post(base, "/auth/verify", {
          code: GOOD_CODE,
          pendingId: login.pendingId,
        })
      ).status,
      200,
    );
  });

  it("uses the product's session cookie and needs the CSRF header with it", async () => {
    const ada = await signIn(base, "ada");
    assert.match(ada.cookie, /^fixture_session=/);
    const without = await post(
      base,
      "/gql",
      { query: "{ me { name } }" },
      { cookie: ada.cookie },
    );
    assert.equal(without.status, 401);
    const { body } = await query(base, "{ me { name } }", ada);
    assert.deepEqual(body.data, { me: { name: "Ada Admin" } });
  });

  it("reports and ends the session", async () => {
    const ben = await signIn(base, "ben");
    const session = (await (
      await fetch(`${base}/auth/session`, { headers: { cookie: ben.cookie } })
    ).json()) as Record<string, unknown>;
    assert.equal(session.personId, "person-ben");
    await post(base, "/auth/logout", {}, { cookie: ben.cookie });
    assert.equal((await query(base, "{ me { name } }", ben)).status, 401);
  });

  it("gives a native client a bearer token that works without a cookie", async () => {
    const cy = await signIn(base, "cy", true);
    assert.ok(cy.token);
    const { body } = await query(base, "{ me { username } }", {
      cookie: "",
      csrf: "",
      token: cy.token,
    });
    assert.deepEqual(body.data, { me: { username: "cy" } });
  });
});

describe("GraphQL", () => {
  it("serves on the product's own path and nowhere else", async () => {
    assert.equal(
      (await post(base, "/gql", { query: "{ status { name } }" })).status,
      200,
    );
    assert.equal(
      (await post(base, "/query", { query: "{ status { name } }" })).status,
      501,
    );
  });

  it("answers a public field before sign-in and refuses the rest", async () => {
    const open = await query(base, "{ status { name } }");
    assert.deepEqual(open.body.data, { status: { name: "Fixture" } });
    const closed = await query(base, "{ status { name } notes { id } }");
    assert.equal(closed.status, 401);
    assert.equal(closed.body.errors?.[0]?.extensions.code, "UNAUTHENTICATED");
  });

  it("refuses what the schema doesn't have, and what doesn't parse", async () => {
    const ben = await signIn(base, "ben");
    const invalid = await query(base, "{ me { shoeSize } }", ben);
    assert.equal(invalid.status, 422);
    assert.equal(
      invalid.body.errors?.[0]?.extensions.code,
      "GRAPHQL_VALIDATION_FAILED",
    );
    const broken = await query(base, "{ me {", ben);
    assert.equal(
      broken.body.errors?.[0]?.extensions.code,
      "GRAPHQL_PARSE_FAILED",
    );
  });

  it("answers a role check with FORBIDDEN and a missing record with NOT_FOUND", async () => {
    const ben = await signIn(base, "ben");
    const refused = await query(
      base,
      'mutation { removeNote(id: "note-1") }',
      ben,
    );
    assert.equal(refused.body.errors?.[0]?.extensions.code, "FORBIDDEN");
    const ada = await signIn(base, "ada");
    assert.deepEqual(
      (await query(base, 'mutation { removeNote(id: "note-1") }', ada)).body
        .data,
      { removeNote: true },
    );
    const gone = await query(
      base,
      'mutation { removeNote(id: "note-1") }',
      ada,
    );
    assert.equal(gone.body.errors?.[0]?.extensions.code, "NOT_FOUND");
  });

  it("shares one state between every client", async () => {
    const ben = await signIn(base, "ben");
    const cy = await signIn(base, "cy", true);
    await query(
      base,
      "mutation ($t: String!) { addNote(text: $t) { id } }",
      ben,
      { t: "Shared" },
    );
    const { body } = await query(
      base,
      "{ notes { text author { username } } }",
      cy,
    );
    assert.ok(
      (
        body.data?.notes as { author: { username: string }; text: string }[]
      ).some(
        (note) => note.text === "Shared" && note.author.username === "ben",
      ),
    );
  });

  it("takes a query in the URL but never a mutation", async () => {
    const ben = await signIn(base, "ben");
    const read = await fetch(
      `${base}/gql?query=${encodeURIComponent("{ me { username } }")}`,
      { headers: headersFor(ben) },
    );
    assert.equal(read.status, 200);
    const write = await fetch(
      `${base}/gql?query=${encodeURIComponent('mutation { removeNote(id: "note-1") }')}`,
      { headers: headersFor(ben) },
    );
    assert.equal(write.status, 405);
  });
});

describe("controls", () => {
  it("fails the next call once, as GraphQL or as HTTP", async () => {
    const ben = await signIn(base, "ben");
    await control(base, { kind: "fail-next" });
    assert.equal(
      (await query(base, "{ me { name } }", ben)).body.errors?.[0]?.extensions
        .code,
      "INTERNAL",
    );
    assert.ok((await query(base, "{ me { name } }", ben)).body.data);
    await control(base, { kind: "fail-next", mode: "http", status: 503 });
    assert.equal(
      (await post(base, "/gql", { query: "{ me { name } }" }, headersFor(ben)))
        .status,
      503,
    );
  });

  it("puts the data back and keeps people signed in", async () => {
    const ada = await signIn(base, "ada");
    await query(base, 'mutation { removeNote(id: "note-1") }', ada);
    await control(base, { kind: "reset" });
    const { body } = await query(base, '{ note(id: "note-1") { id } }', ada);
    assert.deepEqual(body.data, { note: { id: "note-1" } });
  });

  it("starts fresh with everyone signed out", async () => {
    const ben = await signIn(base, "ben");
    await control(base, { kind: "fresh" });
    assert.equal((await query(base, "{ me { name } }", ben)).status, 401);
  });

  it("signs someone in at once, and refuses an unknown kind", async () => {
    const answer = await post(base, "/_mock/controls", {
      kind: "sign-in",
      personId: "person-cy",
      token: true,
    });
    assert.ok(((await answer.json()) as Record<string, string>).accessToken);
    assert.equal(
      (await post(base, "/_mock/controls", { kind: "nope" })).status,
      400,
    );
  });

  it("runs the product's own controls and shows its summary", async () => {
    const state = await control(base, {
      kind: "add-note",
      text: "From the page",
    });
    assert.deepEqual(state.summary, {
      notes: 3,
      signInMethods: "passkey, passwordReset, sso",
    });
    assert.ok(
      (state.actions as { kind: string }[]).some(
        (action) => action.kind === "add-note",
      ),
    );
  });

  it("serves its page under the product's name and version", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(html, /<title>Mock controls · Fixture<\/title>/);
    assert.match(html, /class="brand__name">Fixture</);
    assert.ok(html.includes(FIXTURE_VERSION));
  });

  it("is reachable by keyboard and at phone width", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(
      html,
      /<meta name="viewport" content="width=device-width, initial-scale=1">/,
    );
    assert.match(html, /<a class="skip-link" href="#main">/);
    assert.match(html, /<main [^>]*id="main"/);
    assert.match(
      html,
      /<button [^>]*aria-controls="sidebar"[^>]*aria-label="Open menu"/,
    );
    assert.match(html, /:focus-visible/);
  });

  it("follows the system theme until a theme is saved", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(
      html,
      /<html lang="en" data-theme="light" data-theme-choice="system">/,
    );
    assert.match(html, /prefers-color-scheme: dark/);
  });

  it("saves the theme setting and serves the page in it", async () => {
    const saved = await post(base, "/_mock/theme", { theme: "dark" });
    assert.equal(saved.status, 204);
    const cookie =
      (saved.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    assert.equal(cookie, "mock_theme=dark");
    const html = await (
      await fetch(`${base}/_mock`, { headers: { cookie } })
    ).text();
    assert.match(
      html,
      /<html lang="en" data-theme="dark" data-theme-choice="dark">/,
    );
    assert.match(html, /aria-label="Switch to light theme"/);
  });

  it("refuses a theme it doesn't know", async () => {
    assert.equal(
      (await post(base, "/_mock/theme", { theme: "sepia" })).status,
      400,
    );
  });

  it("puts each section on its own full-width row", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(
      html,
      /\.cards \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/,
    );
    assert.doesNotMatch(
      html,
      /\.(?:card|cards|tiles|head|main) \{[^}]*max-width/,
    );
  });

  it("shows the product's summary as tiles", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(
      html,
      /<div class="tile"><span class="tile__label">notes<\/span><span class="tile__value">2<\/span><\/div>/,
    );
  });

  it("keeps the tiles intact at any width, text values and long labels included", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    // A text value gets the smaller, wrapping style, in the first render and in the script's.
    assert.match(
      html,
      /<span class="tile__label">signInMethods<\/span><span class="tile__value tile__value--text">passkey, passwordReset, sso<\/span>/,
    );
    assert.match(html, /"tile__value tile__value--text"/);
    // Columns never ask for more than the row has, tiles can shrink, and nothing overflows.
    assert.match(
      html,
      /\.tiles \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(170px, 100%\), 1fr\)\)/,
    );
    assert.match(html, /\.tile \{[^}]*min-width: 0/);
    assert.match(html, /\.tile__label \{[^}]*overflow-wrap: anywhere/);
    assert.match(html, /\.tile__value \{[^}]*overflow-wrap: anywhere/);
    assert.match(html, /\.tile__value--text \{[^}]*font: 700 16px/);
  });

  it("lays out the shell: rail toggle, mock badge, sidebar and page head", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(html, /<span class="badge badge--env">Mock<\/span>/);
    assert.match(
      html,
      /<aside class="sidebar" id="sidebar" aria-label="Sidebar">/,
    );
    assert.match(
      html,
      /<span class="eyebrow">Mock gateway<\/span><h1 class="title">Controls<\/h1>/,
    );
  });

  it("still drives the controls from the page", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(html, /fetch\("\/_mock\/controls"/);
    assert.match(html, /kind: "sign-in"/);
  });
});

describe("product routes and schema", () => {
  it("serves the product's own routes, with the session", async () => {
    const ben = await signIn(base, "ben");
    const answer = await fetch(`${base}/fixture/whoami`, {
      headers: headersFor(ben),
    });
    assert.deepEqual(await answer.json(), { personId: "person-ben" });
    const anonymous = await fetch(`${base}/fixture/whoami`);
    assert.deepEqual(await anonymous.json(), { personId: null });
  });

  it("runs product routes ahead of the core's /auth catch-all", async () => {
    const answer = await fetch(`${base}/auth/fixture-start`, {
      redirect: "manual",
    });
    assert.equal(answer.status, 302);
    assert.equal(answer.headers.get("location"), "/signed-in");
    assert.equal((await fetch(`${base}/auth/unknown`)).status, 404);
  });

  it("never lets a product route replace the core's own paths", async () => {
    assert.equal((await fetch(`${base}/livez`)).status, 200);
  });

  it("answers 500 when a route throws, instead of leaving the client waiting", async () => {
    const answer = await fetch(`${base}/fixture/boom`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(answer.status, 500);
    assert.deepEqual(await answer.json(), { error: "internal" });
  });

  it("answers 501 when neither the core nor the product serves a path", async () => {
    assert.equal((await fetch(`${base}/fixture/elsewhere`)).status, 501);
  });

  it("serves schema from a second SDL file", async () => {
    const ben = await signIn(base, "ben");
    const { body } = await query(base, "{ noteCount }", ben);
    assert.deepEqual(body.data, { noteCount: 2 });
  });
});

/** Open a socket on a product path: the open socket, or the HTTP answer that refused it. */
const connect = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ body?: string; socket: WebSocket; status?: number }>(
    (resolve, reject) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}${path}`, {
        headers,
      });
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += String(chunk)));
        response.on("end", () =>
          resolve({ body, socket, status: response.statusCode }),
        );
      });
      socket.once("error", (error) => {
        if (!String(error).includes("Unexpected server response"))
          reject(error);
      });
    },
  );

describe("product websockets", () => {
  it("refuses an upgrade without a session with the product's own answer", async () => {
    const refused = await connect("/fixture/relay/draft-1");
    assert.equal(refused.status, 401);
    assert.equal(refused.body, "unauthorized");
  });

  it("answers 404 to an upgrade on a path nobody serves", async () => {
    const ben = await signIn(base, "ben");
    const refused = await connect("/fixture/elsewhere", { cookie: ben.cookie });
    assert.equal(refused.status, 404);
  });

  it("hands the product the socket, so it can relay between clients on one path", async () => {
    const ben = await signIn(base, "ben");
    const cy = await signIn(base, "cy");
    const one = (
      await connect("/fixture/relay/draft-1", { cookie: ben.cookie })
    ).socket;
    const two = (await connect("/fixture/relay/draft-1", { cookie: cy.cookie }))
      .socket;
    const other = (
      await connect("/fixture/relay/draft-2", { cookie: cy.cookie })
    ).socket;
    const heard: string[] = [];
    other.on("message", (data) => heard.push(String(data)));
    const received = new Promise<string>((resolve) =>
      two.once("message", (data) => resolve(String(data))),
    );
    one.send("hello");
    assert.equal(await received, "hello");
    await new Promise((settle) => setTimeout(settle, 50));
    assert.deepEqual(heard, []);
    for (const socket of [one, two, other]) socket.close();
  });
});

const hour = 3_600_000;

/** A maintenance window starting `fromNow` milliseconds ahead and lasting `length`. */
const window = (fromNow: number, length: number) => ({
  endsAt: new Date(Date.now() + fromNow + length).toISOString(),
  startsAt: new Date(Date.now() + fromNow).toISOString(),
});

/** The fixture's maintenance banner, as a client reads it before signing in. */
const banner = async () =>
  (await query(base, "{ maintenance { state message startsAt endsAt } }")).body
    .data?.maintenance as Record<string, unknown>;

describe("maintenance", () => {
  it("announces a window that every client reads, and answers as normal meanwhile", async () => {
    const ahead = window(hour, hour);
    const state = await control(base, {
      kind: "maintenance-announce",
      message: "Upgrading the database",
      ...ahead,
    });
    assert.deepEqual(
      (state.maintenance as Record<string, unknown>).state,
      "announced",
    );
    assert.deepEqual(await banner(), {
      message: "Upgrading the database",
      state: "announced",
      ...ahead,
    });
    const ben = await signIn(base, "ben");
    assert.equal((await query(base, "{ notes { id } }", ben)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  });

  it("refuses a window that ends before it starts", async () => {
    const backwards = {
      endsAt: new Date().toISOString(),
      kind: "maintenance-announce",
      startsAt: new Date(Date.now() + hour).toISOString(),
    };
    assert.equal((await post(base, "/_mock/controls", backwards)).status, 400);
  });

  it("answers the gateway paths the product's way while maintenance is on", async () => {
    const ben = await signIn(base, "ben");
    await control(base, {
      kind: "maintenance-start",
      message: "Back soon",
      ...window(0, hour),
    });
    const refused = await post(
      base,
      "/gql",
      { query: "{ notes { id } }" },
      headersFor(ben),
    );
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("x-fixture-maintenance"), "on");
    const retry = Number(refused.headers.get("retry-after"));
    assert.ok(retry > 3500 && retry <= 3600, `retry-after ${String(retry)}`);
    assert.deepEqual(await refused.json(), {
      error: "maintenance",
      message: "Back soon",
    });
    assert.equal(
      (await post(base, "/auth/login", { password: "x", username: "ben" }))
        .status,
      503,
    );
    assert.equal((await fetch(`${base}/fixture/whoami`)).status, 503);
  });

  it("runs an operation the product's allow hook lets through, for that caller only", async () => {
    const ada = await signIn(base, "ada");
    const ben = await signIn(base, "ben");
    await control(base, { kind: "maintenance-start", message: "Back soon" });
    const asAdmin = await post(
      base,
      "/gql",
      { query: "{ me { username } }" },
      headersFor(ada),
    );
    assert.equal(asAdmin.status, 200);
    assert.deepEqual((await asAdmin.json()).data, {
      me: { username: "ada" },
    });
    assert.equal(
      (
        await post(
          base,
          "/gql",
          { query: "{ me { username } }" },
          headersFor(ben),
        )
      ).status,
      503,
    );
    assert.equal(
      (await post(base, "/gql", { query: "{ me { username } }" })).status,
      503,
    );
  });

  it("gates each operation on a websocket opened before maintenance, through the allow hook", async () => {
    const subscription = "subscription { noteAdded { text } }";
    const opened = async (username: string) => {
      const who = await signIn(base, username, true);
      const ws = await openSocket(base, "graphql-transport-ws");
      ws.send({ payload: { authToken: who.token }, type: "connection_init" });
      await ws.next("connection_ack");
      return ws;
    };
    const ada = await opened("ada");
    const ben = await opened("ben");
    await control(base, { kind: "maintenance-start", message: "Back soon" });
    ben.send({ id: "1", payload: { query: subscription }, type: "subscribe" });
    const refused = await ben.next("error");
    assert.deepEqual(refused.payload, [
      { extensions: { code: "MAINTENANCE" }, message: "Back soon" },
    ]);
    ada.send({ id: "1", payload: { query: subscription }, type: "subscribe" });
    await new Promise((settle) => setTimeout(settle, 50));
    await control(base, { kind: "add-note", text: "Still here" });
    assert.deepEqual((await ada.next("next")).payload, {
      data: { noteAdded: { text: "Still here" } },
    });
    ada.socket.close();
    ben.socket.close();
  });

  describe("scoped to GraphQL, the way a gateway gates only its operations", () => {
    before(() => {
      (fixture.maintenance ?? {}).scope = "graphql";
    });
    after(() => {
      (fixture.maintenance ?? {}).scope = undefined;
    });

    it("keeps /readyz ready, and /auth, /setup and the product's routes open", async () => {
      await control(base, { kind: "maintenance-start" });
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      assert.equal(
        (await post(base, "/auth/login", { password: "x", username: "ben" }))
          .status,
        200,
      );
      assert.equal((await fetch(`${base}/setup/state`)).status, 200);
      assert.equal((await fetch(`${base}/fixture/whoami`)).status, 200);
    });

    it("opens new websockets, and still refuses the operations the allow hook doesn't", async () => {
      const ben = await signIn(base, "ben");
      await control(base, { kind: "maintenance-start" });
      const relay = await connect("/fixture/relay/draft-1", {
        cookie: ben.cookie,
      });
      assert.equal(relay.status, undefined);
      relay.socket.close();
      const ws = await openSocket(base, "graphql-transport-ws", {
        cookie: ben.cookie,
      });
      ws.send({ type: "connection_init" });
      await ws.next("connection_ack");
      ws.socket.close();
      assert.equal(
        (
          await post(
            base,
            "/gql",
            { query: "{ notes { id } }" },
            headersFor(ben),
          )
        ).status,
        503,
      );
    });
  });

  it("keeps the health of the process, the controls and the product's banner answering", async () => {
    await control(base, { kind: "maintenance-start", message: "Back soon" });
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/livez`)).status, 200);
    assert.equal((await fetch(`${base}/_mock/controls`)).status, 200);
    assert.equal((await fetch(`${base}/_mock`)).status, 200);
    assert.equal((await banner()).state, "active");
  });

  it("refuses new websockets while it's on", async () => {
    const ben = await signIn(base, "ben");
    await control(base, { kind: "maintenance-start" });
    assert.equal(
      (await connect("/fixture/relay/draft-1", { cookie: ben.cookie })).status,
      503,
    );
  });

  it("extends the window, and the retry follows it", async () => {
    await control(base, { kind: "maintenance-start", ...window(0, hour) });
    const later = new Date(Date.now() + 2 * hour).toISOString();
    await control(base, {
      endsAt: later,
      kind: "maintenance-update",
      message: "Taking longer",
    });
    assert.deepEqual(
      { endsAt: (await banner()).endsAt, message: (await banner()).message },
      { endsAt: later, message: "Taking longer" },
    );
    const retry = Number(
      (await fetch(`${base}/readyz`)).headers.get("retry-after"),
    );
    assert.ok(retry > 7100 && retry <= 7200, `retry-after ${String(retry)}`);
  });

  it("ends maintenance and answers as normal again", async () => {
    await control(base, { kind: "maintenance-start" });
    await control(base, { kind: "maintenance-end" });
    assert.equal((await banner()).state, "none");
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const ben = await signIn(base, "ben");
    assert.equal((await query(base, "{ notes { id } }", ben)).status, 200);
  });

  it("cancels an announcement, but not maintenance that's already on", async () => {
    await control(base, {
      kind: "maintenance-announce",
      ...window(hour, hour),
    });
    await control(base, { kind: "maintenance-cancel" });
    assert.equal((await banner()).state, "none");
    await control(base, { kind: "maintenance-start" });
    assert.equal(
      (await post(base, "/_mock/controls", { kind: "maintenance-cancel" }))
        .status,
      409,
    );
  });

  it("goes back to none on reset and on start fresh", async () => {
    await control(base, { kind: "maintenance-start" });
    await control(base, { kind: "reset" });
    assert.equal((await banner()).state, "none");
    await control(base, { kind: "maintenance-start" });
    await control(base, { kind: "fresh" });
    assert.equal((await banner()).state, "none");
  });

  it("tells the product when the window changes", async () => {
    const heard: unknown[] = [];
    const stop = listen(MAINTENANCE_CHANGED, (window) => heard.push(window));
    await control(base, { kind: "maintenance-start", message: "Now" });
    await control(base, { kind: "maintenance-end" });
    stop();
    assert.deepEqual(
      heard.map((change) => (change as { state: string }).state),
      ["active", "none"],
    );
  });

  it("shows the window as a banner across the page", async () => {
    const quiet = await (await fetch(`${base}/_mock`)).text();
    assert.doesNotMatch(quiet, /class="banner/);
    await control(base, {
      kind: "maintenance-announce",
      message: "Upgrading the database",
      ...window(hour, hour),
    });
    const announced = await (await fetch(`${base}/_mock`)).text();
    assert.match(
      announced,
      /<div class="banner banner--announced" role="region" aria-label="Maintenance">/,
    );
    assert.match(announced, /Upgrading the database/);
    await control(base, { kind: "maintenance-start" });
    const on = await (await fetch(`${base}/_mock`)).text();
    assert.match(
      on,
      /<div class="banner banner--active" role="region" aria-label="Maintenance">/,
    );
  });

  it("puts the maintenance card on the page", async () => {
    const html = await (await fetch(`${base}/_mock`)).text();
    assert.match(html, /id="maintenance"/);
    assert.match(html, /kind: "maintenance-announce"/);
  });
});

describe("first-run setup", () => {
  it("creates the first admin once", async () => {
    await control(base, { firstRun: true, kind: "fresh" });
    assert.deepEqual(await (await fetch(`${base}/setup/state`)).json(), {
      needsSetup: true,
    });
    const admin = {
      email: "first@example.org",
      name: "First Admin",
      password: "x",
      username: "first",
    };
    assert.equal((await post(base, "/setup/complete", admin)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/setup/state`)).json(), {
      needsSetup: false,
    });
    assert.equal((await post(base, "/setup/complete", admin)).status, 409);
  });
});

describe("websocket", () => {
  const SUBSCRIPTION = "subscription { noteAdded { text } }";

  it("streams changes over graphql-transport-ws", async () => {
    const cy = await signIn(base, "cy", true);
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ payload: { authToken: cy.token }, type: "connection_init" });
    await ws.next("connection_ack");
    ws.send({ id: "1", payload: { query: SUBSCRIPTION }, type: "subscribe" });
    await new Promise((settle) => setTimeout(settle, 50));
    await control(base, { kind: "add-note", text: "Heard" });
    const message = await ws.next("next");
    assert.deepEqual(message.payload, {
      data: { noteAdded: { text: "Heard" } },
    });
    ws.socket.close();
  });

  it("streams over the legacy graphql-ws protocol with a cookie", async () => {
    const ben = await signIn(base, "ben");
    const ws = await openSocket(base, "graphql-ws", { cookie: ben.cookie });
    ws.send({ type: "connection_init" });
    await ws.next("connection_ack");
    await ws.next("ka");
    ws.send({ id: "a", payload: { query: SUBSCRIPTION }, type: "start" });
    await new Promise((settle) => setTimeout(settle, 50));
    await control(base, { kind: "add-note", text: "Legacy" });
    assert.deepEqual((await ws.next("data")).payload, {
      data: { noteAdded: { text: "Legacy" } },
    });
    ws.socket.close();
  });

  it("refuses a subscription without a session", async () => {
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ type: "connection_init" });
    await ws.next("connection_ack");
    ws.send({ id: "1", payload: { query: SUBSCRIPTION }, type: "subscribe" });
    const error = await ws.next("error");
    assert.equal(
      (error.payload as { extensions: { code: string } }[])[0]?.extensions.code,
      "UNAUTHENTICATED",
    );
    ws.socket.close();
  });

  it("closes with 4401 when the session ends", async () => {
    const cy = await signIn(base, "cy", true);
    const ws = await openSocket(base, "graphql-transport-ws");
    ws.send({ payload: { authToken: cy.token }, type: "connection_init" });
    await ws.next("connection_ack");
    await control(base, { kind: "expire-session" });
    assert.equal(await ws.closed, 4401);
  });
});

describe("routing", () => {
  it("answers routes nobody mocked with 501", async () => {
    const answer = await fetch(`${base}/api/elsewhere`);
    assert.equal(answer.status, 501);
    assert.deepEqual(await answer.json(), { error: "not_mocked" });
  });

  it("allows only the configured origins", async () => {
    process.env.MOCK_CORS_ORIGINS = "http://localhost:3000";
    const allowed = await fetch(`${base}/livez`, {
      headers: { origin: "http://localhost:3000" },
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://localhost:3000",
    );
    const other = await fetch(`${base}/livez`, {
      headers: { origin: "https://elsewhere.example" },
    });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    delete process.env.MOCK_CORS_ORIGINS;
  });

  it("answers in-process, with no port", async () => {
    const answer = await handle(new Request("http://mock.invalid/readyz"));
    assert.equal(answer.status, 200);
  });
});
