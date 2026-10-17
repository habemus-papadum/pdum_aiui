/**
 * messages.ts — the text a delegation hands its backend, as prompt VALUES
 * compiled late: the Responses backend's per-delegation user message and
 * the Claude backend's `<delegation>` element, each built from the same
 * request and the same tool document (the prompt toolkit's `ToolSnapshot`,
 * taken by aiui-viz's `toolSnapshot`), so the corpus and the ledger hold
 * exactly what a backend read — and the record says why: the request's
 * facts (an empty transcript, no tools) are `Case` decisions, not branches
 * lost in TypeScript.
 */
import {
  Case,
  Elide,
  Group,
  Join,
  type JsonObject,
  Prompt,
  type PromptNode,
  type SemanticRecord,
  Text,
  Use,
  Xml,
} from "@habemus-papadum/aiui-prompts";
import {
  renderPrompt,
  type ToolSnapshot,
  toolBrief,
  toolSnapshot,
} from "@habemus-papadum/aiui-viz/tool-brief";
import type { DelegationRequest } from "../types.ts";

/** Said in place of the request when its transcript has not arrived. */
export const REQUEST_NOT_YET_TRANSCRIBED =
  "(the transcript has not arrived yet; use the recent conversation)";

const site = (name: string) => ({ site: `aiui-live ${name}` });

/**
 * The request's facts, as the context a message is compiled under: whether
 * its text has arrived, how much recent conversation it carries. The record
 * keeps them beside the decisions they made.
 */
export function requestContext(req: DelegationRequest, contextUtterances: number): JsonObject {
  const total = req.transcript.user.length + req.transcript.assistant.length;
  return {
    request: {
      id: req.id,
      empty: req.text === "",
      contextUtterances,
      utterances: { total, shown: Math.min(total, contextUtterances) },
    },
  };
}

/**
 * The transcript's lines, oldest first, as `role: text` — every line, under
 * a tail elision that keeps the last `contextUtterances`: the cut is the
 * record's decision (which lines, how many dropped), not a slice the host
 * took before the record existed. Each line carries its own newline, so any
 * kept subset reads the same.
 */
function recentLines(req: DelegationRequest, contextUtterances: number): PromptNode {
  const lines = [
    ...req.transcript.user.map((u) => ({ role: "user" as const, ...u })),
    ...req.transcript.assistant.map((u) => ({ role: "assistant" as const, ...u })),
  ].sort((a, b) => a.startMs - b.startMs);
  return Elide({
    unit: "items",
    limit: contextUtterances,
    keep: "last",
    marker: "",
    label: "recent",
    children: lines.map((u) =>
      Text({
        value: `\n${u.role}: ${u.text}`,
        origin: { kind: "utterance", role: u.role, startMs: u.startMs, endMs: u.endMs },
      }),
    ),
  });
}

/**
 * The user message for one delegation as a prompt VALUE: the recent
 * conversation (a `Case` on whether there is any), then the request line,
 * whose text is a `Case` on whether the transcript has arrived. Compile it
 * under {@link requestContext}.
 */
export function requestMessageValue(req: DelegationRequest, contextUtterances: number): PromptNode {
  return Prompt({
    children: [
      Use({
        key: "recent",
        value: Case({
          name: "recent-context",
          branches: [
            { when: { op: "eq", path: "request.utterances.shown", value: 0 }, value: null },
          ],
          fallback: Group({
            children: [
              Text({
                value: "Recent conversation (transcribed speech, may contain errors):",
                origin: site("label"),
              }),
              recentLines(req, contextUtterances),
            ],
          }),
        }),
      }),
      Use({
        key: "request",
        value: Group({
          children: [
            Text({ value: "Request (delegation ", origin: site("label") }),
            Text({ value: req.id, origin: { kind: "delegation-id" } }),
            Text({ value: "): ", origin: site("label") }),
            Case({
              name: "request-text",
              branches: [
                {
                  when: { op: "eq", path: "request.empty", value: true },
                  value: Text({
                    value: REQUEST_NOT_YET_TRANSCRIBED,
                    origin: site("REQUEST_NOT_YET_TRANSCRIBED"),
                  }),
                },
              ],
              fallback: Text({ value: req.text, origin: { kind: "request-text" } }),
            }),
          ],
        }),
      }),
    ],
  });
}

