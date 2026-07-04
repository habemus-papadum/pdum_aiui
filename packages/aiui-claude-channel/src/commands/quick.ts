/**
 * `aiui-claude-channel quick` — pick a running channel server and push a prompt
 * into its Claude Code session. A minimal end-to-end exercise of the registry,
 * the selector widget, and the web backend.
 */
import { input } from "@inquirer/prompts";
import { listMcpServers } from "../list";
import type { RunningServer } from "../registry";
import { selectMcpServer } from "../select";
import { sendPrompt } from "../send";

export interface QuickOptions {
  /**
   * Target the server advertising this tag, skipping the interactive selector.
   * Handy for scripted/test-harness use where the tag is known in advance.
   */
  tag?: string;
  /**
   * Prompt text to send. When given, the interactive text prompt is skipped, so
   * `quick --tag <t> --message "..."` is a fully non-interactive one-shot send.
   */
  message?: string;
}

/** Run the (select-a-server-and-)send-a-prompt flow. */
export async function runQuick(options: QuickOptions = {}): Promise<void> {
  const servers = listMcpServers();
  if (servers.length === 0) {
    console.error(
      "No running aiui MCP servers found. Start one first — e.g. `aiui claude` — then retry.",
    );
    process.exitCode = 1;
    return;
  }

  let server: RunningServer;
  if (options.tag) {
    const match = servers.find((s) => s.tag === options.tag);
    if (!match) {
      console.error(`No running aiui MCP server has tag "${options.tag}".`);
      console.error(`Running tags: ${servers.map((s) => s.tag).join(", ") || "(none)"}`);
      process.exitCode = 1;
      return;
    }
    server = match;
  } else {
    server = await selectMcpServer(servers);
  }
  console.error(`→ ${server.cwd} (tag ${server.tag}, pid ${server.pid}, port ${server.port})`);

  const text = options.message ?? (await input({ message: "Prompt to send" }));
  if (!text.trim()) {
    console.error("Empty prompt — nothing sent.");
    return;
  }

  let result: Awaited<ReturnType<typeof sendPrompt>>;
  try {
    result = await sendPrompt(server, text);
  } catch (err) {
    console.error(
      `Failed to reach the server: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    console.error(`Server responded ${result.status}${result.error ? `: ${result.error}` : ""}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Sent. The prompt should now appear in the session at ${server.cwd}.`);
}
