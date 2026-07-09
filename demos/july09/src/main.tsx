/**
 * ── START HERE ────────────────────────────────────────────────────────────────
 *
 * This is an INTERACTIVE WEB PAGE wired into a live coding loop — not a static
 * site. Two processes are (or should be) running:
 *
 *   terminal 1:  npm run claude    Claude Code with the aiui channel + browser
 *   terminal 2:  npm run dev       this app, served by Vite via `aiui vite`
 *
 * On the page, press ` (backtick) or the floating ✳ aiui button, then SAY or
 * type what you want. Your words (plus screenshots and the source locations of
 * what you pointed at) land in the Claude session as a prompt, and the agent
 * edits this very code while you watch it hot-reload.
 *
 * The page is currently blank — a fresh canvas. The aiui intent tool is mounted
 * by the aiuiDevOverlay() plugin (vite.config.ts — the entire integration), and
 * the app is split along HMR lines:
 *
 *   src/model/store.ts   durable roots — parameters survive hot edits
 *   src/model/graph.ts   the cell graph (dataflow) + the agent tools
 *   src/ui/              components — freely hot-swappable
 *
 * Start talking.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { render } from "@solidjs/web";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers agent tools
import { App } from "./ui/App";

render(() => <App />, document.getElementById("root") as HTMLElement);
