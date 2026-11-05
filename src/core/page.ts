// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's controls page at /_mock. It belongs to the mock server, not to any client: no
// sign-in, and it keeps working through Start fresh. It's one page: an app shell (a header, a
// sidebar that becomes a drawer on a phone, and a main column of cards) carrying the template
// website's header brand (the mark and the product's name) and its neutral light and dark
// tokens, which a product replaces with its own brand. Its buttons come from GET /_mock/controls
// (the core's actions and the product's), it posts to the same path, and it reads the state
// every couple of seconds, so a change made anywhere (another tab, a test, a phone) shows here.
//
// The theme follows the system until someone switches it; the switch posts /_mock/theme, which
// saves the choice in a cookie the page is then served with, so it opens in the saved theme with
// no flash and nothing kept in the browser's storage.

import { cookieOf, readJson, refuse } from "#core/http.ts";
import { settings } from "#core/product.ts";

type Theme = "dark" | "light";

const THEME_COOKIE = "mock_theme";
/** A year: the setting is a person's own preference for this page. */
const THEME_SECONDS = 31_536_000;

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const savedTheme = (request: Request): null | Theme => {
  const value = cookieOf(request.headers.get("cookie"), THEME_COOKIE);
  return value === "dark" || value === "light" ? value : null;
};

const toggleLabel = (theme: Theme) =>
  theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

/** The template website's placeholder mark, drawn in the theme's colours. */
const MARK = `<svg class="brand__mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect x="2" y="2" width="28" height="28" rx="7" fill="var(--frame-primary)"/><rect x="10" y="10" width="12" height="12" rx="3" fill="var(--frame-bg)"/></svg>`;

const ICON = `width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"`;

