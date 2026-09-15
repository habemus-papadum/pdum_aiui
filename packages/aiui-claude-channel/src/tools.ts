/**
 * The MCP tools the channel server exposes to its Claude Code session.
 *
 * `channel_info` reports *this* server's own info: its tag, pid, port, cwd, and
 * the Claude Code session it's attached to. A server describes itself, not its
 * siblings. (Enumerating every running channel is a separate concern —
 * `listMcpServers` / `listChannels`, the library utilities the CLI uses.)
 *
 * `page_tools_list` / `page_tools_call` are the META tools over the page-tool
 * directory: the tool list advertised here is static, the tools that live in
 * the browser are discovered per TAB on demand, and nothing is ever pushed
 * into the session when they change (the channel-wakeups decision — see
 * page-tools.ts).
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PageToolDirectory, TabSelector } from "./page-tools";
import { type EnrichedChannel, listChannels } from "./registry";
import type { ChannelReload } from "./web";

const CHANNEL_INFO_TOOL = "channel_info";
const PAGE_TOOLS_LIST_TOOL = "page_tools_list";
const PAGE_TOOLS_CALL_TOOL = "page_tools_call";
const CHANNEL_RELOAD_TOOL = "channel_reload";

/**
 * A channel server plus the Claude Code session that owns it — since the
 * enriched-listing migration this IS the registry package's enriched channel
 * (session nested, `resolvedName` top-level).
 */
export type ChannelInfo = EnrichedChannel;

/** What {@link selfChannelInfo} returns before the server has registered. */
export interface UnregisteredInfo {
  registered: false;
  pid: number;
}

/**
 * This process's own channel info: its registry entry, enriched (live session
 * join through the shared 4 s agents cache). Shared by the `channel_info` MCP
 * tool and the debug API's `/debug/api/info`.
 */
export function selfChannelInfo(): ChannelInfo | UnregisteredInfo {
  const self = listChannels({ client: "channel" }).channels.find((c) => c.pid === process.pid);
  return self ?? { registered: false, pid: process.pid };
}

const PAGE_TOOLS_LIST_DESCRIPTION =
  "List the tools that live in the connected browser page(s) under development, grouped by TAB. " +
  "Returns a JSON array with one entry per connected tab: clientId, url, tab (the tab record — " +
  "url, title, and the ids the intent-client host has: chromeTabId/windowId/tabIndex under the " +
  "browser extension, targetId/driverTab under the plain-page CDP host), activeTab: true when the " +
  "user is looking at that tab (when known), and namespaces[] — each with ns, active (false = " +
  "the app parked it, off-route; still callable), and tools[] (name/description/inputSchema). " +
  "To narrow to ONE tab pass any id copied from the prompt's <tab …/> marker (chrome-tab-id → " +
  "chromeTabId, cdp-target-id → targetId, driver-tab → driverTab) or the tab's url (exact href, " +
  "or a prefix — the url list_pages prints works); no arguments lists every connected tab. " +
  "Nothing is pushed to you when page tools change — call this whenever you need the current " +
  "set. Empty when no intent client is running (pages dial nothing themselves).";

const PAGE_TOOLS_CALL_DESCRIPTION =
  "Invoke one tool in one browser page and return its JSON result. Args: { name (required), " +
  "args? (must match that tool's inputSchema), WHICH TAB — any one of chromeTabId | targetId | " +
  "driverTab | url | clientId, copied from page_tools_list or the prompt's <tab …/> marker — " +
  "and ns? when that tab holds several namespaces }. Always name the tab when more than one is " +
  "connected. With no tab named: a unique match routes, the tab the user is looking at wins a " +
  "tie, and anything still ambiguous errors listing the candidates. Errors if no page matches " +
  "the tab, no tool matches, the page is mid-reload, or the call times out (15 s).";

const CHANNEL_RELOAD_DESCRIPTION =
  "After you edit this channel's own source, reload its lowering layer in place — the format " +
  "registry is rebuilt from the code now on disk, no session restart. Live websockets drop and " +
  "reconnect on their own (an in-flight intent turn is abandoned; the page stays up), and the " +
  "MCP stdio session and web port are unaffected. Returns { reloaded, generation, socketsDropped }. " +
  "Only reloads the format-entry modules (processors, intent-v1) and their edits; changes deeper " +
  "in the import graph still need a full relaunch.";

/** The tab-naming arguments both page tools accept (flat — easier for a model than a nested object). */
const TAB_ARG_PROPERTIES = {
  chromeTabId: {
    type: "number",
    description: "The tab's chrome.tabs id (the <tab> marker's chrome-tab-id; extension host).",
  },
  targetId: {
    type: "string",
    description: "The tab's CDP target id (the <tab> marker's cdp-target-id; plain-page host).",
  },
  driverTab: {
    type: "number",
    description: "The plain-page host's tab handle (the <tab> marker's driver-tab).",
  },
  url: {
    type: "string",
    description: "The page url — an exact location.href, or a prefix of it.",
  },
  clientId: {
    type: "string",
    description: "An exact connection handle from page_tools_list.",
  },
} as const;

