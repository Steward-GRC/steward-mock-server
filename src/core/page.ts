// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's controls page at /_mock. It belongs to the mock server, not to any client: no
// sign-in, and it keeps working through Start fresh. It's one page, laid out as the stored app
// shell design: a 64px header (the sidebar toggle, the product's mark and name, a hatched Mock
// badge, the version and the theme switch), a maintenance banner under it when a window is
// announced or on, a 272px sidebar that folds to an icon rail on a tablet and a drawer on a
// phone, and a main column with a page head, the product's summary as tiles, and cards for
// signing in, maintenance and each group of actions. The colours are the template website's
// neutral set mapped onto the design's token roles, with its semantic ok, warn and danger colours;
// a product replaces the brand colours with its own. Type follows the design's scale and weights
// on the system font stacks, so nothing is fetched.
//
// Its buttons come from GET /_mock/controls (the core's actions and the product's), it posts to
// the same path, and it reads the state every couple of seconds, so a change made anywhere
// (another tab, a test, a phone) shows here. The theme follows the system until someone switches
// it; the switch posts /_mock/theme, which saves the choice in a cookie the page is then served
// with, so it opens in the saved theme with no flash and nothing kept in the browser's storage.

import type { PersonField } from "#core/product.ts";
import type { MaintenanceWindow } from "#core/state.ts";

import { cookieOf, readJson, refuse } from "#core/http.ts";
import { maintenance } from "#core/maintenance.ts";
import { personFields } from "#core/people.ts";
import { product, settings } from "#core/product.ts";

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
const MARK = `<svg class="brand__mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect x="2" y="2" width="28" height="28" rx="7" fill="var(--primary)"/><rect x="10" y="10" width="12" height="12" rx="3" fill="var(--bg)"/></svg>`;

const ICON = `width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"`;