const STYLE = `
:root {
  color-scheme: light;
  --frame-font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --frame-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --frame-radius: 0.5rem;
  --frame-toggle: 2rem;
  --frame-wordmark-size: 1.0625rem;
  --frame-wordmark-line: 1.59375rem;
  --frame-wordmark-spacing: -0.025em;
  --frame-bg: #fafafa;
  --frame-surface: #ffffff;
  --frame-ink: #171717;
  --frame-muted: #525252;
  --frame-border: #e5e5e5;
  --frame-primary: #404040;
  --frame-warning: #737373;
  --shell-header: 4rem;
  --shell-sidebar: 16.25rem;
  --shell-soft: color-mix(in srgb, var(--frame-primary) 9%, var(--frame-surface));
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --frame-bg: #0a0a0a;
  --frame-surface: #171717;
  --frame-ink: #ededed;
  --frame-muted: #a3a3a3;
  --frame-border: #262626;
  --frame-primary: #d4d4d4;
  --frame-warning: #a3a3a3;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--frame-bg);
  color: var(--frame-ink);
  font: 0.9375rem/1.6 var(--frame-font-sans);
  -webkit-font-smoothing: antialiased;
}
:focus-visible { outline: 2px solid var(--frame-primary); outline-offset: 2px; }
.skip-link {
  position: absolute; left: 1rem; top: -3rem; z-index: 100;
  padding: 0.5rem 1rem; border: 1px solid var(--frame-border); border-radius: var(--frame-radius);
  background: var(--frame-surface); color: var(--frame-ink); transition: top 0.15s ease;
}
.skip-link:focus { top: 1rem; }
.shell { display: flex; flex-direction: column; height: 100dvh; }
.header {
  display: flex; align-items: center; gap: 0.875rem; flex: none;
  height: var(--shell-header); padding: 0 1.25rem;
  border-bottom: 1px solid var(--frame-border); background: var(--frame-surface);
}
.brand { display: inline-flex; align-items: center; gap: 0.625rem; color: var(--frame-ink); text-decoration: none; }
.brand__mark { width: 1.75rem; height: 1.75rem; flex: none; }
.brand__name {
  font: 700 var(--frame-wordmark-size)/var(--frame-wordmark-line) var(--frame-font-mono);
  letter-spacing: var(--frame-wordmark-spacing);
}
.badge {
  padding: 0.25rem 0.5rem; border: 1.5px solid var(--frame-ink); border-radius: 6px;
  font: 700 0.75rem/1.125rem var(--frame-font-mono); letter-spacing: 0.08em; text-transform: uppercase;
}
.version { color: var(--frame-muted); font: 0.8125rem/1.25rem var(--frame-font-mono); }
.header__end { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; }
.icon-button {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: var(--frame-toggle); height: var(--frame-toggle); padding: 0;
  border: 1px solid var(--frame-border); border-radius: calc(var(--frame-radius) - 2px);
  background: transparent; color: var(--frame-ink); cursor: pointer; transition: background-color 0.15s ease;
}
.icon-button:hover { background: var(--frame-border); }
.menu-button { display: none; }
.theme-toggle .icon--sun, :root[data-theme="dark"] .theme-toggle .icon--moon { display: none; }
:root[data-theme="dark"] .theme-toggle .icon--sun { display: block; }
.body { display: flex; flex: 1; min-height: 0; }
.sidebar {
  display: flex; flex-direction: column; gap: 1.25rem; flex: none;
  width: var(--shell-sidebar); padding: 1rem 0.75rem; overflow-y: auto;
  border-right: 1px solid var(--frame-border); background: var(--frame-surface);
}
.nav-group { display: flex; flex-direction: column; gap: 0.125rem; }
.eyebrow {
  padding: 0 0.75rem 0.5rem; color: var(--frame-muted);
  font: 700 0.75rem/1.125rem var(--frame-font-mono); letter-spacing: 0.08em; text-transform: uppercase;
}
.nav-item {
  display: flex; align-items: center; gap: 0.75rem; min-height: 2.75rem; padding: 0 0.75rem;
  border-radius: calc(var(--frame-radius) - 2px); color: var(--frame-ink); font-weight: 700; text-decoration: none;
}
.nav-item:hover { background: var(--frame-border); }
.nav-item[aria-current="true"] { background: var(--shell-soft); box-shadow: inset 3px 0 0 var(--frame-primary); }
.nav-item code { margin-left: auto; color: var(--frame-muted); font: 0.75rem/1 var(--frame-font-mono); }
.main {
  position: relative; flex: 1; min-width: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 1.5rem; padding: 2rem 2.5rem;
}
.page-title { margin: 0; font-size: 1.5rem; line-height: 2rem; letter-spacing: -0.01em; }
.page-lead { margin: 0.25rem 0 0; color: var(--frame-muted); }
.card {
  display: flex; flex-direction: column; gap: 0.75rem; max-width: 52rem; padding: 1.25rem;
  border: 1px solid var(--frame-border); border-radius: var(--frame-radius); background: var(--frame-surface);
  scroll-margin-top: 1rem;
}
.card h2 { margin: 0; font-size: 1rem; line-height: 1.5rem; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; }
.hint { color: var(--frame-muted); font-size: 0.875rem; }
.button, select {
  display: inline-flex; align-items: center; min-height: 2.5rem; padding: 0 1.125rem; max-width: 100%;
  border: 1px solid var(--frame-border); border-radius: calc(var(--frame-radius) - 2px);
  background: var(--frame-surface); color: var(--frame-ink); font: 500 0.9375rem/1.25rem var(--frame-font-sans);
  cursor: pointer;
}
.button:hover { background: var(--frame-border); }
.button--primary { border-color: var(--frame-primary); background: var(--frame-primary); color: var(--frame-bg); }
.button--primary:hover { background: color-mix(in srgb, var(--frame-primary) 88%, var(--frame-ink)); }
.status {
  display: flex; align-items: center; gap: 0.625rem; padding: 0.75rem 1rem;
  border: 1px solid var(--frame-border); border-left: 4px solid var(--frame-primary);
  border-radius: var(--frame-radius); background: var(--shell-soft);
}
.status__dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--frame-primary); flex: none; }
.status.down { border-left-color: var(--frame-warning); background: var(--frame-surface); }
.status.down .status__dot { background: var(--frame-warning); }
pre {
  margin: 0; padding: 0.75rem 1rem; overflow-x: auto; white-space: pre-wrap;
  border: 1px solid var(--frame-border); border-radius: calc(var(--frame-radius) - 2px);
  background: var(--frame-bg); color: var(--frame-ink); font: 0.8125rem/1.5 var(--frame-font-mono);
}
.legal { margin: 0; color: var(--frame-muted); font-size: 0.75rem; line-height: 1.125rem; }
.scrim { display: none; }
@media (max-width: 899px) {
  .menu-button { display: inline-flex; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 20; width: min(86vw, 20rem);
    box-shadow: 0 16px 48px -16px rgb(0 0 0 / 0.5); transform: translateX(-105%);
    transition: transform 0.2s ease; visibility: hidden;
  }
  .sidebar[data-open="true"] { transform: none; visibility: visible; }
  .scrim[data-open="true"] { display: block; position: fixed; inset: 0; z-index: 15; background: rgb(12 14 20 / 0.35); }
  .main { padding: 1.5rem 1rem; }
}
@media (max-width: 599px) {
  .header { gap: 0.625rem; padding: 0 0.75rem; }
  .version { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar, .skip-link, .icon-button { transition: none; }
}
`;

