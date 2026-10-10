import type { CompiledPrompt, Part } from "./compile.ts";
import { frozen } from "./model.ts";

export type Role = "user" | "assistant";
export type Message = Readonly<{ role: Role; parts: readonly Part[] }>;
export type CurrentMessage = Readonly<{ role: Role; prompt: CompiledPrompt }>;
export type Turn = Readonly<{
  instructions?: CompiledPrompt;
  messages: readonly CurrentMessage[];
}>;
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export type History =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "messages"; messages: readonly Message[] }>
  | Readonly<{ kind: "provider-items"; protocol: string; items: readonly Json[] }>
  | Readonly<{
      kind: "remote";
      provider: string;
      reference: Readonly<{ kind: "conversation" | "thread" | "previous-response"; id: string }>;
    }>;

/** One invocation's new material, independent of history. Nothing is sent. */
export function renderTurn(options: {
  input: CompiledPrompt;
  instructions?: CompiledPrompt;
  beforeInput?: readonly CurrentMessage[];
  afterInput?: readonly CurrentMessage[];
}): Turn {
  return frozen({
    ...(options.instructions ? { instructions: options.instructions } : {}),
    messages: [
      ...(options.beforeInput ?? []).map((message) => ({ ...message })),
      { role: "user", prompt: options.input },
      ...(options.afterInput ?? []).map((message) => ({ ...message })),
    ],
  });
}

/** Provider-neutral inspection envelope, NOT a provider API payload. */
export function prepareRequest(turn: Turn, options: { history?: History } = {}) {
  // Snapshot caller-owned replay arrays/items. Later application mutation cannot change this request.
  const history = structuredClone(options.history ?? { kind: "none" as const });
  return frozen({
    schema: "request-envelope-spike/1" as const,
    status: "prepared-not-sent" as const,
    current: {
      ...(turn.instructions ? { instructions: turn.instructions.parts } : {}),
      messages: turn.messages.map(({ role, prompt }) => ({ role, parts: prompt.parts })),
    },
    history,
    accounting: {
      currentTextCodeUnits: [
        ...(turn.instructions ? [turn.instructions] : []),
        ...turn.messages.map((message) => message.prompt),
      ].reduce((sum, prompt) => sum + prompt.metrics.textCodeUnits, 0),
      history:
        history.kind === "remote"
          ? "unknown-server-state"
          : history.kind === "none"
            ? "none"
            : "preserved-unmeasured",
      requestTokens: null,
    },
  });
}
