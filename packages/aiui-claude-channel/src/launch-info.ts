/**
 * Launch info: what the launcher told this channel server about the session
 * it lives in.
 *
 * The channel server can introspect its own half of the world (tag, port,
 * pid, owning Claude session — see tools.ts), but it can't see how the rest
 * of the session was assembled: most usefully, whether a Chrome DevTools MCP
 * was attached and how it reaches its browser. `aiui claude` knows, because
 * it assembled the `--mcp-config` — so it passes a JSON summary via
 * `aiui-claude-channel mcp --launch-info <json>`, and the server surfaces it
 * verbatim at `GET /debug/api/info` (under `launch`). The DevTools panel's
 * Server tab renders it, which is where you look first when the agent's
 * browser tooling is misbehaving: was the MCP even on, attach or launch,
 * which endpoint, which profile.
 *
 * Purely descriptive, deliberately: nothing here changes server behavior.
 */

/** How the session's Chrome DevTools MCP was wired at launch. */
export interface ChromeDevtoolsInfo {
  /** Whether a chrome-devtools MCP entry was included at all. */
  enabled: boolean;
  /**
   * "attach": pointed at a running browser's debug endpoint (`browserUrl`).
   * "launch": the MCP launches its own browser lazily on first tool use.
   */
  connection?: "attach" | "launch";
  /** The DevTools endpoint the MCP attaches to (attach mode). */
  browserUrl?: string;
  /** The browser profile in play, when the browser is managed locally. */
  userDataDir?: string;
  /** Explicit browser binary (e.g. a managed Chrome for Testing). */
  executablePath?: string;
  /** Installed branded-Chrome channel, when that's the browser. */
  channel?: string;
  headless?: boolean;
  /** The aiui devtools extension the browser was asked to load, if any. */
  extensionDir?: string;
}

/** The launcher-provided session summary (extensible envelope). */
export interface LaunchInfo {
  /** What assembled this session, e.g. "aiui claude". */
  launcher?: string;
  chromeDevtools?: ChromeDevtoolsInfo;
}

/**
 * Parse a `--launch-info` JSON argument, tolerantly: this is diagnostic
 * garnish, so a malformed value must never stop the MCP server from starting.
 * Returns undefined (and lets the caller log to stderr) on anything that
 * isn't a JSON object.
 */
export function parseLaunchInfo(raw: string): LaunchInfo | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as LaunchInfo;
    }
  } catch {}
  return undefined;
}
