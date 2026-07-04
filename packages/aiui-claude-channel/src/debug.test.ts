import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectChannelClient } from "./client";
import type { LaunchInfo } from "./launch-info";
import { createTraceStore } from "./trace";
import { startWebServer, type WebServer } from "./web";

/**
 * End-to-end over a real server: a ws thread records a trace in the project
 * cache, and the /debug API + viewer serve it back.
 */
describe("web backend with traceDir", () => {
  let server: WebServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function startTraced(extra: { launchInfo?: LaunchInfo } = {}) {
    const cache = mkdtempSync(join(tmpdir(), "aiui-debug-"));
    const prompts: string[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
      traceDir: cache,
      ...extra,
    });
    return { cache, prompts, port: server.port };
  }

  it("traces a ws round-trip and serves it over the debug API", async () => {
    const { prompts, port } = await startTraced();

    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${port}/ws`,
      format: "text-concat",
    });
    const thread = client.openThread("thread-42");
    await thread.send({ text: "traced " });
    const ack = await thread.finish({ text: "prompt" });
    await client.close();
    expect(ack).toMatchObject({ ok: true, closed: true });
    expect(prompts).toEqual(["traced prompt"]);

    const list = (await (await fetch(`http://127.0.0.1:${port}/debug/api/traces`)).json()) as {
      traces: Array<{ id: string; format: string; threadId: string; status?: string }>;
    };
    expect(list.traces).toHaveLength(1);
    const [summary] = list.traces;
    expect(summary).toMatchObject({
      format: "text-concat",
      threadId: "thread-42",
      status: "completed",
    });

    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/debug/api/traces/${summary.id}`)
    ).json()) as { stages: Array<{ kind: string; data?: unknown }> };
    expect(detail.stages.map((s) => s.kind)).toEqual(["input", "input", "output"]);
    expect(detail.stages[2].data).toBe("traced prompt");
  });

  it("serves the viewer app and blobs, and 404s missing traces", async () => {
    const { cache, port } = await startTraced();

    const page = await fetch(`http://127.0.0.1:${port}/debug`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("lowering traces");

    const missing = await fetch(`http://127.0.0.1:${port}/debug/api/traces/nope`);
    expect(missing.status).toBe(404);

    // A blob written through the store comes back with an image content-type.
    const trace = createTraceStore(cache).begin("shots", "t");
    trace.recordBlob({ kind: "input", label: "shot" }, new Uint8Array([1, 2, 3]), "shot.png");
    const blob = await fetch(`http://127.0.0.1:${port}/debug/blob/${trace.id}/shot.png`);
    expect(blob.status).toBe(200);
    expect(blob.headers.get("content-type")).toContain("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const traversal = await fetch(`http://127.0.0.1:${port}/debug/blob/${trace.id}/..%2Fescape`);
    expect([400, 404]).toContain(traversal.status);
  });

  it("serves this server's own info (no launch key without launch info)", async () => {
    const { port } = await startTraced();

    // info: this test process has no registry entry, so it self-reports as
    // unregistered — deterministic without a live registry.
    const info = (await (await fetch(`http://127.0.0.1:${port}/debug/api/info`)).json()) as {
      registered?: boolean;
      pid?: number;
    };
    expect(info).toEqual({ registered: false, pid: process.pid });
  });

  it("surfaces launch info under `launch`, and serves transport stats", async () => {
    const launchInfo: LaunchInfo = {
      launcher: "aiui claude",
      chromeDevtools: {
        enabled: true,
        connection: "attach",
        browserUrl: "http://127.0.0.1:9222",
        userDataDir: "/proj/.aiui-cache/chrome/default",
      },
    };
    const { port } = await startTraced({ launchInfo });
    const info = (await (await fetch(`http://127.0.0.1:${port}/debug/api/info`)).json()) as {
      launch?: LaunchInfo;
    };
    expect(info.launch).toEqual(launchInfo);

    // stats: a ws round trip shows up in the counters and the recent ring.
    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${port}/ws`,
      format: "text-concat",
    });
    const thread = client.openThread("t-stats");
    await thread.finish({ text: "count me" });
    await client.close();

    const stats = (await (await fetch(`http://127.0.0.1:${port}/debug/api/stats`)).json()) as {
      connections: { total: number; active: number };
      frames: { count: number; bytes: number };
      recent: Array<{ bytes: number; processMs: number; ok: boolean; threadId?: string }>;
    };
    expect(stats.connections.total).toBe(1);
    expect(stats.frames.count).toBe(2); // hello + data
    expect(stats.frames.bytes).toBeGreaterThan(0);
    expect(stats.recent).toHaveLength(2);
    expect(stats.recent[1]).toMatchObject({ ok: true, threadId: "t-stats" });
    expect(stats.recent[1].processMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps /debug and tracing off without a traceDir", async () => {
    const prompts: string[] = [];
    server = await startWebServer({ onPrompt: (t) => prompts.push(t) });
    const res = await fetch(`http://127.0.0.1:${server.port}/debug`);
    expect(res.status).toBe(404);
  });
});
