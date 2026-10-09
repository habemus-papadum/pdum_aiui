/**
 * messages.ts — the text a delegation hands its backend, as pure functions:
 * the Responses backend's per-delegation user message and the Claude
 * backend's `<delegation>` message, each built from the same request and
 * the same tool document (aiui-viz's `toolSnapshot`), so the corpus and the
 * ledger can hold exactly what a backend read.
 */
import {
  renderToolBrief,
  type ToolSnapshot,
  toolSnapshot,
} from "@habemus-papadum/aiui-viz/tool-brief";
import type { DelegationRequest } from "../types";

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
 * The Claude backend's per-delegation message: the request under a
 * `<delegation id>` element, then the app's tools as the document every
 * consumer renders (the brief, each tool's usage, grouped read/write), then
 * the argument names from the same tool array — a guessed name costs a turn
 * (`sql({ query })` for `sql({ sql })`, found live 2026-10-08); `app_list`
 * still has the full JSON schemas.
 */
export function delegationMessage(
  req: DelegationRequest,
  contextUtterances = 10,
): { text: string; tools: ToolSnapshot } {
  const snapshot = toolSnapshot([{ ns: "app", brief: req.brief, tools: req.tools }]);
  const brief = renderToolBrief(snapshot);
  const tools = brief === "" ? "(none)" : brief;
  const signatures = req.tools.map((t) => `- ${t.name}(${parameterList(t.parameters)})`);
  const arguments_ =
    signatures.length === 0
      ? ""
      : `\n\napp_call arguments by tool (app_list has the full schemas):\n${signatures.join("\n")}`;
  return {
    text: `<delegation id="${req.id}">\n${requestMessage(req, contextUtterances)}\n\nApp tools available through app_call:\n${tools}${arguments_}\n</delegation>`,
    tools: snapshot,
  };
}