/** Read the flat tab-naming arguments into a directory selector (+ clientId). */
function readTabArgs(params: Record<string, unknown>): {
  tab: TabSelector | undefined;
  clientId: string | undefined;
} {
  const tab: TabSelector = {
    ...(typeof params.chromeTabId === "number" ? { chromeTabId: params.chromeTabId } : {}),
    ...(typeof params.targetId === "string" ? { targetId: params.targetId } : {}),
    ...(typeof params.driverTab === "number" ? { driverTab: params.driverTab } : {}),
    ...(typeof params.url === "string" ? { url: params.url } : {}),
  };
  return {
    tab: Object.keys(tab).length > 0 ? tab : undefined,
    clientId: typeof params.clientId === "string" ? params.clientId : undefined,
  };
}

/** JSON text tool result. */
const jsonResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** Error tool result (surfaced to the agent, not thrown, so it can adjust and retry). */
const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true as const,
});

/** Optional handles the channel tools drive (see {@link registerChannelTools}). */
export interface ChannelToolHandles {
  /** Exposes `page_tools_list` / `page_tools_call` when supplied. */
  pageTools?: PageToolDirectory;
  /** Exposes `channel_reload` when supplied (late-bound to the web server). */
  reload?: ChannelReload;
}

/**
 * Register the channel server's tools. Requires the server to have been created
 * with the `tools` capability (see {@link createChannelServer}). `channel_info`
 * is always advertised; a {@link PageToolDirectory} adds the page-tool bridge
 * tools (`page_tools_list` / `page_tools_call`), and a reload handle adds
 * `channel_reload`.
 */
export function registerChannelTools(server: Server, handles: ChannelToolHandles = {}): void {
  const { pageTools, reload } = handles;
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: CHANNEL_INFO_TOOL,
        description:
          "Return this aiui channel's own info: its tag, pid, ppid, port, cwd, and the " +
          "Claude Code session it's attached to (name, sessionId, status). Returns a JSON object.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      ...(pageTools
        ? [
            {
              name: PAGE_TOOLS_LIST_TOOL,
              description: PAGE_TOOLS_LIST_DESCRIPTION,
              inputSchema: {
                type: "object",
                properties: TAB_ARG_PROPERTIES,
                additionalProperties: false,
              },
            },
            {
              name: PAGE_TOOLS_CALL_TOOL,
              description: PAGE_TOOLS_CALL_DESCRIPTION,
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string", description: "The page tool to call." },
                  args: {
                    type: "object",
                    description: "Arguments matching the tool's inputSchema.",
                  },
                  ns: {
                    type: "string",
                    description: "Page namespace, when the tab holds several.",
                  },
                  ...TAB_ARG_PROPERTIES,
                },
                required: ["name"],
                additionalProperties: false,
              },
            },
          ]
        : []),
      ...(reload
        ? [
            {
              name: CHANNEL_RELOAD_TOOL,
              description: CHANNEL_RELOAD_DESCRIPTION,
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ]
        : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === CHANNEL_INFO_TOOL) {
      // Report our own registry entry (the file this process wrote for itself).
      return jsonResult(selfChannelInfo());
    }
    if (reload && name === CHANNEL_RELOAD_TOOL) {
      try {
        return jsonResult(await reload());
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
    if (pageTools && name === PAGE_TOOLS_LIST_TOOL) {
      const { tab, clientId } = readTabArgs((args ?? {}) as Record<string, unknown>);
      const entries = pageTools.tabs({ ...tab, ...(clientId !== undefined ? { clientId } : {}) });
      if (entries.length === 0 && (tab !== undefined || clientId !== undefined)) {
        // A named tab that isn't connected is worth an error the agent can act
        // on (which tabs ARE connected), not a silently empty list.
        const connected = pageTools.tabs();
        return errorResult(
          `no connected page matches ${JSON.stringify({ ...tab, ...(clientId ? { clientId } : {}) })}` +
            (connected.length > 0
              ? ` — connected tabs: ${JSON.stringify(
                  connected.map((e) => ({
                    clientId: e.clientId,
                    ...(e.url ? { url: e.url } : {}),
                    ...(e.tab ? { tab: e.tab } : {}),
                    ...(e.activeTab ? { activeTab: true } : {}),
                    namespaces: e.namespaces.map((n) => n.ns),
                  })),
                )}`
              : " — no page has registered tools (is an intent client running?)"),
        );
      }
      return jsonResult(entries);
    }
    if (pageTools && name === PAGE_TOOLS_CALL_TOOL) {
      const params = (args ?? {}) as Record<string, unknown>;
      if (typeof params.name !== "string") {
        return errorResult('page_tools_call requires a string "name" argument');
      }
      const { tab, clientId } = readTabArgs(params);
      try {
        const value = await pageTools.call({
          name: params.name,
          ...(tab !== undefined ? { tab } : {}),
          ...(clientId !== undefined ? { clientId } : {}),
          ...(typeof params.ns === "string" ? { ns: params.ns } : {}),
          ...(params.args !== undefined ? { args: params.args } : {}),
        });
        return jsonResult(value ?? null);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(`unknown tool: ${name}`);
  });
}
