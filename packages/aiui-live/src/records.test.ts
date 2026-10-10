/**
 * records.test.ts — the prompts as RECORDS: the compositions rehydrate to
 * the strings the corpus pins, the request's facts are recorded Case
 * decisions, the `<delegation>` element escapes once, and the connect
 * adapter re-derives a config from recorded inputs alone.
 */
import { type CompiledPrompt, rehydrate } from "@habemus-papadum/aiui-prompts";
import {
  consumerOperation,
  lowerOperation,
  serializeOperation,
} from "@habemus-papadum/aiui-prompts/operations";
import { renderPrompt } from "@habemus-papadum/aiui-viz/tool-brief";
import { describe, expect, it } from "vitest";
import {
  LIVE_CONNECT_BINDINGS,
  LIVE_SESSION_ADAPTER,
  LIVE_SESSION_ADAPTER_IDENTITY,
  seedMessages,
} from "./adapter";
import {
  delegationMessage,
  delegationMessageValue,
  REQUEST_NOT_YET_TRANSCRIBED,
  requestContext,
  requestMessage,
  requestMessageValue,
} from "./delegators/messages";
import {
  backendPrompt,
  backendPromptValue,
  backendToolsFromTools,
  backendToolsList,
  livePrompt,
  livePromptValue,
} from "./prompt";
import { reseedPrefaceValue, seedValue } from "./session";
import type { DelegationRequest, LiveTool } from "./types";

/** Every text part joined — what a wire carries. */
const textOf = (compiled: CompiledPrompt): string =>
  compiled.parts.map((part) => (part.type === "text" ? part.text : "")).join("");

const tools: LiveTool[] = [
  {
    name: "report",
    description: "One bounded snapshot. Call it first.",
    kind: "read",
    parameters: { type: "object", properties: { format: { type: "string" } } },
    execute: async () => ({}),
  },
];
const request = (text: string, extra: Partial<DelegationRequest> = {}): DelegationRequest => ({
  id: "d_1",
  text,
  transcript: {
    user: [{ text: "hello <there> & co", startMs: 0, endMs: 500, t: 0, tEnd: 0 }],
    assistant: [],
  },
  tools,
  brief: "A lab.",
  signal: new AbortController().signal,
  say: async () => {},
  note: async () => {},
  steer: async () => {},
  log: () => {},
  ...extra,
});

