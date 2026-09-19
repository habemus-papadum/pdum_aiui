/**
 * responses.ts — a reasoning backend over the OpenAI Responses API, run by
 * US (in the browser with a pasted/dev key, or on a server with its own).
 * This is the "fast path": a small model, the page's typed tools, one or two
 * rounds, a spoken sentence back. The hosted alternative (`delegation.type:
 * "responses"`) does the same loop on the vendor's side; this one exists so
 * the tools can live anywhere and the loop can be watched.
 *
 * Stateless chaining: every round resends the whole input (the previous
 * output items plus our `function_call_output`s). `store: false` throughout.
 */

import { renderToolBrief } from "@habemus-papadum/aiui-viz/tool-brief";
import { backendPrompt } from "../prompt.ts";
import type { ReasoningEffort } from "../protocol.ts";
import { backendToolFor, type DelegationRequest, type Delegator, runTool } from "../types.ts";

export interface ResponsesDelegatorOptions {
  /** The key, or a getter (evaluated per request so a paste takes effect). */
  key: string | (() => string | undefined);
  /** Default `gpt-5.4-mini`. */
  model?: string;
  instructions?: string;
  /** What the app is, for the default instructions. */
  app?: string;
  effort?: ReasoningEffort;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Tool-call rounds before giving up. Default 6. */
  maxRounds?: number;
  /** How many recent utterances to include as context. Default 8. */
  contextUtterances?: number;
}

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

interface ResponsesResult {
  id?: string;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export function responsesDelegator(options: ResponsesDelegatorOptions): Delegator {
  const model = options.model ?? "gpt-5.4-mini";
  return {
    name: "responses",
    describe: () =>
      `responses (${model}${options.effort !== undefined ? `, ${options.effort}` : ""})`,
    async handle(req) {
      const key = typeof options.key === "function" ? options.key() : options.key;
      if (key === undefined || key === "") {
        throw new Error(
          "no OpenAI key for the in-browser backend (paste one, or use a server delegator)",
        );
      }
      const doFetch = options.fetchImpl ?? fetch;
      // The task prompt, then the app's tools as a document (the brief, each
      // tool's usage, read/write classes) — the same section every consumer
      // renders, computed from the very tool array sent below.
      const toolBrief = renderToolBrief([{ ns: "app", brief: req.brief, tools: req.tools }]);
      const instructions = [options.instructions ?? backendPrompt({ app: options.app }), toolBrief]
        .filter((part) => part !== "")
        .join("\n\n");
      const tools = req.tools.map(backendToolFor);
      const input: unknown[] = [
        { role: "user", content: requestMessage(req, options.contextUtterances ?? 8) },
      ];
      const maxRounds = options.maxRounds ?? 6;
      for (let round = 0; round < maxRounds; round++) {
        const t0 = Date.now();
        const response = await doFetch(
          `${options.baseUrl ?? "https://api.openai.com"}/v1/responses`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              instructions,
              input,
              tools,
              tool_choice: tools.length > 0 ? "auto" : undefined,
              reasoning: options.effort !== undefined ? { effort: options.effort } : undefined,
              store: false,
            }),
            signal: req.signal,
          },
        );
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`responses ${response.status}: ${body.slice(0, 300)}`);
        }
        const result = (await response.json()) as ResponsesResult;
        const usage = result.usage;
        req.log(
          `round ${round + 1}: ${Date.now() - t0} ms, ${usage?.input_tokens ?? "?"} in / ${usage?.output_tokens ?? "?"} out`,
        );
        const output = result.output ?? [];
        const calls = output.filter((item) => item.type === "function_call");
        if (calls.length === 0) {
          const text = output
            .filter((item) => item.type === "message")
            .flatMap((item) => item.content ?? [])
            .filter((part) => part.type === "output_text")
            .map((part) => part.text ?? "")
            .join("\n")
            .trim();
          return text === "" ? "The backend finished without a spoken result." : text;
        }
        input.push(...output);
        for (const call of calls) {
          const name = call.name ?? "?";
          req.log(`call ${name}(${call.arguments ?? ""})`);
          const value = await runTool(req.tools, name, call.arguments ?? "{}", {
            caller: "live:responses",
            ref: req.id,
          });
          req.log(`${name} → ${JSON.stringify(value).slice(0, 200)}`);
          input.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: typeof value === "string" ? value : JSON.stringify(value),
          });
        }
      }
      throw new Error(`gave up after ${maxRounds} tool rounds`);
    },
  };
}

/** The user message for one delegation: recent context, then the request. */
export function requestMessage(req: DelegationRequest, contextUtterances: number): string {
  const recent = [
    ...req.transcript.user.map((u) => ({ role: "user", ...u })),
    ...req.transcript.assistant.map((u) => ({ role: "assistant", ...u })),
  ]
    .sort((a, b) => a.startMs - b.startMs)
    .slice(-contextUtterances)
    .map((u) => `${u.role}: ${u.text}`)
    .join("\n");
  return [
    recent === ""
      ? ""
      : `Recent conversation (transcribed speech, may contain errors):\n${recent}\n`,
    `Request (delegation ${req.id}): ${req.text === "" ? "(the transcript has not arrived yet; use the recent conversation)" : req.text}`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}
