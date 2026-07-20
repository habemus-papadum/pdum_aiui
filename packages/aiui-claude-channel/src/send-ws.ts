/**
 * The websocket sibling of send.ts.
 *
 * Where {@link sendPrompt} pushes a prompt via `POST /prompt`, this drives the
 * binary `/ws` protocol through the {@link connectChannelClient} library with
 * the built-in `text-concat` format: connect, open one thread, and send the
 * whole prompt in a single final (`fin`) frame. It's the simple client
 * `quick --ws` and the e2e test use to exercise the websocket path the same
 * way `sendPrompt` exercises the HTTP one.
 */
import { connectChannelClient } from "./client";
import type { RunningServer } from "./registry";
import { listMcpServers } from "./registry";

/** Outcome of a websocket send: the whole connect → send → close round-trip. */
export interface WsSendResult {
  /** True when the prompt was delivered and the thread closed cleanly. */
  ok: boolean;
  /** What went wrong, when `ok` is false. */
  error?: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface SendPromptWsOptions {
  /** Stream format to declare in the hello. Defaults to `"text-concat"`. */
  format?: string;
}

/**
 * Send prompt `text` to a specific running server over its `/ws` endpoint,
 * using the `text-concat` format (the whole prompt in one `fin` frame).
 * Resolves once the thread is closed; never rejects — transport failures come
 * back as `{ ok: false, error }`.
 */
export async function sendPromptWs(
  server: Pick<RunningServer, "port">,
  text: string,
  options: SendPromptWsOptions = {},
): Promise<WsSendResult> {
  let client: Awaited<ReturnType<typeof connectChannelClient>>;
  try {
    client = await connectChannelClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      format: options.format ?? "text-concat",
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  try {
    const ack = await client.openThread().finish({ text });
    return ack.ok && ack.closed === true
      ? { ok: true }
      : { ok: false, error: ack.error ?? "thread did not close" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    await client.close();
  }
}

/**
 * Find the running server advertising `tag` and send it `text` over the
 * websocket. The websocket counterpart of {@link sendPromptByTag}.
 *
 * @throws if no running server has that tag.
 */
export async function sendPromptWsByTag(
  tag: string,
  text: string,
  dir?: string,
  options?: SendPromptWsOptions,
): Promise<WsSendResult> {
  const server = listMcpServers(dir).find((s) => s.tag === tag);
  if (!server) {
    throw new Error(`no running aiui MCP server has tag "${tag}"`);
  }
  return sendPromptWs(server, text, options);
}
