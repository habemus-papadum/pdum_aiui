/**
 * chunks.test.ts — the partition primitive: cuts at boundaries in preference
 * order within a budget, never inside an atomic scope, nothing omitted; the
 * decision that records it; `chunksOf` as the slices a capped transport
 * delivers; and a session operation per chunk over the one record.
 */
import { describe, expect, it } from "vitest";
import { type ChunkSlice, chunksOf, compilePrompt, rehydrate } from "./compile.ts";
import { Chunk, Elide, Image, Join, Prompt, PromptError, Math as TeX, Text, Xml } from "./model.ts";
import { captureWire, lowerOperation, sessionOperation, verifyWire } from "./operations.ts";
import { snapshot } from "./record.ts";
import { CONSERVATIVE_ESTIMATOR, type TokenEstimator } from "./tokens.ts";

const textOf = (slice: ChunkSlice | { parts: readonly { type: string; text?: string }[] }) =>
  slice.parts.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
const code = (run: () => unknown, expected: string) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).diagnostic.code).toBe(expected);
    return;
  }
  throw new Error(`expected ${expected}`);
};
const decisionOf = (compiled: { decisions: readonly { kind: string; detail?: unknown }[] }) =>
  compiled.decisions.find((decision) => decision.kind === "chunk");

const paragraphs = [
  "First paragraph. It has two sentences.",
  "Second paragraph, one sentence that runs a little longer than the first.",
  "Third paragraph. Short.",
].join("\n\n");