const STYLE = `
:root {
  color-scheme: light;
  --font-display: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --bg: #fafafa; --surface: #ffffff; --sunken: #f4f4f4;
  --ink: #171717; --muted: #525252;
  --border: #e5e5e5; --border-strong: #d4d4d4; --control: #737373;
  --primary: #404040; --on-primary: #fafafa;
  --primary-soft: color-mix(in srgb, var(--primary) 9%, var(--surface));
  --hatch: #e5e5e5;
  --ok: #1f7a4d; --ok-soft: #e2f2e9;
  --warn: #9a5b00; --warn-soft: #fbebd0;
  --danger: #c0312b; --danger-soft: #f9e1df;
  --shadow-menu: 0 18px 40px -16px rgb(28 34 48 / 0.35);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --header: 64px; --sidebar: 272px; --rail: 68px;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0a0a0a; --surface: #171717; --sunken: #1f1f1f;
  --ink: #ededed; --muted: #a3a3a3;
  --border: #262626; --border-strong: #3a3a3a; --control: #8a8a8a;
  --primary: #d4d4d4; --on-primary: #0a0a0a;
  --hatch: #3a3a3a;
  --ok: #4cc38a; --ok-soft: #16302a;
  --warn: #f2b33d; --warn-soft: #3a2e14;
  --danger: #ff7a6e; --danger-soft: #3a1e1e;
  --shadow-menu: 0 18px 40px -16px rgb(0 0 0 / 0.55);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/22px var(--font-ui); -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
.skip-link {
  position: absolute; left: 1rem; top: -4rem; z-index: 90; padding: 10px 14px;
  border: 1.5px solid var(--border-strong); border-radius: 10px; background: var(--surface); color: var(--ink);
  font-weight: 700; transition: top 120ms var(--ease);
}
.skip-link:focus { top: 1rem; }
.eyebrow, .label { font: 700 12px/16px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

.shell { display: flex; flex-direction: column; height: 100dvh; }
.header {
  position: relative; z-index: 30; flex: none; display: flex; align-items: center; gap: 14px;
  height: var(--header); padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--border);
}
.icon-button {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 40px; height: 40px; padding: 0; border-radius: 10px; border: 1.5px solid var(--border-strong);
  background: var(--surface); color: var(--ink); cursor: pointer; transition: background-color 120ms var(--ease);
}
.icon-button:hover { background: var(--sunken); }
.icon-button--bare { border-color: transparent; background: transparent; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; }
.brand__mark { width: 28px; height: 28px; flex: none; }
.brand__name { font: 700 17px/1 var(--font-mono); letter-spacing: -0.025em; }
.badge--env {
  padding: 5px 8px; border: 1.5px solid var(--ink); border-radius: 6px;
  font: 700 11px/1 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase;
  background: repeating-linear-gradient(135deg, var(--hatch) 0 5px, var(--surface) 5px 10px);
}
.version { font: 400 13px/18px var(--font-mono); color: var(--muted); }
.header__end { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.theme-toggle .icon--sun, :root[data-theme="dark"] .theme-toggle .icon--moon { display: none; }
:root[data-theme="dark"] .theme-toggle .icon--sun { display: block; }

.banner {
  flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 12px 20px;
  border-bottom: 1.5px solid var(--warn); background: var(--warn-soft); color: var(--ink);
}
.banner--active { border-bottom-color: var(--danger); background: var(--danger-soft); }
.banner__glyph { font: 700 16px/1 var(--font-ui); color: var(--warn); }
.banner--active .banner__glyph { color: var(--danger); }
.banner__text { font: 400 15px/1.4 var(--font-ui); }
.banner .button { margin-left: auto; }

.body { position: relative; display: flex; flex: 1; min-height: 0; }
.sidebar {
  flex: none; display: flex; flex-direction: column; gap: 20px; width: var(--sidebar); padding: 16px 12px;
  overflow-x: hidden; overflow-y: auto; background: var(--surface); border-right: 1px solid var(--border);
  transition: width 320ms var(--ease);
}
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav__label { padding: 0 12px 6px; }
.nav-item {
  display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px; border-radius: 10px;
  color: var(--ink); font: 700 15px/1 var(--font-ui); text-decoration: none; white-space: nowrap;
}
.nav-item:hover { background: var(--sunken); }
.nav-item[aria-current="true"] { background: var(--primary-soft); box-shadow: inset 3px 0 0 var(--primary); }
.nav-item__icon { width: 20px; flex: none; text-align: center; color: var(--muted); font: 700 14px/1 var(--font-mono); }
.nav-item[aria-current="true"] .nav-item__icon { color: var(--primary); }
.nav-item__meta { margin-left: auto; padding: 3px 6px; border-radius: 6px; background: var(--sunken); color: var(--muted); font: 700 12px/1 var(--font-mono); }
.rail .sidebar { width: var(--rail); }
.rail .nav__label, .rail .nav-item__label, .rail .nav-item__meta { display: none; }
.rail .nav-item { justify-content: center; padding: 0; }

.main {
  position: relative; flex: 1; min-width: 0; overflow-x: hidden; overflow-y: auto;
  display: flex; flex-direction: column; gap: 24px; padding: 32px 40px;
}
.head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; }
.head__text { display: flex; flex-direction: column; gap: 8px; }
.title { margin: 0; font: 700 36px/1.05 var(--font-display); letter-spacing: -0.02em; }
.subtitle { font: 400 16px/1.4 var(--font-ui); color: var(--muted); }
.live { margin-left: auto; display: flex; align-items: center; gap: 8px; font: 400 13px/18px var(--font-ui); color: var(--muted); }
.live__dot { width: 8px; height: 8px; border-radius: 4px; background: var(--ok); flex: none; }
.live.down { color: var(--danger); }
.live.down .live__dot { background: var(--danger); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 16px; }
.tile { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 18px; border: 1.5px solid var(--border); border-radius: 16px; background: var(--surface); }
.tile__label { font: 700 12px/16px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); overflow-wrap: anywhere; }
.tile__value { font: 700 30px/1 var(--font-mono); overflow-wrap: anywhere; }
.tile__value--text { font: 700 16px/1.35 var(--font-mono); }
.cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.card {
  display: flex; flex-direction: column; gap: 14px; padding: 24px; scroll-margin-top: 16px;
  border: 1px solid var(--border); border-radius: 18px; background: var(--surface);
}
.card h2 { margin: 0; font: 700 22px/28px var(--font-display); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.hint { font: 400 13px/18px var(--font-ui); color: var(--muted); }
.button {
  display: inline-flex; align-items: center; justify-content: center; height: 44px; padding: 0 16px; max-width: 100%;
  border: 1.5px solid var(--border-strong); border-radius: 10px; background: var(--surface); color: var(--ink);
  font: 700 15px/1 var(--font-ui); cursor: pointer; text-decoration: none; transition: background-color 120ms var(--ease);
}
.button:hover { background: var(--sunken); }
.button--primary { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.button--primary:hover { background: color-mix(in srgb, var(--primary) 85%, var(--ink)); }
.button--ink { border-color: var(--ink); background: var(--ink); color: var(--bg); }
.button--ink:hover { background: color-mix(in srgb, var(--ink) 85%, var(--bg)); }
.button--small { height: 36px; padding: 0 14px; border-radius: 9px; font-size: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: min(100%, 200px); }
.field input, .field select, select {
  height: 44px; padding: 0 12px; max-width: 100%; border: 1.5px solid var(--control); border-radius: 10px;
  background: var(--bg); color: var(--ink); font: 400 15px/1 var(--font-ui);
}
.window { margin: 0; font: 400 15px/22px var(--font-ui); }
.result { margin: 0; min-height: 22px; font: 700 15px/22px var(--font-ui); }
.result--ok { color: var(--ok); }
.result--bad { color: var(--danger); }
.check { display: inline-flex; align-items: center; gap: 8px; font: 400 15px/22px var(--font-ui); }
.check input { width: 18px; height: 18px; accent-color: var(--primary); }
.table-wrap { overflow-x: auto; }
.people { width: 100%; border-collapse: collapse; font: 400 14px/20px var(--font-ui); }
.people th { text-align: left; padding: 8px 10px; font: 700 12px/16px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); border-bottom: 1.5px solid var(--border); }
.people td { padding: 8px 10px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.people td:last-child { white-space: nowrap; }
.window strong { font: 700 12px/16px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; margin-right: 6px; }
.legal { margin: 0; font: 400 13px/18px var(--font-ui); color: var(--muted); }
.scrim { display: none; }
@media (min-width: 600px) and (max-width: 1023px) {
  .shell:not(.expanded) .sidebar { width: var(--rail); }
  .shell:not(.expanded) .nav__label, .shell:not(.expanded) .nav-item__label, .shell:not(.expanded) .nav-item__meta { display: none; }
  .shell:not(.expanded) .nav-item { justify-content: center; padding: 0; }
  .main { padding: 24px; }
}
@media (max-width: 599px) {
  .header { gap: 10px; padding: 0 12px; }
  .version { display: none; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 50; width: min(86vw, 320px);
    box-shadow: var(--shadow-menu); transform: translateX(-105%); visibility: hidden;
    transition: transform 320ms var(--ease);
  }
  .drawer .sidebar { transform: none; visibility: visible; }
  .drawer .scrim { display: block; position: fixed; inset: 0; z-index: 45; background: rgb(12 14 20 / 0.35); }
  .main { padding: 20px 16px; gap: 20px; }
  .title { font-size: 30px; }
  .live { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; }
}
`;

