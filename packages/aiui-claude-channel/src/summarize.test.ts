import { describe, expect, it, vi } from "vitest";
import { openaiSummarizer, summaryPromptInput } from "./summarize";

describe("summaryPromptInput", () => {
  it("collapses a self-closing screenshot block to [screenshot]", () => {
    const body = 'move this <screenshot path="a/shot_1.png" view="full-viewport"/> a bit left';
    expect(summaryPromptInput(body)).toBe("move this [screenshot] a bit left");
  });

  it("collapses a multi-line paired screenshot block to [screenshot]", () => {
    const body = [
      "make the legend match",
      '<screenshot path="shot_1.png">',
      '  <element name="Legend" source="src/Legend.tsx:30:2"/>',
      "</screenshot>",
      "thanks",
    ].join("\n");
    expect(summaryPromptInput(body)).toBe("make the legend match\n[screenshot]\nthanks");
  });

  it("collapses every screenshot, not just the first", () => {
    const body = "a <screenshot path='1.png'/> b <screenshot path='2.png'/> c";
    expect(summaryPromptInput(body)).toBe("a [screenshot] b [screenshot] c");
  });

  it("truncates to 1000 characters", () => {
    const body = "x".repeat(5000);
    expect(summaryPromptInput(body)).toHaveLength(1000);
  });

  it("leaves screenshot-free bodies untouched", () => {
    expect(summaryPromptInput("just some prose")).toBe("just some prose");
  });
});

describe("openaiSummarizer", () => {
  const ok = (content: string): typeof fetch =>
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    ) as unknown as typeof fetch;

  it("posts one temperature-0 chat completion with the screenshot-stripped body", async () => {
    const fetchSpy = ok("rewrite the beet essay to say vite");
    const summarizer = openaiSummarizer({ apiKey: "sk-test", fetch: fetchSpy });
    const line = await summarizer.summarize(
      'write about beets <screenshot path="shot_1.png"/> please',
    );
    expect(line.text).toBe("rewrite the beet essay to say vite");

    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const sent = JSON.parse((init as RequestInit).body as string) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.model).toBe("gpt-4o-mini");
    expect(sent.temperature).toBe(0);
    expect(sent.messages[0].role).toBe("system");
    // The user turn is the prepared (screenshot-collapsed) body.
    expect(sent.messages[1].content).toBe("write about beets [screenshot] please");
  });

  it("strips a single pair of wrapping quotes the model adds despite instruction", async () => {
    const summarizer = openaiSummarizer({ apiKey: "k", fetch: ok('"tidy the legend layout"') });
    expect((await summarizer.summarize("body")).text).toBe("tidy the legend layout");
  });

  it("throws on a non-ok response so the caller can swallow it", async () => {
    const bad = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    ) as unknown as typeof fetch;
    const summarizer = openaiSummarizer({ apiKey: "k", fetch: bad });
    await expect(summarizer.summarize("body")).rejects.toThrow("bad key");
  });
});
