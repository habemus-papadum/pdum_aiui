/**
 * The library form of "send a prompt to a running channel server" — the
 * non-interactive core that the `quick` CLI and test harnesses both build on.
 */
import { listMcpServers } from "./list";
import type { RunningServer } from "./registry";

export interface SendResult {
  /** True when the server accepted the prompt (HTTP 2xx and `{ ok: true }`). */
  ok: boolean;
  /** HTTP status the backend returned. */
  status: number;
  /** Error message the backend reported, if any. */
  error?: string;
}

/** POST prompt `text` to a specific running server's web backend. */
export async function sendPrompt(
  server: Pick<RunningServer, "port">,
  text: string,
): Promise<SendResult> {
  const response = await fetch(`http://127.0.0.1:${server.port}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return { ok: response.ok && body.ok === true, status: response.status, error: body.error };
}

/**
 * Find the running server advertising `tag` and send it `text`. This is the
 * "library version of quick" a test can call once it knows the tag it launched
 * Claude Code with.
 *
 * @throws if no running server has that tag.
 */
export async function sendPromptByTag(
  tag: string,
  text: string,
  dir?: string,
): Promise<SendResult> {
  const server = listMcpServers(dir).find((s) => s.tag === tag);
  if (!server) {
    throw new Error(`no running aiui MCP server has tag "${tag}"`);
  }
  return sendPrompt(server, text);
}
