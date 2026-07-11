/**
 * The MCP tools the channel server exposes to its Claude Code session.
 *
 * There's one — `channel_info` — and it reports *this* server's own info: its
 * tag, pid, port, cwd, and the Claude Code session it's attached to. A server
 * describes itself, not its siblings. (Enumerating every running channel is a
 * separate concern — see {@link collectChannelInfo} / `listMcpServers`, the
 * library utilities the CLI uses.)
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ClaudeAgent, enrichServers, listClaudeAgents, type SessionInfo } from "./agents";
import type { PageToolDirectory } from "./page-tools";
import { type RegistryEntry, readEntry, registryFileFor } from "./registry";
import type { ChannelReload } from "./web";

const CHANNEL_INFO_TOOL = "channel_info";
const PAGE_TOOLS_LIST_TOOL = "page_tools_list";
const PAGE_TOOLS_CALL_TOOL = "page_tools_call";
const CHANNEL_RELOAD_TOOL = "channel_reload";

/** A channel server plus the Claude Code session that owns it. */
export interface ChannelInfo {
  tag: string;
  pid: number;
  ppid: number;
  port: number;
  cwd: string;
  startedAt: string;
  session?: SessionInfo;
}

/**
 * Pair registry entries with the Claude sessions that own them (matched by
 * `ppid`), dropping the on-disk `file` path. Pure given its inputs, so it's
 * testable without a live registry or `claude`. Used to describe one channel
 * (the `channel_info` tool) or many (a "list all" utility).
 */
export function collectChannelInfo(entries: RegistryEntry[], agents: ClaudeAgent[]): ChannelInfo[] {
  return enrichServers(entries, agents).map((s) => ({
    tag: s.tag,
    pid: s.pid,
    ppid: s.ppid,
    port: s.port,
    cwd: s.cwd,
    startedAt: s.startedAt,
    ...(s.session ? { session: s.session } : {}),
  }));
}

/** What {@link selfChannelInfo} returns before the server has registered. */
export interface UnregisteredInfo {
  registered: false;
  pid: number;
}

/**
 * This process's own channel info: its registry entry enriched with the Claude
 * session that owns it. Shared by the `channel_info` MCP tool and the debug
 * API's `/debug/api/info`.
 */
export function selfChannelInfo(): ChannelInfo | UnregisteredInfo {
  const self = readEntry(registryFileFor(process.pid));
  if (!self) {
    return { registered: false, pid: process.pid };
  }
  return (
    collectChannelInfo([self], listClaudeAgents())[0] ?? { registered: false, pid: process.pid }
  );
}

const PAGE_TOOLS_LIST_DESCRIPTION =
  "List the tools that live in the connected browser page(s) under development " +
  "(registered by the aiui dev overlay). Returns a JSON array of directory entries: " +
  "clientId, ns (page namespace), url, tab, and each tool's name/description/inputSchema. " +
  "Entries from the browser's active tab sort first and carry activeTab: true (when a " +
  "client reports tab activation; otherwise the flag is simply absent). " +
  "Call this FIRST to discover what's available, then invoke one with page_tools_call. " +
  "The list is empty when no dev page is connected.";

const PAGE_TOOLS_CALL_DESCRIPTION =
  "Invoke one of the browser page's tools (discover them with page_tools_list first) and " +
  "return its JSON result. Args: { name (required), args? (must match that tool's " +
  "inputSchema), ns? and clientId? to disambiguate }. When exactly one registered tool has " +
  "the given name you may omit ns/clientId; if several pages expose the same name, the one " +
  "on the browser's active tab wins — when that still doesn't single one out the call " +
  "errors and lists the candidates (pass ns and/or clientId to pick one). Errors if no page " +
  "is connected, no tool matches, the page is mid-reload, or the call times out.";

const CHANNEL_RELOAD_DESCRIPTION =
  "After you edit this channel's own source, reload its lowering layer in place — the format " +
  "registry is rebuilt from the code now on disk, no session restart. Live websockets drop and " +
  "reconnect on their own (an in-flight intent turn is abandoned; the page stays up), and the " +
  "MCP stdio session and web port are unaffected. Returns { reloaded, generation, socketsDropped }. " +
  "Only reloads the format-entry modules (processors, intent-v1) and their edits; changes deeper " +
  "in the import graph still need a full relaunch.";

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
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
                  ns: { type: "string", description: "Page namespace, to disambiguate." },
                  clientId: { type: "string", description: "Connection id, to disambiguate." },
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
      return jsonResult(pageTools.list());
    }
    if (pageTools && name === PAGE_TOOLS_CALL_TOOL) {
      const params = (args ?? {}) as Record<string, unknown>;
      if (typeof params.name !== "string") {
        return errorResult('page_tools_call requires a string "name" argument');
      }
      try {
        const value = await pageTools.call({
          name: params.name,
          ...(typeof params.ns === "string" ? { ns: params.ns } : {}),
          ...(typeof params.clientId === "string" ? { clientId: params.clientId } : {}),
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
