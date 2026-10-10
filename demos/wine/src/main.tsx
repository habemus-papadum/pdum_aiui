/**
 * ── START HERE ────────────────────────────────────────────────────────────────
 *
 * This is an INTERACTIVE WEB PAGE meant to be rebuilt by an agent while you
 * watch it hot-reload — not a static site. One process runs it:
 *
 *   pnpm dev          this app, served by Vite
 *
 * The voice dock on the page (an oracle over OpenAI's realtime API, with the
 * app's cells as its tools) takes OPENAI_API_KEY from the dev server's
 * environment, or a key pasted into its field. Describe what you want and
 * edit this code with your coding agent while the page keeps running.
 *
 * There is deliberately almost nothing in this file. The aiui() plugin
 * (vite.config.ts — the entire integration) stamps the source locations the
 * page's attribution tools read; the app splits along HMR lines:
 *
 *   src/model/store.ts   durable roots — parameters survive hot edits
 *   src/model/graph.ts   the cell graph (dataflow) + the agent tools
 *   src/ui/              components — freely hot-swappable
 *   src/page.tsx         the app as a mountable SitePage (both hosts' entry)
 *   src/index.ts         the library barrel (what siblings import)
 *   src/card.tsx         the app's live landing card (a gallery's preview)
 *
 * Everything you can see is scenery, built to be rebuilt. Start talking.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import "@habemus-papadum/aiui-design/site.css";
import { VoiceDock } from "@habemus-papadum/aiui-dock";
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { page } from "./page";

document.title = page.title;
page.activate?.();
// PageBoundary: an uncaught effect throw would otherwise halt the page's
// whole reactive system (Solid 2.0 semantics) — contained, it renders a
// fault card with a reset instead. Same seam a multi-app shell uses.
render(
  () => (
    <PageBoundary name={page.title}>
      <page.App />
      <VoiceDock />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