/** Follows the system theme while nothing is saved, and keeps following it as it changes. */
const BOOT = `(function(){var r=document.documentElement;if(r.getAttribute("data-theme-choice")!=="system")return;var m=matchMedia("(prefers-color-scheme: dark)");var apply=function(){var t=m.matches?"dark":"light";r.setAttribute("data-theme",t);var b=document.getElementById("theme-toggle");if(b)b.setAttribute("aria-label",t==="dark"?"Switch to light theme":"Switch to dark theme")};apply();m.addEventListener("change",apply);document.addEventListener("DOMContentLoaded",apply)})();`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const shell = $("shell");
  const live = $("status");
  let drawn = "";
  const slug = (text) => "section-" + text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const fail = (text) => { live.className = "live down"; $("status-text").textContent = text; };
  const send = async (body) => {
    const answer = await fetch("/_mock/controls", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
    if (!answer.ok) {
      const refused = await answer.json().catch(() => ({}));
      fail("That didn't work: " + (refused.error ?? answer.status));
      return;
    }
    await refresh();
  };
  const navItem = (href, icon, label) => {
    const link = el("a", "nav-item");
    link.href = href;
    link.title = label;
    link.append(el("span", "nav-item__icon", icon), el("span", "nav-item__label", label));
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
      const card = el("section", "card");
      card.id = slug(title);
      card.setAttribute("aria-labelledby", card.id + "-title");
      const heading = el("h2", "", title);
      heading.id = card.id + "-title";
      card.append(heading);
      for (const action of list) {
        const row = el("div", "row");
        const button = el("button", "button", action.label);
        button.type = "button";
        button.addEventListener("click", () => send({ ...(action.body ?? {}), kind: action.kind }));
        row.append(button);
        if (action.hint) row.append(el("span", "hint", action.hint));
        card.append(row);
      }
      return card;
    }));
    $("nav-actions").replaceChildren(...[...sections.keys()].map((title) => navItem("#" + slug(title), title.slice(0, 1).toUpperCase(), title)));
  };
  const local = (iso) => new Date(iso).toLocaleString();
  const describe = (window) => (window.startsAt ? " from " + local(window.startsAt) : "") + (window.endsAt ? " until " + local(window.endsAt) : "") + (window.message ? ". " + window.message : "");
  const showWindow = (window) => {
    const line = $("maintenance-window");
    if (window.state === "none") line.textContent = "No maintenance planned.";
    else line.replaceChildren(el("strong", "", window.state === "active" ? "On now" : "Announced"), describe(window));
    const slot = $("banner-slot");
    if (window.state === "none") { slot.replaceChildren(); return; }
    const banner = el("div", "banner banner--" + window.state);
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Maintenance");
    const text = el("span", "banner__text");
    text.append(el("b", "", window.state === "active" ? "Maintenance is on." : "Maintenance announced."), describe(window));
    const manage = el("a", "button button--ink button--small", "Manage");
    manage.href = "#maintenance";
    banner.append(el("b", "banner__glyph", window.state === "active" ? "●" : "▲"), text, manage);
    slot.replaceChildren(banner);
  };
  // A count stays big; a text value gets the smaller style that wraps inside the tile.
  const valueClass = (value) => typeof value === "number" ? "tile__value" : "tile__value tile__value--text";
  const showTiles = (summary) => {
    $("tiles").replaceChildren(...Object.entries(summary ?? {}).map(([label, value]) => {
      const tile = el("div", "tile");
      tile.append(el("span", "tile__label", label), el("span", valueClass(value), String(value)));
      return tile;
    }));
  };
  const refresh = async () => {
    try {
      const state = await (await fetch("/_mock/controls")).json();
      live.className = "live";
      $("status-text").textContent = "Live · " + state.sessions.length + " signed in" + (state.failNext ? " · the next call fails" : "") + (state.needsSetup ? " · first-run setup is on" : "") + " · updated " + new Date().toLocaleTimeString();
      draw(state.actions);
      showTiles(state.summary);
      showWindow(state.maintenance);
      await people();
    } catch { fail("The mock server isn't answering."); }
  };
  // A control whose answer the page shows itself: the reason when it's refused.
  const ask = async (body) => {
    const answer = await fetch("/_mock/controls", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
    const data = await answer.json().catch(() => ({}));
    return answer.ok ? { data, ok: true } : { ok: false, reason: data.message ?? data.error ?? "the mock answered " + answer.status };
  };
  const say = (id, ok, text) => { const node = $(id); node.className = "result " + (ok ? "result--ok" : "result--bad"); node.textContent = text; };

  // The people who can sign in: the "Sign in as" choice and the users table, redrawn when they change.
  let everyone = [];
  let peopleDrawn = "";
  let editing = null;
  const people = async () => {
    everyone = await (await fetch("/_mock/people")).json();
    const key = JSON.stringify(everyone);
    if (key === peopleDrawn) return;
    peopleDrawn = key;
    const chosen = $("person").value;
    $("person").replaceChildren(...everyone.filter((p) => !p.disabled).map((p) => { const o = el("option", "", p.name + " (" + p.username + ")"); o.value = p.id; return o; }));
    if (chosen) $("person").value = chosen;
    $("people-rows").replaceChildren(...everyone.map((p) => {
      const row = el("tr");
      const edit = el("button", "button button--small", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => startEdit(p));
      const remove = el("button", "button button--small", "Remove");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const done = await ask({ kind: "person-remove", personId: p.id });
        say("users-result", done.ok, done.ok ? "Removed " + p.name + "." : "Couldn't remove " + p.name + ": " + done.reason);
        if (editing === p.id) clearForm();
        await people();
      });
      const actions = el("td");
      actions.append(edit, " ", remove);
      row.append(el("td", "", p.name), el("td", "", p.username), el("td", "", p.roles.join(", ") || "none"), el("td", "", p.hasPassword ? "set" : "not set"), el("td", "", (p.disabled ? "disabled" : "active") + (p.secondFactor ? ", second factor" : "")), ...extra.map((field) => el("td", "", extraText(field, p[field.key]))), actions);
      return row;
    }));
  };

  $("sign-in").addEventListener("click", async () => {
    const person = everyone.find((p) => p.id === $("person").value);
    if (!person) return say("sign-in-result", false, "Choose someone to sign in as.");
    const done = await ask({ kind: "sign-in", personId: person.id });
    say("sign-in-result", done.ok, done.ok ? "Signed in as " + person.name + ". Refresh this page." : "Couldn't sign in as " + person.name + ": " + done.reason);
    await refresh();
  });

  // The product's own person fields, from the Users card's data-fields.
  const extra = JSON.parse($("users").dataset.fields || "[]");
  const extraInput = (field) => $("user-field-" + field.key);
  const extraValue = (field) => field.kind === "boolean" ? extraInput(field).checked : extraInput(field).value;
  const extraText = (field, value) => field.kind === "boolean" ? (value === true ? "yes" : "no") : field.kind === "list" ? (value ?? []).join(", ") || "none" : value ?? "";
  const form = () => ({ ...Object.fromEntries(extra.map((field) => [field.key, extraValue(field)])), disabled: $("user-disabled").checked, email: $("user-email").value, name: $("user-name").value, password: $("user-password").value, roles: $("user-roles").value, secondFactor: $("user-second-factor").checked, username: $("user-username").value });
  const clearForm = () => {
    editing = null;
    for (const id of ["user-name", "user-username", "user-email", "user-roles", "user-password"]) $(id).value = "";
    $("user-second-factor").checked = false;
    $("user-disabled").checked = false;
    for (const field of extra) { if (field.kind === "boolean") extraInput(field).checked = false; else extraInput(field).value = ""; }
    $("user-password").placeholder = "The password they sign in with";
    $("user-save").hidden = true;
    $("user-add").hidden = false;
  };
  const startEdit = (p) => {
    editing = p.id;
    $("user-name").value = p.name;
    $("user-username").value = p.username;
    $("user-email").value = p.email;
    $("user-roles").value = p.roles.join(", ");
    $("user-password").value = "";
    $("user-password").placeholder = p.hasPassword ? "Leave empty to keep the password" : "No password yet: set one";
    $("user-second-factor").checked = p.secondFactor;
    $("user-disabled").checked = p.disabled;
    for (const field of extra) { if (field.kind === "boolean") extraInput(field).checked = p[field.key] === true; else extraInput(field).value = field.kind === "list" ? (p[field.key] ?? []).join(", ") : p[field.key] ?? ""; }
    $("user-save").hidden = false;
    $("user-add").hidden = true;
    $("user-name").focus();
  };
  $("user-add").addEventListener("click", async () => {
    const done = await ask({ ...form(), kind: "person-add" });
    say("users-result", done.ok, done.ok ? "Added " + done.data.result.name + "." : "Couldn't add the user: " + done.reason);
    if (done.ok) clearForm();
    await people();
  });
  $("user-save").addEventListener("click", async () => {
    const done = await ask({ ...form(), kind: "person-update", personId: editing });
    say("users-result", done.ok, done.ok ? "Saved " + done.data.result.name + "." : "Couldn't save the user: " + done.reason);
    if (done.ok) clearForm();
    await people();
  });
  $("user-clear").addEventListener("click", clearForm);

  const when = (id) => { const value = $(id).value; return value ? new Date(value).toISOString() : undefined; };
  const windowBody = () => ({ endsAt: when("maintenance-end"), message: $("maintenance-message").value || undefined, startsAt: when("maintenance-start") });
  $("maintenance-announce").addEventListener("click", () => send({ ...windowBody(), kind: "maintenance-announce" }));
  $("maintenance-go").addEventListener("click", () => send({ ...windowBody(), kind: "maintenance-start" }));
  $("maintenance-update").addEventListener("click", () => send({ ...windowBody(), kind: "maintenance-update" }));
  $("maintenance-stop").addEventListener("click", () => send({ kind: "maintenance-end" }));
  $("maintenance-cancel").addEventListener("click", () => send({ kind: "maintenance-cancel" }));

  const toggle = $("theme-toggle");
  toggle.addEventListener("click", async () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    root.setAttribute("data-theme-choice", next);
    toggle.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
    await fetch("/_mock/theme", { body: JSON.stringify({ theme: next }), headers: { "content-type": "application/json" }, method: "POST" });
  });

  // The sidebar: a drawer on a phone, an icon rail that expands on a tablet, and a full sidebar
  // that collapses to the rail on a desktop.
  const menu = $("menu-button");
  const sidebar = $("sidebar");
  const width = () => window.innerWidth;
  const label = () => {
    if (width() < 600) { menu.setAttribute("aria-label", "Open menu"); menu.setAttribute("aria-expanded", String(shell.classList.contains("drawer"))); return; }
    const open = width() < 1024 ? shell.classList.contains("expanded") : !shell.classList.contains("rail");
    menu.setAttribute("aria-label", open ? "Collapse sidebar" : "Expand sidebar");
    menu.setAttribute("aria-expanded", String(open));
  };
  const setDrawer = (open) => {
    shell.classList.toggle("drawer", open);
    label();
    if (open) sidebar.querySelector("a")?.focus(); else if (sidebar.contains(document.activeElement)) menu.focus();
  };
  menu.addEventListener("click", () => {
    if (width() < 600) setDrawer(!shell.classList.contains("drawer"));
    else if (width() < 1024) shell.classList.toggle("expanded");
    else shell.classList.toggle("rail");
    label();
  });
  $("scrim").addEventListener("click", () => setDrawer(false));
  sidebar.addEventListener("click", (event) => { if (event.target.closest("a") && shell.classList.contains("drawer")) setDrawer(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && shell.classList.contains("drawer")) setDrawer(false); });
  window.addEventListener("resize", label);
  label();

  void refresh();
  setInterval(refresh, 2000);
