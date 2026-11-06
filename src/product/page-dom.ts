// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Test helper: loads the /_mock controls page into jsdom and runs its script against a live mock
// server, so a test sees the rows and dropdowns the browser draws. A string-match on the served
// HTML can't see a runtime error in the page script; this can.

import { JSDOM } from "jsdom";

export interface LoadedPage {
  close: () => void;
  document: Document;
  /** Errors the page script raised, including the ones its own catch blocks swallow. */
  errors: string[];
  window: JSDOM["window"];
}

/** Resolve once the check passes, or fail with the page's own errors in the message. */
export const until = async (
  page: LoadedPage,
  check: () => boolean,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`${what}; page errors: ${page.errors.join(" | ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Load `${base}/_mock` and run its script; jsdom lacks fetch and matchMedia, so give it both. */
export const loadControlsPage = async (base: string): Promise<LoadedPage> => {
  const answer = await fetch(`${base}/_mock`);
  const html = await answer.text();
  const errors: string[] = [];
  const dom = new JSDOM(
    // The page's refresh() catches everything and shows "isn't answering"; log what it caught.
    html.replace(
      "} catch { fail(",
      '} catch (error) { console.error("swallowed: " + (error && error.stack || error)); fail(',
    ),
    {
      beforeParse(window) {
        const target = window as unknown as Record<string, unknown>;
        target.fetch = (input: string, init?: RequestInit) =>
          fetch(new URL(input, base), init);
        target.matchMedia = () => ({
          addEventListener() {},
          addListener() {},
          matches: false,
        });
        const console = target.console as { error: (...a: unknown[]) => void };
        console.error = (...arguments_: unknown[]) =>
          errors.push(arguments_.join(" "));
      },
      pretendToBeVisual: true,
      runScripts: "dangerously",
      url: `${base}/_mock`,
    },
  );
  dom.virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  return {
    close: () => dom.window.close(),
    document: dom.window.document,
    errors,
    window: dom.window,
  };
};