/** The user message for one delegation as text ({@link requestMessageValue} compiled). */
export function requestMessage(req: DelegationRequest, contextUtterances: number): string {
  return renderPrompt(requestMessageValue(req, contextUtterances), {
    context: requestContext(req, contextUtterances),
  }).text;
}

/** `sql, limit?, format?` — the argument names a JSON-schema object declares,
 * required ones bare, optional ones marked. */
export function parameterList(parameters: Record<string, unknown>): string {
  const props = parameters.properties;
  const names = props !== null && typeof props === "object" ? Object.keys(props as object) : [];
  const required = new Set(
    Array.isArray(parameters.required) ? (parameters.required as unknown[]).map(String) : [],
  );
  return names.map((name) => (required.has(name) ? name : `${name}?`)).join(", ");
}

/**
 * The Claude backend's per-delegation message as a prompt VALUE: a
 * `<delegation id>` element wrapping the request message, the app's tools as
 * the document every consumer renders (the `ToolBrief` node, or `(none)` —
 * a `Case` on the tool count), and the argument names from the same tool
 * array — a guessed name costs a turn (`sql({ query })` for `sql({ sql })`,
 * found live 2026-10-08); `app_list` still has the full JSON schemas. Text
 * inside the element is XML-escaped once by the compiler.
 */
export function delegationMessageValue(
  req: DelegationRequest,
  contextUtterances: number,
  snapshot: ToolSnapshot,
): PromptNode {
  const noTools = { op: "eq" as const, path: "tools.count", value: 0 };
  return Xml({
    tag: "delegation",
    attributes: { id: req.id },
    children: [
      Text({ value: "\n", origin: site("label") }),
      Prompt({
        children: [
          Use({ key: "message", value: requestMessageValue(req, contextUtterances) }),
          Use({
            key: "tools",
            value: Join({
              separator: "\n",
              children: [
                Text({ value: "App tools available through app_call:", origin: site("label") }),
                Case({
                  name: "tools",
                  branches: [
                    { when: noTools, value: Text({ value: "(none)", origin: site("label") }) },
                  ],
                  fallback: toolBrief(snapshot),
                }),
              ],
            }),
          }),
          Use({
            key: "arguments",
            value: Case({
              name: "tool-arguments",
              branches: [{ when: noTools, value: null }],
              fallback: Join({
                separator: "\n",
                children: [
                  Text({
                    value: "app_call arguments by tool (app_list has the full schemas):",
                    origin: site("label"),
                  }),
                  ...req.tools.map((tool) =>
                    Text({
                      value: `- ${tool.name}(${parameterList(tool.parameters)})`,
                      origin: {
                        kind: "tool-signature",
                        snapshot: snapshot.fingerprint,
                        name: tool.name,
                      },
                    }),
                  ),
                ],
              }),
            }),
          }),
        ],
      }),
      Text({ value: "\n", origin: site("label") }),
    ],
  });
}

/** The Claude backend's per-delegation message: its text, the tool document
 * it was projected from, and the semantic record it compiles from. */
export function delegationMessage(
  req: DelegationRequest,
  contextUtterances = 10,
): { text: string; tools: ToolSnapshot; record: SemanticRecord } {
  const snapshot = toolSnapshot(
    [
      {
        ns: "app",
        brief: req.brief,
        tools: req.tools.map((tool) => ({ ...tool, inputSchema: tool.parameters })),
      },
    ],
    { site: "aiui-live delegation", delegation: req.id },
  );
  const rendered = renderPrompt(delegationMessageValue(req, contextUtterances, snapshot), {
    context: {
      ...requestContext(req, contextUtterances),
      tools: { count: req.tools.length, fingerprint: snapshot.fingerprint },
    },
  });
  return { text: rendered.text, tools: snapshot, record: rendered.record };
}