`;

const describeWindow = (window: MaintenanceWindow) =>
  (window.startsAt ? ` from ${new Date(window.startsAt).toUTCString()}` : "") +
  (window.endsAt ? ` until ${new Date(window.endsAt).toUTCString()}` : "") +
  (window.message ? `. ${window.message}` : "");

/** The banner under the header while a window is announced or on (the script keeps it current). */
const bannerHtml = (window: MaintenanceWindow) => {
  if (window.state === "none") return "";
  const on = window.state === "active";
  return `<div class="banner banner--${window.state}" role="region" aria-label="Maintenance"><b class="banner__glyph">${on ? "●" : "▲"}</b><span class="banner__text"><b>${on ? "Maintenance is on." : "Maintenance announced."}</b>${escape(describeWindow(window))}</span><a class="button button--ink button--small" href="#maintenance">Manage</a></div>`;
};

/** A count stays big; a text value gets the smaller style that wraps inside the tile. */
const valueClass = (value: unknown) =>
  typeof value === "number" ? "tile__value" : "tile__value tile__value--text";

/** The product's summary as tiles (the script keeps them current). */
const tilesHtml = (summary: Record<string, unknown>) =>
  Object.entries(summary)
    .map(
      ([label, value]) =>
        `<div class="tile"><span class="tile__label">${escape(label)}</span><span class="${valueClass(value)}">${escape(String(value))}</span></div>`,
    )
    .join("");

/** The product's own person fields in the Users form: text inputs, then checkboxes. */
const fieldsHtml = (fields: PersonField[]) => {
  const inputs = fields
    .filter((field) => field.kind !== "boolean")
    .map(
      (field) =>
        `<div class="field"><label class="label" for="user-field-${escape(field.key)}">${escape(field.label)}</label><input id="user-field-${escape(field.key)}" type="text" placeholder="${escape(field.hint ?? (field.kind === "list" ? "Comma-separated" : ""))}" autocomplete="off"></div>`,
    )
    .join("");
  const checks = fields
    .filter((field) => field.kind === "boolean")
    .map(
      (field) =>
        `<label class="check"><input id="user-field-${escape(field.key)}" type="checkbox"> ${escape(field.label)}</label>`,
    )
    .join("");
  return (
    (inputs ? `<div class="row">${inputs}</div>` : "") +
    (checks ? `<div class="row">${checks}</div>` : "")
  );
};

const page = (saved: null | Theme) => {
  const { graphqlPath, name, version } = settings();
  const fields = personFields();
  const theme: Theme = saved ?? "light";
  const window = maintenance();
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
<div class="shell" id="shell">
  <header class="header">
    <button class="icon-button icon-button--bare" id="menu-button" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open menu"><svg ${ICON}><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <a class="brand" href="/_mock" aria-label="${escape(name)} mock controls">${MARK}<span class="brand__name">${escape(name)}</span></a>
    <span class="badge badge--env">Mock</span>
    <span class="version">${escape(version)}</span>
    <div class="header__end">
      <button class="icon-button theme-toggle" id="theme-toggle" type="button" aria-label="${toggleLabel(theme)}"><svg class="icon--sun" ${ICON}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="icon--moon" ${ICON}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></button>
    </div>
  </header>
  <div id="banner-slot">${bannerHtml(window)}</div>
  <div class="body">
    <aside class="sidebar" id="sidebar" aria-label="Sidebar">
      <nav class="nav" aria-label="Controls">
        <a class="nav-item" href="#overview" title="Overview" aria-current="true"><span class="nav-item__icon">◎</span><span class="nav-item__label">Overview</span></a>
        <a class="nav-item" href="#sign-in-card" title="Sign in as"><span class="nav-item__icon">→</span><span class="nav-item__label">Sign in as</span></a>
        <a class="nav-item" href="#users" title="Users"><span class="nav-item__icon">◐</span><span class="nav-item__label">Users</span></a>
        <a class="nav-item" href="#maintenance" title="Maintenance"><span class="nav-item__icon">◷</span><span class="nav-item__label">Maintenance</span></a>
        <div class="nav" id="nav-actions"></div>
      </nav>
      <nav class="nav" aria-label="Gateway">
        <span class="label nav__label">Gateway</span>
        <a class="nav-item" href="/_mock/state" title="State"><span class="nav-item__icon">{}</span><span class="nav-item__label">State</span><span class="nav-item__meta">JSON</span></a>
        <a class="nav-item" href="/_mock/people" title="People"><span class="nav-item__icon">@</span><span class="nav-item__label">People</span><span class="nav-item__meta">JSON</span></a>
        <a class="nav-item" href="/readyz" title="Health"><span class="nav-item__icon">◉</span><span class="nav-item__label">Health</span><span class="nav-item__meta">/readyz</span></a>
        <span class="nav-item" title="GraphQL ${escape(graphqlPath)}"><span class="nav-item__icon">◆</span><span class="nav-item__label">GraphQL</span><span class="nav-item__meta">${escape(graphqlPath)}</span></span>
      </nav>
    </aside>
    <div class="scrim" id="scrim"></div>
    <main class="main" id="main" tabindex="-1">
      <div class="head" id="overview">
        <div class="head__text"><span class="eyebrow">Mock gateway</span><h1 class="title">Controls</h1><span class="subtitle">The ${escape(name)} mock gateway's own page. No sign-in, and Start fresh never takes it down.</span></div>
        <span class="live" id="status" role="status" aria-live="polite"><span class="live__dot" aria-hidden="true"></span><span id="status-text">Live · loading…</span></span>
      </div>
      <section class="tiles" id="tiles" aria-label="The data at a glance">${tilesHtml(product().summary())}</section>
      <div class="cards">
        <section class="card" id="sign-in-card" aria-labelledby="sign-in-title">
          <h2 id="sign-in-title">Sign in as</h2>
          <div class="row">
            <div class="field"><label class="label" for="person">Person</label><select id="person"></select></div>
          </div>
          <div class="row"><button class="button button--primary" id="sign-in" type="button">Sign in here</button></div>
          <p class="result" id="sign-in-result" role="status" aria-live="polite"></p>
          <p class="hint">Uses the person's password from Users and skips the second factor. A client's own sign-in takes the same password, then any six digits except 000000.</p>
        </section>
        <section class="card" id="users" aria-labelledby="users-title" data-fields="${escape(JSON.stringify(fields))}">
          <h2 id="users-title">Users</h2>
          <p class="hint">The people who can sign in, and the only passwords that work for them. A change counts from the next sign-in; removing someone signs them out.</p>
          <div class="table-wrap"><table class="people"><thead><tr><th scope="col">Name</th><th scope="col">Username</th><th scope="col">Roles</th><th scope="col">Password</th><th scope="col">Status</th>${fields.map((field) => `<th scope="col">${escape(field.label)}</th>`).join("")}<th scope="col"><span class="label">Actions</span></th></tr></thead><tbody id="people-rows"></tbody></table></div>
          <div class="row">
            <div class="field"><label class="label" for="user-name">Name</label><input id="user-name" type="text" placeholder="Charlie Example" autocomplete="off"></div>
            <div class="field"><label class="label" for="user-username">Username</label><input id="user-username" type="text" placeholder="charlie" autocomplete="off"></div>
          </div>
          <div class="row">
            <div class="field"><label class="label" for="user-email">Email</label><input id="user-email" type="email" placeholder="charlie@example.org" autocomplete="off"></div>
            <div class="field"><label class="label" for="user-roles">Roles</label><input id="user-roles" type="text" placeholder="ADMIN, STAFF" autocomplete="off"></div>
          </div>
          <div class="row">
            <div class="field"><label class="label" for="user-password">Password</label><input id="user-password" type="text" placeholder="The password they sign in with" autocomplete="off"></div>
          </div>
          <div class="row">
            <label class="check"><input id="user-second-factor" type="checkbox"> Asks for a second factor</label>
            <label class="check"><input id="user-disabled" type="checkbox"> Disabled</label>
          </div>${fieldsHtml(fields)}
          <div class="row">
            <button class="button button--primary" id="user-add" type="button">Add user</button>
            <button class="button button--primary" id="user-save" type="button" hidden>Save changes</button>
            <button class="button" id="user-clear" type="button">Clear</button>
          </div>
          <p class="result" id="users-result" role="status" aria-live="polite"></p>
        </section>
        <section class="card" id="maintenance" aria-labelledby="maintenance-title">
          <h2 id="maintenance-title">Maintenance</h2>
          <p class="window" id="maintenance-window" aria-live="polite">No maintenance planned.</p>
          <div class="row">
            <div class="field"><label class="label" for="maintenance-start">Starts</label><input id="maintenance-start" type="datetime-local"></div>
            <div class="field"><label class="label" for="maintenance-end">Ends</label><input id="maintenance-end" type="datetime-local"></div>
          </div>
          <div class="field"><label class="label" for="maintenance-message">Message</label><input id="maintenance-message" type="text" placeholder="What clients tell people"></div>
          <div class="row">
            <button class="button button--primary" id="maintenance-announce" type="button">Announce</button>
            <button class="button" id="maintenance-go" type="button">Start now</button>
            <button class="button" id="maintenance-update" type="button">Update the window</button>
          </div>
          <div class="row">
            <button class="button button--ink" id="maintenance-stop" type="button">End maintenance</button>
            <button class="button" id="maintenance-cancel" type="button">Cancel the announcement</button>
          </div>
          <p class="hint">While it's on, the gateway paths answer 503 with a Retry-After and /readyz isn't ready; this page, /livez and the product's banner fields keep answering.</p>
        </section>
        <div id="actions" style="display: contents"></div>
      </div>
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
