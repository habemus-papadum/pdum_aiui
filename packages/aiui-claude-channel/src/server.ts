import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PageToolDirectory } from "./page-tools";
import { registerChannelTools } from "./tools";
import type { ChannelReload } from "./web";

/** Optional wiring for {@link createChannelServer}. */
export interface ChannelServerOptions {
  /**
   * The page-tool registry to expose through the `page_tools_list` /
   * `page_tools_call` MCP tools. Omit it (as tests and the bare server do) and
   * those tools are simply not advertised — only `channel_info` is.
   */
  pageTools?: PageToolDirectory;
  /**
   * Reload handle to expose through the `channel_reload` MCP tool. The web
   * server is created after this one, so callers pass a late-bound thunk that
   * dereferences it (see commands/mcp.ts). Omit it and `channel_reload` is not
   * advertised.
   */
  reload?: ChannelReload;
}

/** Exported for the render-audit harness, which quotes it verbatim. */
export const INSTRUCTIONS = [
  [
    "This is the aiui channel, a one-way event feed into your session.",
    'Events arrive as `<channel source="aiui" ...>` blocks: read them and act on',
    "them as context. The channel itself is one-way — there is nothing to reply",
    "to and no tool to call back into it (this server's tools stand alone).",
  ].join(" "),
  [
    "Prompts lowered by the aiui intent tool embed a small vocabulary you should",
    "know. Plain-text bracket markers carry the user's captured context inline,",
    "at the position it happened in their turn:",
    "`[screenshot located at <path>]` (a captured image saved at <path> — read it",
    "with your image tools; `[pasted image located at …]` is CLIPBOARD content,",
    "not what was on screen; `MISSING` means the pixels were never captured),",
    '`[selected text: "…"]` (an on-screen selection),',
    "`[code selection at `<loc>`: `<code>`]` (contributed code; long selections",
    "fence below a `(N lines)` header, elided past 50 lines), and",
    "`[page navigation: <path>]` / `[tab switch: <path>]` (the user changed page",
    "or tab mid-turn — text ABOVE such a marker refers to the previous page).",
  ].join(" "),
  [
    "XML sidecar blocks carry machine-readable metadata about the marker they",
    "follow. `<screenshot-metadata>` lists the UI elements a capture framed:",
    "`<element name source>` children with nested `<cell name source/>` cells.",
    "`<selection-metadata>` carries a selection's provenance: `source` (where it",
    "was authored), `tex` (TeX source of selected mathematics), and `<cell>` /",
    "`<tab>` children. Cells are dataflow nodes of the aiui framework — they",
    "only exist on pages marked as aiui apps; on other pages expect no",
    "element/cell metadata at all.",
  ].join(" "),
  [
    "`<tab …/>` is the canonical browser-tab record, used everywhere a tab is",
    "described (the prompt preamble, navigation/tab-switch boundaries, selection",
    "metadata). Attributes, all optional except url: `url`, `title`,",
    '`aiui-app="true"` (the page carries aiui instrumentation), `source-root`',
    "(the app's source directory), `chrome-tab-id`, `window-id`, `tab-index`,",
    "`cdp-target-id`, `driver-tab`. To act on a tab with the Chrome DevTools",
    "MCP: every id is a correlation HINT only — none is the DevTools MCP's own",
    "pageId. Call list_pages, match by url/title, select_page with the pageId it",
    "returned, and verify you selected the right page. The session-browser skill",
    "covers this workflow.",
  ].join(" "),
].join("\n\n");

/**
 * Construct the aiui Claude channel MCP `Server`.
 *
 * The server declares the experimental `claude/channel` capability, which is
 * what marks it as a Claude Code channel (rather than a plain tool/resource
 * server), plus a `tools` capability for `channel_info` and — when supplied —
 * `page_tools_list`/`page_tools_call` (a page-tool directory) and `channel_reload`
 * (a reload handle) (see {@link registerChannelTools}). `tools.listChanged` is
 * declared so the channel may send `notifications/tools/list_changed` when the
 * page-tool directory changes; the advertised MCP tool list itself stays the
 * static meta-tools — the notification's value is the refresh cycle it triggers
 * (measured safe cross- and mid-turn: archive/extension-spikes/RESULTS.md M3).
 * It is returned unconnected so callers (and tests) can inspect it without
 * wiring up a transport.
 */
export function createChannelServer(version: string, options: ChannelServerOptions = {}): Server {
  const server = new Server(
    { name: "aiui", version },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: { listChanged: true } },
      instructions: INSTRUCTIONS,
    },
  );
  registerChannelTools(server, {
    ...(options.pageTools ? { pageTools: options.pageTools } : {}),
    ...(options.reload ? { reload: options.reload } : {}),
  });
  return server;
}