describe("the partition", () => {
  it("leaves short content whole, recording one chunk and no cuts", () => {
    const compiled = compilePrompt(Chunk({ unit: "characters", limit: 1000, children: ["ab cd"] }));
    expect(textOf(compiled)).toBe("ab cd");
    expect(compiled.cuts).toEqual([]);
    expect(decisionOf(compiled)).toMatchObject({
      selected: "1",
      detail: { unit: "characters", limit: 1000, count: 1, cuts: [], sizes: [5] },
    });
    expect(chunksOf(compiled)).toEqual([
      {
        index: 0,
        count: 1,
        parts: [{ part: "p0", type: "text", text: "ab cd", start: 0, end: 5 }],
      },
    ]);
  });

  it("cuts at the strongest boundary in the window, and the chunks concatenate to the original", () => {
    const compiled = compilePrompt(
      Chunk({ unit: "characters", limit: 80, children: [paragraphs] }),
    );
    expect(textOf(compiled)).toBe(paragraphs);
    const slices = chunksOf(compiled);
    expect(slices.map(textOf).join("")).toBe(paragraphs);
    expect(slices.map(textOf)).toEqual([
      "First paragraph. It has two sentences.\n\n",
      "Second paragraph, one sentence that runs a little longer than the first.\n\n",
      "Third paragraph. Short.",
    ]);
    expect(compiled.cuts.map((cut) => cut.boundary)).toEqual(["paragraph", "paragraph"]);
    expect(decisionOf(compiled)).toMatchObject({
      selected: "3",
      detail: {
        count: 3,
        cuts: [
          { at: 40, boundary: "paragraph" },
          { at: 114, boundary: "paragraph" },
        ],
      },
    });
    for (const size of (decisionOf(compiled)?.detail as { sizes: number[] }).sizes)
      expect(size).toBeLessThanOrEqual(80);
  });

  it("falls back to sentence, then word, then a hard cut as the window demands", () => {
    const sentences = "One two three. Four five six! Seven eight nine? Ten.";
    const bySentence = chunksOf(
      compilePrompt(Chunk({ unit: "characters", limit: 20, children: [sentences] })),
    );
    expect(bySentence.map(textOf)).toEqual([
      "One two three. ",
      "Four five six! ",
      "Seven eight nine? ",
      "Ten.",
    ]);
    const byWord = chunksOf(
      compilePrompt(Chunk({ unit: "characters", limit: 12, children: ["alpha beta gamma delta"] })),
    );
    expect(byWord.map(textOf)).toEqual(["alpha beta ", "gamma delta"]);
    const hard = compilePrompt(Chunk({ unit: "characters", limit: 4, children: ["abcdefghij"] }));
    expect(chunksOf(hard).map(textOf)).toEqual(["abcd", "efgh", "ij"]);
    expect(hard.cuts.every((cut) => cut.boundary === "character")).toBe(true);
    // Without a character boundary an unbreakable run is an overflow, not a guess.
    code(
      () =>
        compilePrompt(
          Chunk({
            unit: "characters",
            limit: 4,
            boundaries: ["word"],
            children: ["abcdefghij"],
          }),
        ),
      "CHUNK_OVERFLOW",
    );
    // A surrogate pair is never split.
    const emoji = chunksOf(
      compilePrompt(Chunk({ unit: "characters", limit: 1, children: ["a😀b"] })),
    );
    expect(emoji.map(textOf)).toEqual(["a", "😀", "b"]);
  });

  it("budgets tokens under the estimator and names it; a host estimator changes the cut", () => {
    const line = "The wave looks jagged because the renderer samples a fixed grid. ";
    const record = snapshot(Chunk({ unit: "tokens", limit: 40, children: [line.repeat(6)] }));
    const compiled = rehydrate(record);
    const detail = decisionOf(compiled)?.detail as {
      estimator: unknown;
      sizes: number[];
      count: number;
    };
    expect(detail.estimator).toEqual(CONSERVATIVE_ESTIMATOR.identity);
    expect(detail.count).toBeGreaterThan(1);
    for (const slice of chunksOf(compiled))
      expect(CONSERVATIVE_ESTIMATOR.text(textOf(slice))).toBeLessThanOrEqual(40);
    expect(chunksOf(compiled).map(textOf).join("")).toBe(line.repeat(6));
    const words: TokenEstimator = {
      identity: { name: "test/words", version: "1" },
      text: (text) => text.split(/\s+/).filter(Boolean).length,
      image: () => 1,
    };
    const wide = rehydrate(record, { estimator: words });
    expect(decisionOf(wide)?.detail).toMatchObject({ estimator: words.identity, count: 2 });
  });

  it("never cuts inside a math or XML scope, and refuses a scope wider than the budget", () => {
    const compiled = compilePrompt(
      Chunk({
        unit: "characters",
        limit: 12,
        children: ["see ", TeX({ mode: "inline", value: "a+b=c" }), " and ", "then more"],
      }),
    );
    const slices = chunksOf(compiled).map(textOf);
    expect(slices.join("")).toBe("see $a+b=c$ and then more");
    expect(slices.some((slice) => slice.includes("$a+b=c$"))).toBe(true);
    for (const slice of slices) expect((slice.match(/\$/g) ?? []).length % 2).toBe(0);
    code(
      () =>
        compilePrompt(
          Chunk({
            unit: "characters",
            limit: 4,
            children: [
              Xml({ tag: "tab", attributes: { url: "/x" }, children: ["long body here"] }),
            ],
          }),
        ),
      "ATOMIC_CHUNK",
    );
  });

  it("treats an image as atomic and places it whole in a chunk", () => {
    const small = { id: "i", width: 64, height: 64 };
    // 255 tokens for the icon under the default estimator: with a budget of
    // 256 it shares a chunk with nothing, and stands alone between the texts.
    const compiled = compilePrompt(
      Chunk({
        unit: "tokens",
        limit: 256,
        children: ["before ", Image({ asset: small }), " after the picture"],
      }),
    );
    const slices = chunksOf(compiled);
    expect(slices.length).toBe(3);
    expect(slices[0].parts).toEqual([
      { part: "p0", type: "text", text: "before ", start: 0, end: 7 },
    ]);
    expect(slices[1].parts).toEqual([{ part: "p1", type: "image", asset: small }]);
    expect(slices[2].parts).toEqual([
      { part: "p2", type: "text", text: " after the picture", start: 0, end: 18 },
    ]);
    expect(compiled.cuts).toEqual([
      { occurrence: "o", index: 1, boundary: "image", at: { part: "p1", offset: 0 } },
      { occurrence: "o", index: 2, boundary: "image", at: { part: "p2", offset: 0 } },
    ]);
    // A roomier budget lets the icon ride with the text before it.
    expect(
      chunksOf(
        compilePrompt(
          Chunk({
            unit: "tokens",
            limit: 300,
            children: ["before ", Image({ asset: small }), " after the picture"],
          }),
        ),
      ).length,
    ).toBe(1);
    code(
      () =>
        compilePrompt(
          Chunk({ unit: "tokens", limit: 10, children: ["x", Image({ asset: small }), "y"] }),
        ),
      "ATOMIC_CHUNK",
    );
  });

  it("prefixes the marker to every chunk after the first and counts it in the budget", () => {
    const compiled = compilePrompt(
      Chunk({
        unit: "characters",
        limit: 16,
        marker: "(cont.) ",
        children: ["one two three four"],
      }),
    );
    const slices = chunksOf(compiled).map(textOf);
    expect(slices).toEqual(["one two three ", "(cont.) four"]);
    expect(compiled.contributions.filter((c) => c.relation === "generated").length).toBe(1);
    expect(decisionOf(compiled)?.detail).toMatchObject({ sizes: [14, 12] });
    code(
      () =>
        compilePrompt(
          Chunk({ unit: "characters", limit: 3, marker: "abcd", children: ["one two"] }),
        ),
      "CHUNK_OVERFLOW",
    );
  });

  it("refuses a chunk beside other content, two chunks, or a chunk inside a text elision", () => {
    code(
      () =>
        chunksOf(
          compilePrompt(
            Prompt({
              children: ["Heading", Chunk({ unit: "characters", limit: 5, children: ["abc"] })],
            }),
          ),
        ),
      "CHUNK_SIBLINGS",
    );
    code(
      () =>
        chunksOf(
          compilePrompt(
            Join({
              separator: "",
              children: [
                Chunk({ unit: "characters", limit: 5, children: ["a"] }),
                Chunk({ unit: "characters", limit: 5, children: ["b"] }),
              ],
            }),
          ),
        ),
      "CHUNK_MULTIPLE",
    );
    code(
      () =>
        compilePrompt(
          Elide({
            unit: "characters",
            limit: 3,
            children: [Chunk({ unit: "characters", limit: 2, children: ["abcdef"] })],
          }),
        ),
      "CHUNK_ELISION",
    );
    code(
      () =>
        compilePrompt(
          Chunk({
            unit: "characters",
            limit: 5,
            children: [Chunk({ unit: "characters", limit: 2, children: ["abc"] })],
          }),
        ),
      "CHUNK_NESTED",
    );
    // No chunk at all is one slice, so a host can always ask.
    expect(chunksOf(compilePrompt("plain")).map(textOf)).toEqual(["plain"]);
  });
});

