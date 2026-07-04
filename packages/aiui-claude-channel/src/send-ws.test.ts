import { afterEach, describe, expect, it } from "vitest";
import { sendPromptWs, sendPromptWsByTag } from "./send-ws";
import { startWebServer, type WebServer } from "./web";

describe("sendPromptWs", () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("delivers a prompt over the /ws text-concat protocol", async () => {
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
    });

    const result = await sendPromptWs(server, "What is the capital of England?");
    expect(result).toEqual({ ok: true });
    expect(prompts).toEqual(["What is the capital of England?"]);
  });

  it("reports a hello rejection as a failed result", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const result = await sendPromptWs(server, "hi", { format: "no-such-format" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown format "no-such-format"');
  });

  it("returns a transport error when nothing is listening", async () => {
    // Port 1 is privileged/unused on loopback — the connect fails fast.
    const result = await sendPromptWs({ port: 1 }, "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("sendPromptWsByTag", () => {
  it("throws when no running server has the tag", async () => {
    await expect(
      sendPromptWsByTag("no-such-tag", "hi", "/nonexistent/registry/dir"),
    ).rejects.toThrow(/no running aiui MCP server has tag/);
  });
});
