/**
 * claude/index.ts — Claude Code as the reasoning backend (node-only, the
 * `./claude` subpath; `@anthropic-ai/claude-agent-sdk` is an optional peer).
 *
 * One long-lived `query()` per delegator, in streaming-input mode, so the
 * agent keeps its context across delegations: a follow-up question lands in
 * the same session that just read the code. Measured before this was
 * written (exploration/live-probe, 2026-09-15):
 *  - a user message pushed WHILE a turn runs is NOT interleaved — it is
 *    dropped or folded, never answered — so delegations are SERIALIZED here:
 *    the next one is pushed only after the previous turn's `result`;
 *  - `interrupt()` aborts the running turn (`result/error_during_execution`)
 *    and the query survives for the next message — that is our cancel;
 *  - authentication rides the CLI's own login (`apiKeySource: none`); no
 *    API key is required;
 *  - MCP tools are deferred behind ToolSearch unless `alwaysLoad` — that
 *    detour cost ~4 s on the first `say`, so it is set here.
 *
 * The agent SPEAKS only through the `say` tool; `note`/`steer` map to the
 * other two appends; `app_call`/`app_list` reach the page's live tools over
 * the relay. Its working directory is the app's source tree, so "why does
 * the trace look jagged" is answered by reading the renderer.
 */