describe("a session operation per chunk over one record", () => {
  const record = snapshot(
    Chunk({ unit: "characters", limit: 20, children: ["One two three. Four five six! Seven."] }),
  );
  const count = chunksOf(rehydrate(record)).length;

  it("lowers each chunk as its own append, mapped as a slice, verifying one wire each", () => {
    expect(count).toBe(3);
    const texts: string[] = [];
    for (let index = 0; index < count; index++) {
      const operation = sessionOperation(record, {
        action: "append-commentary",
        sessionId: "s",
        eventId: `e${index}`,
        delegationId: "d",
        chunk: { index, count },
      });
      const prepared = lowerOperation(operation, { kind: "live-session/1" });
      const payload = prepared.payload as { content: string; type: string };
      expect(payload.type).toBe("session.commentary.append");
      texts.push(payload.content);
      expect(prepared.mappings).toEqual([
        expect.objectContaining({
          path: ["content"],
          relation: "slice",
          part: "p0",
          start: 0,
          end: payload.content.length,
          source: expect.objectContaining({ start: expect.any(Number) }),
        }),
      ]);
      expect(prepared.decisions).toContainEqual({
        kind: "chunk",
        record: record.fingerprint,
        index,
        count,
      });
      const wire = captureWire(prepared, prepared.payload, { capturedAt: "2026-10-10T00:00:00Z" });
      expect(verifyWire(operation, wire).equal).toBe(true);
      // Every chunk's operation binds the whole record: the shared fingerprint is the link.
      expect(Object.keys(operation.records)).toEqual([record.fingerprint]);
    }
    expect(texts.join("")).toBe("One two three. Four five six! Seven.");
  });

  it("refuses a count the record disagrees with, a chunk on a non-append, and a bad index", () => {
    code(
      () =>
        lowerOperation(
          sessionOperation(record, {
            action: "append-thinking",
            sessionId: "s",
            eventId: "e",
            chunk: { index: 0, count: 2 },
          }),
          { kind: "live-session/1" },
        ),
      "CHUNK_COUNT_MISMATCH",
    );
    code(
      () =>
        sessionOperation(record, {
          action: "respond",
          sessionId: "s",
          eventId: "e",
          chunk: { index: 0, count: 1 },
        }),
      "SESSION_OPERATION",
    );
    code(
      () =>
        sessionOperation(record, {
          action: "append-commentary",
          sessionId: "s",
          eventId: "e",
          chunk: { index: 3, count: 3 },
        }),
      "SESSION_OPERATION",
    );
  });

  it("delivers an unchunked record whole when no reference is given", () => {
    const operation = sessionOperation(record, {
      action: "append-commentary",
      sessionId: "s",
      eventId: "e",
    });
    const payload = lowerOperation(operation, { kind: "live-session/1" }).payload as {
      content: string;
    };
    expect(payload.content).toBe(textOf(rehydrate(record)));
    expect(Text({ value: "x" }).kind).toBe("text");
  });
});
