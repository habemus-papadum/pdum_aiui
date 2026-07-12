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
  /** The unpacked aiui extensions the browser was asked to load, if any. */
  extensionDirs?: string[];
}

/**
 * The status of the `OPENAI_API_KEY` the intent pipeline needs, as the launcher
 * found it at startup. A *status*, never the key itself (or any prefix of it) —
 * the DevTools panel uses this to explain a degraded pipeline without ever
 * seeing the secret. See `aiui`'s openai-preflight for how it's determined.
 *
 *  - "valid"      — present and accepted by OpenAI (authenticated check passed).
 *  - "invalid"    — present but rejected (401/403) — usually a stale shell export.
 *  - "missing"    — not set in the launcher's environment.
 *  - "unverified" — present but not checked (CI/non-interactive) or the check
 *                   couldn't complete (offline, timeout, transient error).
 *
 * `GEMINI_API_KEY` (the realtime submode's Gemini Live engine) reports through
 * the same status vocabulary — see {@link LaunchInfo.geminiKey}.
 */
export type OpenAiKeyStatus = "valid" | "invalid" | "missing" | "unverified";

/** The launcher-provided session summary (extensible envelope). */
export interface LaunchInfo {
  /** What assembled this session, e.g. "aiui claude". */
  launcher?: string;
  chromeDevtools?: ChromeDevtoolsInfo;
  /**
   * How the launcher's OpenAI key preflight came out (status only, never the
   * key). Absent when no launcher recorded it. Lets the DevTools panel explain
   * why transcription/correction are unavailable.
   */
  openaiKey?: OpenAiKeyStatus;
  /**
   * The GEMINI_API_KEY preflight's outcome (same vocabulary, status only) —
   * the key the realtime submode's Gemini Live engine needs. Absent when no
   * launcher recorded it.
   */
  geminiKey?: OpenAiKeyStatus;
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