describe("the prompts as records", () => {
  it("the session instructions rehydrate from their record, slot by slot", () => {
    const slots = { app: "A wave app.", stance: "Be terse.", extra: "No lists." };
    const rendered = renderPrompt(
      livePromptValue(slots, { backendToolsList: backendToolsList(tools, "A lab. More.") }),
    );
    expect(rendered.text).toBe(
      livePrompt(slots, { backendToolsList: backendToolsList(tools, "A lab. More.") }),
    );
    expect(rendered.text).toContain(
      "Backend tools:\n- App: A lab.\n- report: One bounded snapshot.",
    );
    expect(textOf(rehydrate(JSON.parse(JSON.stringify(rendered.record))))).toBe(rendered.text);
    const keys = rendered.compiled.occurrences.map((o) => o.key).filter(Boolean);
    expect(keys).toEqual(
      expect.arrayContaining([
        "persona",
        "app",
        "stance",
        "backchannel",
        "interruption",
        "delegation",
        "extra",
      ]),
    );
    // The capability list is the toolkit's projection of the tool snapshot.
    expect(rendered.compiled.contributions.some((c) => c.origin?.kind === "tool-projection")).toBe(
      true,
    );
    expect(backendToolsFromTools(tools, "A lab. More.")).toBe(
      "- App: A lab.\n- report: One bounded snapshot.",
    );
  });

  it("the backend prompt keeps its `##` headings as authored lines", () => {
    const rendered = renderPrompt(backendPromptValue({ app: "a lab" }));
    expect(rendered.text).toBe(backendPrompt({ app: "a lab" }));
    expect(rendered.text.startsWith("## Voice conversation context\n")).toBe(true);
    expect(rendered.compiled.occurrences.map((o) => o.key)).toEqual(
      expect.arrayContaining(["context", "task", "return"]),
    );
  });

  it("the request message's facts are recorded Case decisions", () => {
    const empty = request("");
    const context = requestContext(empty, 8);
    expect(context).toEqual({
      request: { id: "d_1", empty: true, contextUtterances: 8, utterances: { total: 1, shown: 1 } },
    });
    const rendered = renderPrompt(requestMessageValue(empty, 8), { context });
    expect(rendered.text).toBe(requestMessage(empty, 8));
    expect(rendered.text).toContain(`Request (delegation d_1): ${REQUEST_NOT_YET_TRANSCRIBED}`);
    expect(rendered.record.decisions).toContainEqual(
      expect.objectContaining({ kind: "case", name: "request-text", selected: "0" }),
    );
    // No recent conversation: the block is a recorded omission, not a missing branch.
    const bare = request("set it", { transcript: { user: [], assistant: [] } });
    const lone = renderPrompt(requestMessageValue(bare, 8), {
      context: requestContext(bare, 8),
    });
    expect(lone.text).toBe("Request (delegation d_1): set it");
    expect(lone.record.decisions).toContainEqual(
      expect.objectContaining({ kind: "case", name: "recent-context", selected: "0" }),
    );
  });

  it("the <delegation> element escapes its text once, and says (none) without tools", () => {
    const message = delegationMessage(request("set <x> to 5 & 6"));
    expect(message.text).toContain("user: hello &lt;there&gt; &amp; co");
    expect(message.text).toContain("Request (delegation d_1): set &lt;x&gt; to 5 &amp; 6");
    expect(message.text).toContain("- report(format?)");
    expect(message.text.startsWith('<delegation id="d_1">\n')).toBe(true);
    expect(message.text.endsWith("\n</delegation>")).toBe(true);
    expect(textOf(rehydrate(message.record))).toBe(message.text);
    const none = delegationMessage(request("hi", { tools: [], brief: undefined }));
    expect(none.text).toContain("App tools available through app_call:\n(none)\n</delegation>");
    expect(none.record.decisions).toContainEqual(
      expect.objectContaining({ kind: "case", name: "tools", selected: "0" }),
    );
    expect(none.record.decisions).toContainEqual(
      expect.objectContaining({ kind: "case", name: "tool-arguments", selected: "0" }),
    );
    // The value alone, under a count that says tools exist, renders the brief.
    const value = delegationMessageValue(request("hi"), 10, message.tools);
    expect(
      renderPrompt(value, {
        context: { ...requestContext(request("hi"), 10), tools: { count: 1 } },
      }).text,
    ).toContain("Read tools (call freely");
  });

  it("the connect adapter derives the whole config from recorded inputs, and only those", () => {
    const instructions = renderPrompt(livePromptValue({ app: "A wave app." }));
    const backend = renderPrompt(backendPromptValue({ app: "a wave app" }));
    const seeded = renderPrompt(reseedPrefaceValue(), {
      context: { session: { reseed: true } },
    });
    // The seed: the last transcript as a record under a token-budget tail
    // elision; its messages derive through the maps, in order, with roles.
    const seed = renderPrompt(
      seedValue([
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
      ]),
      { context: { session: { reseed: true } } },
    );
    const operation = consumerOperation({
      adapter: LIVE_SESSION_ADAPTER_IDENTITY,
      action: "connect",
      bindings: [
        { key: LIVE_CONNECT_BINDINGS.instructions, content: instructions.record },
        { key: LIVE_CONNECT_BINDINGS.backendInstructions, content: backend.record },
        { key: LIVE_CONNECT_BINDINGS.reseedPreface, content: seeded.record },
        { key: LIVE_CONNECT_BINDINGS.seed, content: seed.record },
      ],
      params: {
        model: "gpt-live-1",
        audio: { output: { voice: "marin" } },
        delegation: { type: "responses", responses: { model: "m" } },
        backendTools: [{ type: "function", name: "report", description: "d", parameters: {} }],
      },
    });
    const prepared = lowerOperation(
      JSON.parse(serializeOperation(operation)),
      { kind: "custom", adapter: LIVE_SESSION_ADAPTER_IDENTITY, options: {} },
      {},
      [LIVE_SESSION_ADAPTER],
    );
    expect(prepared.payload).toEqual({
      model: "gpt-live-1",
      instructions: instructions.text,
      audio: { output: { voice: "marin" } },
      delegation: {
        type: "responses",
        responses: {
          model: "m",
          tools: [{ type: "function", name: "report", description: "d", parameters: {} }],
          instructions: backend.text,
        },
      },
      input: [
        { role: "developer", content: [{ type: "input_text", text: seeded.text }] },
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
      ],
    });
    expect(prepared.mappings.map((m) => [m.binding, m.path.join(".")])).toEqual([
      ["instructions", "instructions"],
      ["backend-instructions", "delegation.responses.instructions"],
      ["reseed-preface", "input.0.content.0.text"],
      ["seed", "input.1.content.0.text"],
      ["seed", "input.2.content.0.text"],
    ]);
    expect(prepared.decisions[0]).toMatchObject({
      kind: "live-session/connect",
      hostedTools: 1,
      seedMessages: 3,
      seed: expect.objectContaining({ unit: "tokens", keep: "last", original: 2, omitted: 0 }),
    });
    expect(seedMessages(seed.compiled)).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
    ]);
    // Not re-seeding: the preface compiles to nothing and no developer message appears.
    const plain = consumerOperation({
      adapter: LIVE_SESSION_ADAPTER_IDENTITY,
      action: "connect",
      bindings: [
        { key: LIVE_CONNECT_BINDINGS.instructions, content: instructions.record },
        {
          key: LIVE_CONNECT_BINDINGS.reseedPreface,
          content: renderPrompt(reseedPrefaceValue()).record,
        },
      ],
      params: { model: "gpt-live-1", audio: {}, delegation: { type: "client" } },
    });
    const lowered = lowerOperation(
      plain,
      { kind: "custom", adapter: LIVE_SESSION_ADAPTER_IDENTITY, options: {} },
      {},
      [LIVE_SESSION_ADAPTER],
    );
    expect(lowered.payload).toEqual({
      model: "gpt-live-1",
      instructions: instructions.text,
      audio: {},
      delegation: { type: "client" },
    });
    expect(lowered.mappings).toHaveLength(1);
  });
});
