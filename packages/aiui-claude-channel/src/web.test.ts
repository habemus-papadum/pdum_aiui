import { afterEach, describe, expect, it } from "vitest";
import { startWebServer, type WebServer } from "./web";

describe("startWebServer", () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("serves health, forwards prompts, and rejects empty ones", async () => {
    const received: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        received.push(text);
      },
    });
    expect(server.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, pid: process.pid });

    const ok = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello session" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(received).toEqual(["hello session"]);

    const bad = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it("propagates handler errors as a 500", async () => {
    server = await startWebServer({
      onPrompt: () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "boom" });
  });
});
