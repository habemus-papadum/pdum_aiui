import { describe, expect, it } from "vitest";
import { APPEND_TOKEN_LIMIT } from "./protocol";
import { approxTokens, chunkForAppend } from "./tokens";

describe("tokens", () => {
  it("estimates conservatively", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("hello world")).toBe(4);
  });

  it("keeps short text whole", () => {
    expect(chunkForAppend("Done. The frequency is 5 hertz.")).toEqual([
      "Done. The frequency is 5 hertz.",
    ]);
    expect(chunkForAppend("   ")).toEqual([]);
  });

  it("splits long text at sentence ends under the cap", () => {
    const sentence = "The wave looks jagged because the renderer samples a fixed grid. ";
    const long = sentence.repeat(60);
    const chunks = chunkForAppend(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(approxTokens(chunk)).toBeLessThanOrEqual(APPEND_TOKEN_LIMIT * 0.7);
      expect(chunk.endsWith(".")).toBe(true);
    }
    expect(chunks.join(" ")).toBe(long.trim());
  });

  it("hard-splits a single oversize sentence", () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkForAppend(words, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toBe(words);
  });
});
