/**
 * profiles.test.ts — the utility profiles' newer shapes: a Realtime session
 * update with the host's own block, the baked connect config, the Responses
 * request fields, token estimation, and the tail elision a transcript wants.
 */
import { describe, expect, it } from "vitest";
import { compilePrompt, rehydrate } from "./compile.ts";
import { Elide, Image, Join, Prompt, PromptError, Text } from "./model.ts";
import {
  captureWire,
  lowerOperation,
  parseOperation,
  responseOperation,
  serializeOperation,
  sessionOperation,
  verifyWire,
} from "./operations.ts";
import { snapshot } from "./record.ts";
import { CONSERVATIVE_ESTIMATOR, estimateParts, type TokenEstimator } from "./tokens.ts";
import { toolSnapshot } from "./tools-data.ts";

const realtime = { kind: "openai-realtime/1" } as const;
/** The one text part's text — these prompts have no images. */
const textOf = (compiled: { parts: readonly { type: string; text?: string }[] }): string =>
  compiled.parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
const block = {
  audio: { input: { turn_detection: { type: "server_vad" } } },
  tools: [{ type: "function", name: "set_freq", description: "Set it.", parameters: {} }],
  max_output_tokens: 400,
};

describe("the Realtime profile: update and connect carry the host's session block", () => {
  it("lowers an update with the bound instructions merged into the host's block", () => {
    const content = snapshot("Be brief.");
    const operation = sessionOperation(content, {
      action: "update",
      sessionId: "s1",
      eventId: "evt_3",
      session: block,
    });
    const prepared = lowerOperation(operation, realtime);
    expect(prepared.payload).toEqual({
      type: "session.update",
      event_id: "evt_3",
      session: { type: "realtime", ...block, instructions: "Be brief." },
    });
    expect(prepared.mappings).toEqual([
      expect.objectContaining({ path: ["session", "instructions"], relation: "copy" }),
    ]);
    const wire = captureWire(prepared, prepared.payload, { capturedAt: "2026-10-10T00:00:00Z" });
    expect(verifyWire(parseOperation(serializeOperation(operation)), wire).equal).toBe(true);
  });

  it("lowers a tools-only update with no record bound, and the baked config with no envelope", () => {
    const toolsOnly = sessionOperation(null, {
      action: "update",
      sessionId: "s1",
      eventId: "evt_4",
      session: { tools: block.tools },
    });
    expect(lowerOperation(toolsOnly, realtime).payload).toEqual({
      type: "session.update",
      event_id: "evt_4",
      session: { type: "realtime", tools: block.tools },
    });
    const baked = sessionOperation(snapshot("Be brief."), {
      action: "connect",
      sessionId: "start:1",
      session: { ...block, model: "gpt-realtime", audio: { output: { voice: "cedar" } } },
    });
    const prepared = lowerOperation(baked, realtime);
    expect(prepared.payload).toEqual({
      type: "realtime",
      ...block,
      model: "gpt-realtime",
      audio: { output: { voice: "cedar" } },
      instructions: "Be brief.",
    });
    expect(prepared.mappings[0]?.path).toEqual(["instructions"]);
  });

  it("refuses instructions smuggled in the block, an event without an id, and a bare append", () => {
    const content = snapshot("x");
    expect(() =>
      sessionOperation(content, {
        action: "update",
        sessionId: "s",
        eventId: "e",
        session: { instructions: "by hand" },
      }),
    ).toThrow(/never in the session block/);
    expect(() => sessionOperation(content, { action: "update", sessionId: "s" })).toThrow(
      /eventId/,
    );
    expect(() =>
      sessionOperation(null, { action: "append-commentary", sessionId: "s", eventId: "e" }),
    ).toThrow(/binds a semantic record/);
    expect(() =>
      sessionOperation(content, { action: "respond", sessionId: "s", eventId: "e", session: {} }),
    ).toThrow(/Only update and connect/);
    const update = sessionOperation(content, { action: "update", sessionId: "s", eventId: "e" });
    expect(() => lowerOperation(update, { kind: "live-session/1" })).toThrow(/append-only/);
  });
});

describe("the Responses profile: tool_choice, reasoning and store ride the request", () => {
  it("emits the fields when given and nothing when not", () => {
    const tools = toolSnapshot([
      { ns: "app", tools: [{ name: "add", description: "Add.", inputSchema: { type: "object" } }] },
    ]);
    const base = {
      instructions: snapshot("Help."),
      input: snapshot("What is 1 + 1?"),
      tools,
    };
    const plain = lowerOperation(responseOperation(base), {
      kind: "openai-responses/1",
      model: "m",
    }).payload as Record<string, unknown>;
    expect(plain).not.toHaveProperty("tool_choice");
    expect(plain).not.toHaveProperty("reasoning");
    expect(plain).not.toHaveProperty("store");
    const full = lowerOperation(
      responseOperation({
        ...base,
        toolChoice: "auto",
        reasoning: { effort: "low" },
        store: false,
      }),
      { kind: "openai-responses/1", model: "m" },
    ).payload as Record<string, unknown>;
    expect(full).toMatchObject({ tool_choice: "auto", reasoning: { effort: "low" }, store: false });
    expect(() => responseOperation({ ...base, store: "no" as never })).toThrow(/boolean/);
  });
});