/** Follows the system theme while nothing is saved, and keeps following it as it changes. */
const BOOT = `(function(){var r=document.documentElement;if(r.getAttribute("data-theme-choice")!=="system")return;var m=matchMedia("(prefers-color-scheme: dark)");var apply=function(){var t=m.matches?"dark":"light";r.setAttribute("data-theme",t);var b=document.getElementById("theme-toggle");if(b)b.setAttribute("aria-label",t==="dark"?"Switch to light theme":"Switch to dark theme")};apply();m.addEventListener("change",apply);document.addEventListener("DOMContentLoaded",apply)})();`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const status = $("status");
  let drawn = "";
  const slug = (text) => "section-" + text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const send = async (body) => {
    const answer = await fetch("/_mock/controls", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
    if (!answer.ok) { status.className = "status down"; $("status-text").textContent = "That didn't work: " + answer.status; return; }
    await refresh();
  };
  const navItem = (href, label) => {
    const link = document.createElement("a");
    link.className = "nav-item";
    link.href = href;
    link.textContent = label;
    return link;
  };
  const draw = (actions) => {
    const key = JSON.stringify(actions);
    if (key === drawn) return;
    drawn = key;
    const sections = new Map();
    for (const action of actions) {
      if (!sections.has(action.section)) sections.set(action.section, []);
      sections.get(action.section).push(action);
    }
    $("actions").replaceChildren(...[...sections].map(([title, list]) => {
      const card = document.createElement("section");
      card.className = "card";
      card.id = slug(title);
      card.setAttribute("aria-labelledby", card.id + "-title");
      const heading = document.createElement("h2");
      heading.id = card.id + "-title";
      heading.textContent = title;
      card.append(heading);
      for (const action of list) {
        const row = document.createElement("div");
        row.className = "row";
        const button = document.createElement("button");
        button.className = "button";
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click", () => send({ ...(action.body ?? {}), kind: action.kind }));
        row.append(button);
        if (action.hint) { const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = action.hint; row.append(hint); }
        card.append(row);
      }
      return card;
    }));
    $("nav-actions").replaceChildren(...[...sections.keys()].map((title) => navItem("#" + slug(title), title)));
  };
  const refresh = async () => {
    try {
      const state = await (await fetch("/_mock/controls")).json();
      status.className = "status";
      $("status-text").textContent = state.sessions.length + " signed in" + (state.failNext ? ", the next call fails" : "") + (state.needsSetup ? ", first-run setup is on" : "") + (state.freshAt ? ", started fresh " + new Date(state.freshAt).toLocaleTimeString() : "");
      draw(state.actions);
      $("summary").textContent = JSON.stringify(state.summary, null, 2);
    } catch { status.className = "status down"; $("status-text").textContent = "The mock server isn't answering."; }
  };
  const people = async () => {
    const list = await (await fetch("/_mock/people")).json();
    $("person").replaceChildren(...list.filter((p) => !p.disabled).map((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name + " (" + p.username + ")"; return o; }));
  };
  $("sign-in").addEventListener("click", () => send({ kind: "sign-in", personId: $("person").value }));

  const toggle = $("theme-toggle");
  toggle.addEventListener("click", async () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    root.setAttribute("data-theme-choice", next);
    toggle.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
    await fetch("/_mock/theme", { body: JSON.stringify({ theme: next }), headers: { "content-type": "application/json" }, method: "POST" });
  });

  const sidebar = $("sidebar");
  const scrim = $("scrim");
  const menu = $("menu-button");
  const setDrawer = (open) => {
    sidebar.dataset.open = String(open);
    scrim.dataset.open = String(open);
    menu.setAttribute("aria-expanded", String(open));
    if (open) sidebar.querySelector("a")?.focus(); else if (document.activeElement && sidebar.contains(document.activeElement)) menu.focus();
  };
  menu.addEventListener("click", () => setDrawer(sidebar.dataset.open !== "true"));
  scrim.addEventListener("click", () => setDrawer(false));
  sidebar.addEventListener("click", (event) => { if (event.target.closest("a") && sidebar.dataset.open === "true") setDrawer(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && sidebar.dataset.open === "true") setDrawer(false); });

  void people();
  void refresh();
  setInterval(refresh, 2000);
