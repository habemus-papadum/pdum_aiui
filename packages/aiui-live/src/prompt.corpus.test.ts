/**
 * The CORPUS of the live session's prompt text and its delegations' messages,
 * as readable files under ../corpus/ — a baseline for the prompt-toolkit
 * migration, not a contract (docs/proposals/structured-prompts-review.md).
 * `vitest -u` updates; review the diff.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_LIVE_BRIEF } from "./claude/brief";
import { delegationMessage, requestMessage } from "./delegators/messages";
import { backendPrompt, backendToolsFromTools, livePrompt } from "./prompt";
import type { DelegationRequest, LiveTool } from "./types";

const corpus = (name: string): string => join(__dirname, "..", "corpus", name);

const tools: LiveTool[] = [
  {
    name: "report",
    description: "One bounded snapshot of the page's state. Call it first.",
    usage: "Re-read after a write.",
    kind: "read",
    group: "app",
    parameters: {
      type: "object",
      properties: { format: { type: "string", enum: ["brief", "full"] } },
    },
    execute: async () => ({}),
  },
  {
    name: "set",
    description: "Set one control by name. Returns the value actually applied.",
    usage: "Trust the value returned over the one you sent.",
    kind: "write",
    group: "app",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, value: {} },
      required: ["name", "value"],
    },
    execute: async () => ({}),
  },
  {
    name: "sql",
    description: "Run one read-only SQL statement against the catalog.",
    usage: "Tables: `quakes`. Aggregate in SQL rather than fetching rows.",
    kind: "read",
    group: "sql",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" }, limit: { type: "number" } },
      required: ["sql"],
    },
    execute: async () => ({}),
  },
];
const brief =
  "An earthquake catalog: a map, a magnitude histogram and a depth histogram, cross-filtered. Brush any view and the others follow.";

const request: DelegationRequest = {
  id: "d_7",
  text: "set the frequency to five hertz",
  transcript: {
    user: [
      { text: "hello there", startMs: 0, endMs: 900 },
      { text: "set the frequency to five hertz", startMs: 4000, endMs: 6000 },
    ],
    assistant: [{ text: "Hi. What would you like?", startMs: 1200, endMs: 2500 }],
  } as never,
  tools,
  brief,
  signal: new AbortController().signal,
  say: async () => {},
  note: async () => {},
  steer: async () => {},
  log: () => {},
};

describe("corpus: the live prompt", () => {
  it("the session instructions with default slots, and with every slot authored", async () => {
    await expect(livePrompt()).toMatchFileSnapshot(corpus("live-prompt-defaults.txt"));
    await expect(
      livePrompt({
        app: "An earthquake catalog with cross-filtered views.",
        stance: "The user is demonstrating; keep it short.",
        backendTools: `- Reading the app's source code.\n${backendToolsFromTools(tools, brief) ?? ""}`,
        delegateWhen: "- Anything about a setting or the data.",
        dontDelegateWhen: "- Greetings.",
        extra: "Never say 'as an AI'.",
      }),
    ).toMatchFileSnapshot(corpus("live-prompt-slots.txt"));
  });

  it("the derived capability list", async () => {
    await expect(backendToolsFromTools(tools, brief) ?? "").toMatchFileSnapshot(
      corpus("backend-tools-list.txt"),
    );
  });

  it("the Responses backend: its prompt and its per-delegation message", async () => {
    await expect(backendPrompt({ app: "an earthquake catalog" })).toMatchFileSnapshot(
      corpus("backend-prompt.txt"),
    );
    await expect(requestMessage(request, 8)).toMatchFileSnapshot(corpus("request-message.txt"));
  });

  it("the Claude backend: its brief and its delegation message", async () => {
    await expect(CLAUDE_LIVE_BRIEF).toMatchFileSnapshot(corpus("claude-live-brief.txt"));
    const message = delegationMessage(request, 10);
    expect(message.tools.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(message.text).toMatchFileSnapshot(corpus("claude-delegation-message.txt"));
  });
});
