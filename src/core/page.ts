/*
MIT License

Copyright (c) 2026 Shane

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/
// The mock's controls page at /_mock. It belongs to the mock server, not to any client: no
// sign-in, and it keeps working through Start fresh. Its buttons come from GET /_mock/controls
// (the core's and the product's actions), it posts to the same path, and it reads the state
// every couple of seconds, so a change made anywhere (another tab, a test, a phone) shows here.

import { product } from "#product/product.ts";

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock controls · ${escape(product.name)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #666; --bg: #fff; --line: #ccc; --ok: #1d6b3a; --okbg: #e3f4e8; --warn: #8a1c1c; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #aaa; --bg: #161616; --line: #444; --ok: #8fe0a8; --okbg: #12301c; --warn: #f19a9a; } }
  body { font: 14px/1.45 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem; display: flex; flex-direction: column; gap: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0; } h2 { font-size: 1rem; margin: 0 0 .5rem; }
  section { display: flex; flex-direction: column; gap: .5rem; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .hint { color: var(--muted); }
  button, select { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: .3rem .6rem; }
  #status { padding: .6rem .8rem; border-radius: 6px; background: var(--okbg); color: var(--ok); }
  #status.down { background: transparent; color: var(--warn); border: 1px solid var(--warn); }
  pre { margin: 0; white-space: pre-wrap; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div>
    <h1>Mock controls</h1>
    <p class="hint">The ${escape(product.name)} mock gateway's own page. No sign-in, and Start fresh never takes it down.</p>
  </div>
  <div id="status" role="status">Loading…</div>
  <section>
    <h2>Sign in as</h2>
    <div class="row"><select id="person"></select><button id="sign-in">Sign in here</button>
      <span class="hint">Any password works except "wrong-password"; any six digits except 000000.</span></div>
  </section>
  <div id="actions"></div>
  <section><h2>Data</h2><pre id="summary"></pre></section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  let drawn = "";
  const send = async (body) => {
    const answer = await fetch("/_mock/controls", { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });
    if (!answer.ok) { status.textContent = "That didn't work: " + answer.status; status.className = "down"; return; }
    await refresh();
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
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = title;
      section.append(heading);
      for (const action of list) {
        const row = document.createElement("div");
        row.className = "row";
        const button = document.createElement("button");
        button.textContent = action.label;
        button.addEventListener("click", () => send({ ...(action.body ?? {}), kind: action.kind }));
        row.append(button);
        if (action.hint) { const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = action.hint; row.append(hint); }
        section.append(row);
      }
      return section;
    }));
  };
  const refresh = async () => {
    try {
      const state = await (await fetch("/_mock/controls")).json();
      status.className = "";
      status.textContent = state.sessions.length + " signed in" + (state.failNext ? ", the next call fails" : "") + (state.needsSetup ? ", first-run setup is on" : "") + (state.freshAt ? ", started fresh " + new Date(state.freshAt).toLocaleTimeString() : "");
      draw(state.actions);
      $("summary").textContent = JSON.stringify(state.summary, null, 2);
    } catch { status.textContent = "The mock server isn't answering."; status.className = "down"; }
  };
  const people = async () => {
    const list = await (await fetch("/_mock/people")).json();
    $("person").replaceChildren(...list.filter((p) => !p.disabled).map((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name + " (" + p.username + ")"; return o; }));
  };
  $("sign-in").addEventListener("click", () => send({ kind: "sign-in", personId: $("person").value }));
  void people();
  void refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>
`;

export const answerPage = (
  request: Request,
  path: string,
): Response | undefined => {
  if (request.method !== "GET" || (path !== "/_mock" && path !== "/_mock/"))
    return undefined;
  return new Response(page(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
