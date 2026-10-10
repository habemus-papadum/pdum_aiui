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
 *
 * Everything you can see is scenery, built to be rebuilt. Start talking.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { VoiceDock } from "@habemus-papadum/aiui-dock";
import { render } from "@solidjs/web";
import "@habemus-papadum/aiui-design/site.css";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers agent tools
import { App } from "./ui/App";

render(
  () => (
    <>
      <App />
      <VoiceDock />
    </>
  ),
  document.getElementById("root") as HTMLElement,
);
