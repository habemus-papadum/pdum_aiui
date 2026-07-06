/**
 * The `aiui-claude-channel serve` handshake: the first stdout line is
 * machine-parseable (`AIUI_CHANNEL_SERVE {json}`), everything after is human
 * chatter (lowered-prompt blocks). This parser is the workbench dev server's
 * half of that contract; node-side, shared with its tests.
 */
export interface ServeReady {
  port: number;
  pid: number;
  debug: boolean;
}

/** Parse the serve command's ready line; undefined when the line is not one. */
export function parseServeReadyLine(line: string): ServeReady | undefined {
  const match = line.match(/^AIUI_CHANNEL_SERVE (\{.*\})\s*$/);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1]) as { port?: unknown; pid?: unknown; debug?: unknown };
    if (typeof parsed.port === "number" && parsed.port > 0) {
      return {
        port: parsed.port,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
        debug: parsed.debug === true,
      };
    }
  } catch {
    // fall through — not a ready line after all
  }
  return undefined;
}
