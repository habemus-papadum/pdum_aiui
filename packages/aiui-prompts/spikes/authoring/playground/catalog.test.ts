import { describe, expect, it } from "vitest";
import { example as originalScience } from "../src/examples/03-scientific.prompt.tsx";
import { example as originalMessages } from "../src/examples/07-current-messages.prompt.tsx";
import { defaults, examples, execute } from "./catalog";

describe("authoring playground uses the real pipeline", () => {
  it("runs all examples into current messages and prepared requests", async () => {
    for (const example of examples) {
      const run = await execute(example.id, defaults);
      expect(run.prepared.current.messages).toEqual(
        run.turn.messages.map(({ role, prompt }) => ({ role, parts: prompt.parts })),
      );
      expect(run.prompts.length).toBeGreaterThan(0);
      expect(run.prepared.status).toBe("prepared-not-sent");
    }
  });
  it("executes changes to greeting values and content selection", async () => {
    const greeting = await execute("greeting", { ...defaults, name: "Grace <&>", concise: false });
    expect(greeting.prompts[0].compiled.parts).toEqual([
      { type: "text", text: "Hello, Grace <&>!" },
    ]);
    const full = await execute("reuse", defaults);
    const omitted = await execute("reuse", { ...defaults, background: "omit" });
    expect(JSON.stringify(full.prepared)).toContain("# Background");
    expect(JSON.stringify(omitted.prepared)).not.toContain("# Background");
  });
  it("preserves scientific output and text-image-text exactly", async () => {
    const run = await execute("science", defaults);
    expect(run.prompts[0].compiled).toEqual((await originalScience()).compiled);
    expect(run.prepared.current.messages[0].parts.map((part) => part.type)).toEqual([
      "text",
      "image",
      "text",
    ]);
  });
  it("leaves every history form fixed while current content is shortened", async () => {
    for (const history of ["none", "messages", "remote", "provider-items"] as const) {
      const full = await execute("history", { ...defaults, history });
      const short = await execute("history", { ...defaults, history, background: "omit" });
      expect(short.prepared.history).toEqual(full.prepared.history);
      expect(short.prepared.current).not.toEqual(full.prepared.current);
      if (history === "remote")
        expect(short.prepared.accounting.history).toBe("unknown-server-state");
    }
  });
  it("retains instructions and authored message ordering", async () => {
    const run = await execute("messages", defaults);
    expect(run.prepared).toEqual(originalMessages().prepared);
    expect(run.prompts.map((prompt) => prompt.label)).toEqual([
      "Instructions",
      "Message 1 · user",
      "Message 2 · assistant",
      "Message 3 · user",
    ]);
  });
});