describe("token estimation", () => {
  it("the conservative default counts text at 3.5 characters a token and images by size", () => {
    expect(CONSERVATIVE_ESTIMATOR.text("")).toBe(0);
    expect(CONSERVATIVE_ESTIMATOR.text("a".repeat(35))).toBe(10);
    // Unknown size counts as 1024²: scaled to 768², four tiles — the pixel
    // rule (787) edges out the tile rule (765).
    expect(CONSERVATIVE_ESTIMATOR.image({ id: "a" })).toBe(787);
    // A small icon: one tile under both rules.
    expect(CONSERVATIVE_ESTIMATOR.image({ id: "b", width: 64, height: 64 })).toBe(255);
    // A huge photo is scaled down first, so it does not explode.
    expect(CONSERVATIVE_ESTIMATOR.image({ id: "c", width: 4000, height: 3000 })).toBeLessThan(2000);
    const compiled = compilePrompt(
      Prompt({ children: [Text({ value: "a".repeat(70) }), Image({ asset: { id: "a" } })] }),
    );
    // The Prompt's blank-line separator rides in the text part: 72 characters, 21 tokens.
    expect(estimateParts(compiled.parts)).toBe(21 + 787);
    const custom: TokenEstimator = {
      identity: { name: "test/words", version: "1" },
      text: (text) => text.split(/\s+/).filter(Boolean).length,
      image: () => 1,
    };
    expect(estimateParts(compiled.parts, custom)).toBe(2);
  });
});

describe("elision: keep the last, and budget whole children by tokens", () => {
  const lines = ["user: one", "assistant: two", "user: three", "assistant: four"];
  const transcript = (unit: "items" | "tokens", limit: number, keep: "first" | "last") =>
    Elide({
      unit,
      limit,
      keep,
      marker: "[…]",
      children: lines.map((line, i) => Text({ value: `${i ? "\n" : ""}${line}` })),
    });

  it("keeps the last N items with the marker before them, and records the side kept", () => {
    const compiled = compilePrompt(transcript("items", 2, "last"));
    expect(textOf(compiled)).toBe("[…]\nuser: three\nassistant: four");
    expect(compiled.decisions[0]).toMatchObject({
      kind: "elide",
      selected: "clipped",
      detail: { unit: "items", limit: 2, keep: "last", original: 4, omitted: 2 },
    });
    expect(textOf(compilePrompt(transcript("items", 2, "first")))).toBe(
      "user: one\nassistant: two[…]",
    );
  });

  it("keeps whole children from the end while they fit a token budget, naming the estimator", () => {
    // The last two lines cost 5 + 4 tokens under the default; a budget of 9 keeps exactly them.
    const record = snapshot(transcript("tokens", 9, "last"));
    const compiled = rehydrate(record);
    expect(textOf(compiled)).toBe("[…]\nuser: three\nassistant: four");
    expect(compiled.decisions[0]).toMatchObject({
      kind: "elide",
      detail: {
        unit: "tokens",
        limit: 9,
        keep: "last",
        estimator: { name: "aiui-prompts/conservative", version: "1" },
        original: 4,
        omitted: 2,
        tokens: { kept: expect.any(Number), original: expect.any(Number) },
      },
    });
    // A host estimator changes the cut and is named in the decision.
    const words: TokenEstimator = {
      identity: { name: "test/words", version: "1" },
      text: (text) => text.split(/\s+/).filter(Boolean).length,
      image: () => 1,
    };
    const wide = rehydrate(record, { estimator: words });
    expect(textOf(wide)).toBe(lines.join("\n"));
    expect(wide.decisions[0]?.detail?.estimator).toEqual(words.identity);
    // Nothing fits: everything is omitted, only the marker remains.
    expect(textOf(compilePrompt(transcript("tokens", 1, "last")))).toBe("[…]");
  });

  it("keeps the last characters or lines, clipping text at the window and never a scope", () => {
    const tail = compilePrompt(
      Elide({ unit: "characters", limit: 5, keep: "last", marker: "…", children: ["abcdefgh"] }),
    );
    expect(textOf(tail)).toBe("…defgh");
    const head = compilePrompt(
      Elide({ unit: "characters", limit: 5, keep: "first", marker: "…", children: ["abcdefgh"] }),
    );
    expect(textOf(head)).toBe("abcde…");
    const lastLines = compilePrompt(
      Elide({
        unit: "lines",
        limit: 2,
        keep: "last",
        marker: "…",
        children: [Join({ separator: "\n", children: ["l1", "l2", "l3"] })],
      }),
    );
    expect(textOf(lastLines)).toBe("…l2\nl3");
    // A math scope straddling the cut is refused, whichever end is kept.
    const math = Elide({
      unit: "characters",
      limit: 4,
      keep: "last",
      marker: "…",
      children: [Text({ value: "ab" }), Join({ separator: "", children: ["$x$"] })],
    });
    expect(textOf(compilePrompt(math))).toBe("…b$x$");
    expect(() =>
      compilePrompt(
        Elide({
          unit: "characters",
          limit: 2,
          keep: "last",
          marker: "…",
          children: [Text({ value: "ab" }), Join({ separator: "", children: ["cd"] })],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      rehydrate(
        snapshot({
          kind: "elide",
          unit: "characters",
          limit: 2,
          marker: "…",
          keep: "last",
          children: [Text({ value: "ab" }), { kind: "math", mode: "inline", children: ["xyz"] }],
        } as never),
      ),
    ).toThrow(PromptError);
  });
});