`;

const page = (saved: null | Theme) => {
  const { graphqlPath, name, version } = settings();
  const theme: Theme = saved ?? "light";
  return `<!doctype html>
<html lang="en" data-theme="${theme}" data-theme-choice="${saved ?? "system"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Mock controls · ${escape(name)}</title>
<script>${BOOT}</script>
<style>${STYLE}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to the controls</a>
<div class="shell">
  <header class="header">
    <button class="icon-button menu-button" id="menu-button" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open menu"><svg ${ICON}><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <a class="brand" href="/_mock" aria-label="${escape(name)} mock controls">${MARK}<span class="brand__name">${escape(name)}</span></a>
    <span class="badge">Mock</span>
    <span class="version">${escape(version)}</span>
    <div class="header__end">
      <button class="icon-button theme-toggle" id="theme-toggle" type="button" aria-label="${toggleLabel(theme)}"><svg class="icon--sun" ${ICON}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="icon--moon" ${ICON}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></button>
    </div>
  </header>
  <div class="body">
    <aside class="sidebar" id="sidebar" aria-label="Sidebar">
      <div class="nav-group">
        <span class="eyebrow">Controls</span>
        <nav class="nav-group" aria-label="Controls">
          <a class="nav-item" href="#overview" aria-current="true">Overview</a>
          <a class="nav-item" href="#sign-in-card">Sign in as</a>
          <div class="nav-group" id="nav-actions"></div>
          <a class="nav-item" href="#data">Data</a>
        </nav>
      </div>
      <div class="nav-group">
        <span class="eyebrow">Gateway</span>
        <nav class="nav-group" aria-label="Gateway">
          <a class="nav-item" href="/_mock/state">State <code>JSON</code></a>
          <a class="nav-item" href="/_mock/people">People <code>JSON</code></a>
          <a class="nav-item" href="/readyz">Health <code>/readyz</code></a>
          <span class="nav-item">GraphQL <code>${escape(graphqlPath)}</code></span>
        </nav>
      </div>
    </aside>
    <div class="scrim" id="scrim"></div>
    <main class="main" id="main" tabindex="-1">
      <div id="overview">
        <h1 class="page-title">Mock controls</h1>
        <p class="page-lead">The ${escape(name)} mock gateway's own page. No sign-in, and Start fresh never takes it down.</p>
      </div>
      <div class="status" id="status" role="status" aria-live="polite"><span class="status__dot" aria-hidden="true"></span><span id="status-text">Loading…</span></div>
      <section class="card" id="sign-in-card" aria-labelledby="sign-in-title">
        <h2 id="sign-in-title">Sign in as</h2>
        <div class="row">
          <label class="hint" for="person">Person</label>
          <select id="person"></select>
          <button class="button button--primary" id="sign-in" type="button">Sign in here</button>
        </div>
        <p class="hint">Any password works except "wrong-password"; any six digits except 000000.</p>
      </section>
      <div id="actions" style="display: contents"></div>
      <section class="card" id="data" aria-labelledby="data-title">
        <h2 id="data-title">Data</h2>
        <pre id="summary"></pre>
      </section>
      <p class="legal">Invented data only, for local runs and walkthroughs; never a real server. ${escape(name)} mock gateway ${escape(version)}.</p>
    </main>
  </div>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
};

const saveTheme = async (request: Request): Promise<Response> => {
  const { theme } = await readJson<{ theme: string }>(request);
  if (theme !== "dark" && theme !== "light")
    return refuse(400, "unknown_theme");
  return new Response(null, {
    headers: {
      "set-cookie": `${THEME_COOKIE}=${theme}; Path=/_mock; SameSite=Lax; Max-Age=${String(THEME_SECONDS)}`,
    },
    status: 204,
  });
};

export const answerPage = (
  request: Request,
  path: string,
): Promise<Response> | Response | undefined => {
  if (path === "/_mock/theme" && request.method === "POST")
    return saveTheme(request);
  if (request.method !== "GET" || (path !== "/_mock" && path !== "/_mock/"))
    return undefined;
  return new Response(page(savedTheme(request)), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