import {
  createSdkMcpServer,
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { requestMessage } from "../delegators/responses.ts";
import { type DelegationRequest, type Delegator, runTool } from "../types.ts";

export interface ClaudeDelegatorOptions {
  /** The agent's working directory — the app's source tree, ideally. */
  cwd?: string;
  model?: string;
  effort?: Options["effort"];
  /** Appended to the Claude Code preset system prompt, after the live brief. */
  systemPrompt?: string;
  /** Built-in tools the agent may use. Default: read-only code tools + Bash. */
  allowedTools?: string[];
  maxTurns?: number;
  /** `true` (default): no user/project settings, no other MCP servers — a
   * clean backend. `false`: the user's full Claude Code configuration. */
  isolate?: boolean;
  permissionMode?: Options["permissionMode"];
  /** The CLI to spawn. Default: the SDK's own bundled, version-matched
   * binary (its per-platform optional dependency). Point this at an
   * installed `claude` to share that install instead. */
  pathToClaudeCodeExecutable?: string;
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

export const DEFAULT_CLAUDE_TOOLS = ["Read", "Grep", "Glob", "Bash", "WebFetch"];

export const CLAUDE_LIVE_BRIEF = `You are the reasoning backend of a live voice assistant ("the oracle") embedded in a scientific visualization app.
The user is TALKING to a voice model. That model delegated their request to you and is holding the conversation while you work. The user cannot see any text you write — they hear ONLY what you pass to the \`say\` tool.
Each delegation arrives as a user message tagged <delegation id="…">. Always pass that id to say/note/steer.
Rules:
- Answer with \`say\`: one or two spoken sentences, plain words, no markdown, no lists, rounded numbers.
- For anything that will take more than about ten seconds, \`say\` a short progress line first (what you are checking), then work, then \`say\` the result.
- Use \`note\` for quiet facts the voice model may need later; use \`steer\` only for directives to the voice model (rarely).
- Use \`app_call\` for the app's live tools (listed in the delegation) whenever the request is about the app's state or asks to change it. Read before you change. Never guess a value you could have read.
- When the question is about how the app behaves, read the code in the working directory and answer from it.
- If you cannot finish, \`say\` so plainly.`;

interface Turn {
  req: DelegationRequest;
  spoke: boolean;
  resolve(result: string | undefined): void;
  reject(error: Error): void;
}

export function claudeDelegator(options: ClaudeDelegatorOptions = {}): Delegator {
  const log = options.log ?? (() => {});
  let q: Query | undefined;
  let alive = false;
  let current: Turn | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const inbox: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (inbox.length === 0 && !ended) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const next = inbox.shift();
          return next === undefined
            ? { value: undefined, done: true }
            : { value: next, done: false };
        },
      };
    },
  };

  const push = (text: string) => {
    inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    wake?.();
  };

  const withTurn = <T>(fn: (turn: Turn) => Promise<T>, fallback: T): Promise<T> =>
    current === undefined ? Promise.resolve(fallback) : fn(current);

  const server = createSdkMcpServer({
    name: "live",
    version: "0.1.0",
    alwaysLoad: true,
    instructions:
      "The voice channel: say (spoken), note (quiet), steer (directive), app_call/app_list (the app's live tools).",
    tools: [
      tool(
        "say",
        "Speak to the user. The ONLY way the user hears you. One or two plain sentences.",
        { text: z.string(), delegation_id: z.string().optional() },
        async ({ text }) => {
          await withTurn(async (turn) => {
            turn.spoke = true;
            await turn.req.say(text);
          }, undefined);
          return { content: [{ type: "text", text: "spoken" }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        "note",
        "Give the voice model a quiet fact it may use later. Not spoken.",
        { text: z.string(), delegation_id: z.string().optional() },
        async ({ text }) => {
          await withTurn((turn) => turn.req.note(text), undefined);
          return { content: [{ type: "text", text: "noted" }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        "steer",
        "A directive to the voice model (how to behave next). Use rarely.",
        { text: z.string(), delegation_id: z.string().optional() },
        async ({ text }) => {
          await withTurn((turn) => turn.req.steer(text), undefined);
          return { content: [{ type: "text", text: "steered" }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        "app_list",
        "List the app's live tools (name, description, JSON schema).",
        {},
        async () => {
          const specs = await withTurn(
            async (turn) =>
              turn.req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            [],
          );
          return { content: [{ type: "text", text: JSON.stringify(specs, null, 1) }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        "app_call",
        "Call one of the app's live tools by name with JSON arguments; returns what the app answered.",
        { name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() },
        async ({ name, arguments: args }) => {
          const result = await withTurn((turn) => runTool(turn.req.tools, name, args ?? {}), {
            error: "no active delegation",
          });
          return {
            content: [
              { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
            ],
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });

  const scrubbedEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // A nested Claude Code session must not inherit the parent's identity.
      if (
        value === undefined ||
        key === "CLAUDECODE" ||
        key === "CLAUDE_PID" ||
        key.startsWith("CLAUDE_CODE_")
      ) {
        continue;
      }
      env[key] = value;
    }
    return { ...env, ...options.env };
  };

  const ensureQuery = (): Query => {
    if (q !== undefined && alive) {
      return q;
    }
    const isolate = options.isolate ?? true;
    const permissionMode = options.permissionMode ?? "bypassPermissions";
    const allowed = [
      ...(options.allowedTools ?? DEFAULT_CLAUDE_TOOLS),
      "mcp__live__say",
      "mcp__live__note",
      "mcp__live__steer",
      "mcp__live__app_list",
      "mcp__live__app_call",
    ];
    const created = query({
      prompt: input,
      options: {
        cwd: options.cwd ?? process.cwd(),
        model: options.model,
        effort: options.effort,
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions" ? true : undefined,
        allowedTools: allowed,
        mcpServers: { live: server },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            options.systemPrompt === undefined
              ? CLAUDE_LIVE_BRIEF
              : `${CLAUDE_LIVE_BRIEF}\n\n${options.systemPrompt}`,
        },
        settingSources: isolate ? [] : undefined,
        strictMcpConfig: isolate,
        maxTurns: options.maxTurns ?? 60,
        env: scrubbedEnv(),
        pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
        includePartialMessages: false,
      },
    });
    q = created;
    alive = true;
    void readLoop(created).finally(() => {
      alive = false;
      const turn = current;
      current = undefined;
      turn?.reject(new Error("claude query ended"));
    });
    return created;
  };

  const readLoop = async (active: Query): Promise<void> => {
    try {
      for await (const message of active) {
        dispatch(message);
      }
    } catch (error) {
      log(`claude: query error ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const dispatch = (message: SDKMessage): void => {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          log(`claude: ${message.model} (cli ${message.claude_code_version}) in ${message.cwd}`);
          current?.req.log(`claude ${message.model} ready`);
        }
        return;
      case "assistant": {
        const turn = current;
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim() !== "") {
            turn?.req.log(`claude: ${block.text.trim().slice(0, 300)}`);
          } else if (block.type === "tool_use") {
            const args = JSON.stringify(block.input ?? {});
            turn?.req.log(`${block.name}(${args.length > 160 ? `${args.slice(0, 160)}…` : args})`);
          }
        }
        return;
      }
      case "result": {
        const turn = current;
        current = undefined;
        if (turn === undefined) {
          return;
        }
        const cost = "total_cost_usd" in message ? `$${message.total_cost_usd.toFixed(3)}` : "";
        turn.req.log(
          `claude: ${message.subtype} in ${(message.duration_ms / 1000).toFixed(1)} s, ${message.num_turns} turns ${cost}`,
        );
        if (message.subtype === "success") {
          turn.resolve(turn.spoke ? undefined : message.result);
        } else if (turn.req.signal.aborted) {
          turn.reject(new Error("cancelled"));
        } else {
          turn.reject(new Error(`claude: ${message.subtype}`));
        }
        return;
      }
      default:
        return;
    }
  };

  const runTurn = (req: DelegationRequest): Promise<string | undefined> =>
    new Promise<string | undefined>((resolve, reject) => {
      if (req.signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const active = ensureQuery();
      current = { req, spoke: false, resolve, reject };
      req.signal.addEventListener(
        "abort",
        () => {
          if (current?.req === req) {
            req.log("claude: interrupting");
            void active.interrupt().catch(() => {});
          }
        },
        { once: true },
      );
      const tools =
        req.tools.length === 0
          ? "(none)"
          : req.tools.map((t) => `${t.name} — ${t.description}`).join("\n");
      push(
        `<delegation id="${req.id}">\n${requestMessage(req, 10)}\n\nApp tools available through app_call:\n${tools}\n</delegation>`,
      );
    });

  return {
    name: "claude",
    describe: () =>
      `claude code (${options.model ?? "default model"}) in ${options.cwd ?? process.cwd()}`,
    handle(req) {
      const turn = chain.then(() => runTurn(req));
      chain = turn.catch(() => {});
      return turn;
    },
    dispose() {
      ended = true;
      wake?.();
      q = undefined;
      alive = false;
    },
  };
}
