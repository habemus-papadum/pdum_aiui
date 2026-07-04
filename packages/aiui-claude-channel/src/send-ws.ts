/**
 * The websocket sibling of send.ts.
 *
 * Where {@link sendPrompt} pushes a prompt via `POST /prompt`, this drives the
 * `/ws` stream-processor protocol (see channel.ts) with the built-in
 * `text-concat` format: connect, hello, open one thread, send the text and
 * mark it done, and wait for the server's close confirmation. It's the simple
 * client `quick --ws` and the e2e test use to exercise the websocket path the
 * same way `sendPrompt` exercises the HTTP one.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ChannelResponse } from "./channel";
import { listMcpServers } from "./list";
import type { RunningServer } from "./registry";

/** Outcome of a websocket send: the whole hello → send → close round-trip. */
export interface WsSendResult {
  /** True when hello succeeded and the thread closed cleanly. */
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
 * using the `text-concat` format (the whole prompt in one `done` message).
 * Resolves once the thread is closed; never rejects — transport failures come
 * back as `{ ok: false, error }`.
 */
export function sendPromptWs(
  server: Pick<RunningServer, "port">,
  text: string,
  options: SendPromptWsOptions = {},
): Promise<WsSendResult> {
  const format = options.format ?? "text-concat";
  const threadId = randomUUID();
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    let sentPrompt = false;

    const finish = (result: WsSendResult): void => {
      socket.removeAllListeners();
      socket.close();
      resolve(result);
    };

    socket.on("error", (err) => finish({ ok: false, error: errorMessage(err) }));
    socket.on("close", () =>
      finish({ ok: false, error: "connection closed before the thread did" }),
    );

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", format }));
    });

    socket.on("message", (data) => {
      let response: ChannelResponse;
      try {
        response = JSON.parse(data.toString()) as ChannelResponse;
      } catch {
        finish({ ok: false, error: "server sent invalid JSON" });
        return;
      }
      if (!response.ok) {
        finish({ ok: false, error: response.error });
        return;
      }
      if (!sentPrompt) {
        // Hello accepted — open the thread and send the whole prompt at once.
        sentPrompt = true;
        socket.send(JSON.stringify({ threadId, payload: { text, done: true } }));
        return;
      }
      // Reply to the prompt: the thread should now be closed.
      finish({
        ok: response.closed === true,
        error: response.closed ? undefined : "thread did not close",
      });
    });
  });
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
