/**
 * site-page.ts — the mountable-page contract between an app and a site shell.
 *
 * A {@link SitePage} is how one aiui app presents itself to a multi-page host
 * (a gallery of demos, a notebook journal, any SPA shell that swaps pages):
 * the shell mounts `App`, sets `title`, and drives the pause-not-destroy
 * lifecycle through `activate`/`deactivate`. It began as the pdum_aiui
 * gallery's page registry type and moved here so a page and its shell can live
 * in different packages.
 *
 * The lifecycle contract is **pause-not-destroy** (the durable model applied
 * to routing): durable resources — engines, workers, canvases, accrued
 * history — deliberately outlive the route. Leaving a page must PARK its
 * continuous work (rAF loops), not tear anything down; event-driven resources
 * (workers between jobs, DuckDB between queries, idle cells) cost nothing
 * while off-route and need no handling. Returning re-mounts components over
 * the surviving durables, exactly like an HMR swap. Both hooks must be
 * idempotent.
 *
 * ## The package convention (how a shell finds pages)
 *
 * A package that offers a page exports it (conventionally from a `./page`
 * subpath) as `export const page: SitePage`, and declares itself in its
 * package.json so shells can discover it without a hand-maintained registry:
 *
 * ```jsonc
 * "exports": {
 *   ".": "./src/index.ts",
 *   "./page": "./src/page.tsx",   // the full app (heavy: builds the graph)
 *   "./card": "./src/card.tsx"    // the landing-card preview (light) — see DemoCard
 * },
 * "aiui": {
 *   "sitePage": {
 *     "title": "morphogen",            // sidebar / card title
 *     "desc": "reaction–diffusion lab", // one-line sidebar description
 *     "order": 10,                      // sidebar position
 *     "entry": "./page",                // export subpath of the page module (default "./page")
 *     "card": "./card"                  // export subpath of the DemoCard module (default "./card")
 *   }
 * }
 * ```
 *
 * The page module's side effects are its wiring: importing it builds the
 * app's cell graph and registers its agent tools (under the app's own scoped
 * identity — see `scope()` — so pages from different packages coexist in one
 * document without colliding on controls, durables, graphs, or toolkits).
 *
 * In the pdum_aiui repo, `demos/gallery` is the reference shell: its Vite
 * plugin scans sibling demos for the marker and composes the sidebar, the
 * landing card grid, and the lazy page loaders automatically.
 */

import type { Component } from "solid-js";

/** One app, presented as a mountable page for a site shell. */
export interface SitePage {
  /** `document.title` while this page is the route. */
  title: string;
  /** The page's root component — mounted per visit, disposable (a pure reader
   * over the page's durable state, the HMR discipline reused for routing). */
  App: Component;
  /** Resume continuous work (rAF loops). Called before mount; idempotent. */
  activate?(): void;
  /** Park continuous work. Called when the route leaves; idempotent. */
  deactivate?(): void;
}

/**
 * A demo's **landing-card** content: a short blurb and a LIVE, self-contained
 * preview mini-app — the "gist" a gallery's landing page shows before you open
 * the real thing.
 *
 * Kept SEPARATE from {@link SitePage} on purpose, and exported from a separate
 * lightweight module (the `./card` subpath, alongside `./page`): a landing page
 * mounts EVERY demo's preview at once, so a card must not drag in the demo's
 * heavy durable graph (a WebGL context, DuckDB, workers…). A `Preview` is a
 * small, cheap component with its own local state — it may run its own rAF —
 * built from the demo's *pure* model only, never its `store`/`graph` modules.
 *
 * The package convention mirrors the page's (see this module's header): the
 * card module exports `export const card: DemoCard`, and the `aiui.sitePage`
 * marker's `card` field names its export subpath (default `"./card"`).
 */
export interface DemoCard {
  /** A one- or two-sentence blurb for the card — richer than the sidebar's
   * one-line `desc`. */
  blurb: string;
  /** The live preview: a small, self-contained, cheap mini-view of the app.
   * Mounted on the landing page and disposed (its rAF cancelled via
   * `onCleanup`) when the visitor leaves it. */
  Preview: Component;
}
