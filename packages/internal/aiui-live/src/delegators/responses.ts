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

import { importText, type JsonValue } from "@habemus-papadum/aiui-prompts";
import {
  captureWire,
  lowerOperation,
  responseOperation,
} from "@habemus-papadum/aiui-prompts/operations";
import {
  instructionsWithToolBrief,
  renderPrompt,
  toolSnapshot,
} from "@habemus-papadum/aiui-viz/tool-brief";
import { requestContext, requestMessageValue } from "./messages.ts";

export { requestMessage } from "./messages.ts";

import { backendPromptValue } from "../prompt.ts";
import type { ReasoningEffort } from "../protocol.ts";
import { type Delegator, runTool } from "../types.ts";

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
      // tool's usage, read/write classes) — the same ToolBrief every consumer
      // projects, from the very tool array sent below; compiled as one prompt
      // whose record goes to the ledger beside the text.
      // The snapshot carries the schemas too: the request's tool list is the
      // toolkit's projection of it, so brief, schemas and fingerprint are one
      // document (the projection writes the API's default `strict: false`).
      const snapshot = toolSnapshot(
        [
          {
            ns: "app",
            brief: req.brief,
            tools: req.tools.map((tool) => ({ ...tool, inputSchema: tool.parameters })),
          },
        ],
        { site: "aiui-live responses delegator", delegation: req.id },
      );
      const preface =
        options.instructions !== undefined
          ? importText({
              text: options.instructions,
              origin: { site: "aiui-live ResponsesDelegatorOptions.instructions" },
            })
          : backendPromptValue({ app: options.app });
      const rendered = renderPrompt(instructionsWithToolBrief(preface, snapshot));
      const instructions = rendered.text;
      const contextUtterances = options.contextUtterances ?? 8;
      const composed = renderPrompt(requestMessageValue(req, contextUtterances), {
        context: requestContext(req, contextUtterances),
      });
      const message = composed.text;
      const toolsRecord = { fingerprint: snapshot.fingerprint, count: req.tools.length };
      req.record?.({
        what: "instructions",
        text: instructions,
        tools: toolsRecord,
        prompt: rendered.record,
      });
      req.record?.({ what: "message", text: message, prompt: composed.record });
      // Every round is a response operation of the toolkit's Responses
      // profile: the first binds the instructions and the message; a
      // continuation carries the items so far (the message, the model's
      // output, our tool outputs) as opaque provider history. The body sent
      // IS the lowered payload, captured as the wire beside the operation.
      const items: JsonValue[] = [];
      const target = { kind: "openai-responses/1" as const, model };
      const request = {
        ...(req.tools.length > 0 ? { tools: snapshot, toolChoice: "auto" as const } : {}),
        ...(options.effort !== undefined ? { reasoning: { effort: options.effort } } : {}),
        store: false,
      };
      const maxRounds = options.maxRounds ?? 6;
      for (let round = 0; round < maxRounds; round++) {
        const t0 = Date.now();
        const operation =
          round === 0
            ? responseOperation({
                instructions: rendered.record,
                messages: [{ key: "request", role: "user", content: composed.record }],
                ...request,
              })
            : responseOperation({
                instructions: rendered.record,
                messages: [],
                history: { kind: "provider-items", protocol: "openai-responses/1", items },
                ...request,
              });
        const prepared = lowerOperation(operation, target);
        const body = prepared.payload as { input: JsonValue[] } & Record<string, JsonValue>;
        if (round === 0) items.push(...body.input);
        req.record?.({
          what: "request",
          text: round === 0 ? message : "",
          round,
          operation,
          wire: captureWire(prepared, body, { capturedAt: new Date().toISOString() }),
        });
        const response = await doFetch(
          `${options.baseUrl ?? "https://api.openai.com"}/v1/responses`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
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
        items.push(...(output as JsonValue[]));
        for (const call of calls) {
          const name = call.name ?? "?";
          req.log(`call ${name}(${call.arguments ?? ""})`);
          const value = await runTool(req.tools, name, call.arguments ?? "{}", {
            caller: "live:responses",
            icon: "🎙",
            ref: req.id,
          });
          req.log(`${name} → ${JSON.stringify(value).slice(0, 200)}`);
          items.push({
            type: "function_call_output",
            ...(call.call_id !== undefined ? { call_id: call.call_id } : {}),
            output: typeof value === "string" ? value : JSON.stringify(value),
          });
        }
      }
      throw new Error(`gave up after ${maxRounds} tool rounds`);
    },
  };
}
