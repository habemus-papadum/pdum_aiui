import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ChannelResponse } from "./channel";
import { connectChannelClient } from "./client";
import { previewablePath } from "./debug";
import { encodeFrame, PROTOCOL_VERSION } from "./frame";
import type { FrameLogEntry } from "./frame-log";
import { createIntentV1Format } from "./intent-v1";
import type { LaunchInfo } from "./launch-info";
import { TRANSCRIPTION_NOTE } from "./prompt-context";
import { mockSpeaker } from "./speak";
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

  async function startTraced(extra: { launchInfo?: LaunchInfo; tag?: string } = {}) {
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
      traces: Array<{
        id: string;
        format: string;
        threadId: string;
        status?: string;
        stageCount?: number;
        stages?: unknown[];
      }>;
    };
    expect(list.traces).toHaveLength(1);
    const [summary] = list.traces;
    expect(summary).toMatchObject({
      format: "text-concat",
      threadId: "thread-42",
      status: "completed",
    });
    // The list route is slimmed: a stageCount, not the (potentially megabyte)
    // full stages array — those come from the per-trace routes below.
    expect(summary.stageCount).toBe(3);
    expect(summary.stages).toBeUndefined();

    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/debug/api/traces/${summary.id}`)
    ).json()) as { stages: Array<{ kind: string; data?: unknown }> };
    expect(detail.stages.map((s) => s.kind)).toEqual(["input", "input", "output"]);
    expect(detail.stages[2].data).toBe("traced prompt");
  });

  it("reports its session label with the listing and stamps it on new traces", async () => {
    const { cache, port } = await startTraced({ tag: "sess-test" });

    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${port}/ws`,
      format: "text-concat",
    });
    await client.openThread("t-sess").finish({ text: "label me" });
    await client.close();

    // A pre-label manifest (no session), as an older server would have left it.
    const legacy = createTraceStore(cache).begin("text-concat", "t-legacy");
    legacy.end();

    const list = (await (await fetch(`http://127.0.0.1:${port}/debug/api/traces`)).json()) as {
      traces: Array<{ threadId: string; session?: string }>;
      session?: string;
    };
    // The endpoint shape: { traces, session } with the exact label format.
    expect(list.session).toMatch(/^sess-test·\d+·\d{6}$/);
    const byThread = new Map(list.traces.map((t) => [t.threadId, t]));
    expect(byThread.get("t-sess")?.session).toBe(list.session);
    expect(byThread.get("t-legacy")?.session).toBeUndefined();
  });

  it("labels an untagged server's session as channel·…", async () => {
    const { port } = await startTraced();
    const list = (await (await fetch(`http://127.0.0.1:${port}/debug/api/traces`)).json()) as {
      session?: string;
    };
    expect(list.session).toMatch(/^channel·\d+·\d{6}$/);
  });

  it("lists the machine's channels on /debug/api/channels (the switcher's feed)", async () => {
    const { port } = await startTraced();
    const body = (await (await fetch(`http://127.0.0.1:${port}/debug/api/channels`)).json()) as {
      channels?: Array<{ tag: string; port: number; pid: number; cwd: string; self?: boolean }>;
    };
    // This test server never registered itself, so its own row may be absent —
    // the shape is the contract: an array of registry rows, each addressable
    // by port, with `self: true` only ever on the answering process's row.
    expect(Array.isArray(body.channels)).toBe(true);
    for (const entry of body.channels ?? []) {
      expect(typeof entry.tag).toBe("string");
      expect(typeof entry.port).toBe("number");
      expect(typeof entry.cwd).toBe("string");
      if (entry.self) {
        expect(entry.pid).toBe(process.pid);
      }
    }
  });

  it("serves NO page at /debug — a JSON pointer at the viewers — plus blobs; 404s missing traces", async () => {
    const { cache, port } = await startTraced();

    // The channel renders no HTML (the rule): GET /debug answers with where
    // the actual viewers live and which API routes they speak.
    const page = await fetch(`http://127.0.0.1:${port}/debug`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("application/json");
    const pointer = (await page.json()) as { ui?: string; api?: string[] };
    expect(pointer.ui).toContain("aiui debug");
    expect(pointer.api).toContain("/debug/api/traces");

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
      generation?: number;
      session?: string;
    };
    // The reload generation rides along on info (0 before any reload), and so
    // does this server's trace session label — the intent tool's 🔍 reads it
    // here to build its `?session=` deep link (an untagged server labels as
    // `channel·<pid>·<HHMMSS>`).
    expect(info).toMatchObject({ registered: false, pid: process.pid, generation: 0 });
    expect(info.session).toMatch(new RegExp(`^channel·${process.pid}·\\d{6}$`));
    expect(Object.keys(info).sort()).toEqual(["generation", "pid", "registered", "session"]);
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

  it("live-follows a trace by revision, with CORS", async () => {
    const { cache, port } = await startTraced();
    const store = createTraceStore(cache);
    const trace = store.begin("intent-v1", "t-live");
    trace.record({ kind: "input", label: "frame 0", data: [{ at: 1, type: "thread-open" }] });

    const base = `http://127.0.0.1:${port}/debug/api/traces/${trace.id}/live`;
    const res1 = await fetch(base);
    expect(res1.status).toBe(200);
    // The trace viewers (console, intent panel) poll this cross-origin; the /debug CORS header applies.
    expect(res1.headers.get("access-control-allow-origin")).toBe("*");
    const body1 = (await res1.json()) as { rev: number; stages: unknown[] };
    expect(typeof body1.rev).toBe("number");
    expect(body1.stages).toHaveLength(1);

    // Already at the current revision → a tiny "unchanged" answer.
    const unchanged = (await (await fetch(`${base}?since=${body1.rev}`)).json()) as {
      unchanged?: boolean;
      rev: number;
    };
    expect(unchanged).toEqual({ unchanged: true, rev: body1.rev });

    // A new stage bumps the manifest mtime → the follower sees the change.
    await new Promise((r) => setTimeout(r, 12));
    trace.record({ kind: "output", label: "lowered", data: "make it wider" });
    const res3 = await fetch(`${base}?since=${body1.rev}`);
    const body3 = (await res3.json()) as { rev: number; stages: unknown[]; unchanged?: boolean };
    expect(body3.unchanged).toBeUndefined();
    expect(body3.rev).toBeGreaterThan(body1.rev);
    expect(body3.stages).toHaveLength(2);

    // Unknown trace → 404 (same as the manifest route).
    const missing = await fetch(`http://127.0.0.1:${port}/debug/api/traces/nope/live`);
    expect(missing.status).toBe(404);
  });

  it("keeps /debug and tracing off without a traceDir", async () => {
    const prompts: string[] = [];
    server = await startWebServer({ onPrompt: (t) => prompts.push(t) });
    const res = await fetch(`http://127.0.0.1:${server.port}/debug`);
    expect(res.status).toBe(404);
  });

  it("serves image previews only from the allowlisted roots", async () => {
    const { cache, port } = await startTraced();
    const png = [0x89, 0x50, 0x4e, 0x47];

    // Inside the trace cache → served with an image content type.
    writeFileSync(join(cache, "shot_1.png"), new Uint8Array(png));
    const ok = await fetch(
      `http://127.0.0.1:${port}/debug/api/preview?path=${encodeURIComponent(join(cache, "shot_1.png"))}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("image/png");

    // Inside the OS temp dir (the other legitimate attachment home) → served.
    const tmp = join(tmpdir(), `aiui-preview-${process.pid}.png`);
    writeFileSync(tmp, new Uint8Array(png));
    const tmpRes = await fetch(
      `http://127.0.0.1:${port}/debug/api/preview?path=${encodeURIComponent(tmp)}`,
    );
    expect(tmpRes.status).toBe(200);
    rmSync(tmp, { force: true });

    // Outside every root, non-image, relative, missing → uniformly 404.
    for (const bad of [
      join(process.cwd(), "package.json"),
      join(cache, "trace.json"),
      "relative/shot.png",
      join(cache, "missing.png"),
    ]) {
      const res = await fetch(
        `http://127.0.0.1:${port}/debug/api/preview?path=${encodeURIComponent(bad)}`,
      );
      expect(res.status, bad).toBe(404);
    }
  });
});

/**
 * End-to-end over a real server: the frame log records a whole intent-v1
 * exchange (hello → events → fin, acks and pushes included) and
 * `/debug/api/frames` serves it back, with `since` cursoring. Also the e2e
 * home of trace provenance (the hello's `actor` on the manifest).
 */
describe("web backend frame log (/debug/api/frames)", () => {
  let server: WebServer | undefined;
  const openSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      ws.close();
    }
    await server?.close();
    server = undefined;
  });

  const enc = new TextEncoder();

  /** A raw /ws client that pairs each sent frame with its ack (pushes ride separately). */
  async function rawConnect(port: number) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    openSockets.push(socket);
    const pushes: unknown[] = [];
    const ackWaiters: Array<(response: ChannelResponse) => void> = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      // The client contract: pushes carry `kind`, acks never do.
      if ("kind" in message) {
        pushes.push(message);
      } else {
        ackWaiters.shift()?.(message as ChannelResponse);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const send = (frame: Uint8Array): Promise<ChannelResponse> =>
      new Promise((resolve) => {
        ackWaiters.push(resolve);
        socket.send(frame);
      });
    return { send, pushes };
  }

  /** One full mock-seamed intent-v1 turn: hello (actor) → events → bare fin. */
  async function runTurn(port: number, threadId: string) {
    const client = await rawConnect(port);
    expect(
      await client.send(
        encodeFrame({
          v: PROTOCOL_VERSION,
          kind: "hello",
          format: "intent-v1",
          meta: { actor: "agent", intent: { transcriber: "mock", corrector: "mock" } },
        }),
      ),
    ).toMatchObject({ ok: true });
    const events = [
      { at: 1, type: "thread-open", trigger: "talk" },
      { at: 2, type: "talk-start", segment: 1 },
      { at: 3, type: "talk-end", segment: 1, ms: 200 },
      {
        at: 4,
        type: "transcript-final",
        segment: 1,
        text: "make it wider",
        latencyMs: 5,
        model: "mock",
      },
    ];
    expect(
      await client.send(
        encodeFrame(
          { v: PROTOCOL_VERSION, kind: "data", threadId, chunk: { kind: "events" } },
          enc.encode(JSON.stringify({ events })),
        ),
      ),
    ).toMatchObject({ ok: true, threadId });
    expect(
      await client.send(encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId, fin: true })),
    ).toMatchObject({ ok: true, threadId, closed: true });
    return client;
  }

  it("records hello + chunks + acks + pushes, serves them with since cursoring, and lands actor on the trace", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-frames-"));
    const prompts: string[] = [];
    const sunk: FrameLogEntry[] = [];
    server = await startWebServer({
      onPrompt: (text) => {
        prompts.push(text);
      },
      traceDir: cache,
      // The recording seam observes exactly what the ring records.
      frameSink: (entry) => {
        sunk.push(entry);
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    await runTurn(server.port, "t-frames");
    expect(prompts).toEqual([`${TRANSCRIPTION_NOTE}\n\n---\n\nmake it wider`]);

    const { seq, entries } = (await (await fetch(`${base}/debug/api/frames`)).json()) as {
      seq: number;
      entries: FrameLogEntry[];
    };
    // Frame → ack pairs in order, with the fin's lowered-prompt push between
    // its cause (the fin frame) and the fin's ack.
    expect(entries.map((e) => e.label)).toEqual([
      "hello",
      "ack",
      "chunk events",
      "ack",
      "fin",
      "push lowered-prompt",
      "ack",
    ]);
    expect(entries.map((e) => e.dir)).toEqual(["in", "out", "in", "out", "in", "out", "out"]);
    expect(seq).toBe(entries[entries.length - 1].seq);
    // seqs are strictly increasing.
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => entries[0].seq + i));
    // The hello entry carries the envelope (meta inline); the events chunk its
    // parsed payload; the push the committed prompt.
    expect(entries[0].data).toMatchObject({ kind: "hello", meta: { actor: "agent" } });
    expect(entries[2]).toMatchObject({ threadId: "t-frames" });
    expect((entries[2].data as { events: unknown[] }).events).toHaveLength(4);
    const wrapped = `${TRANSCRIPTION_NOTE}\n\n---\n\nmake it wider`;
    expect(entries[5].data).toEqual({
      kind: "lowered-prompt",
      threadId: "t-frames",
      prompt: wrapped,
      spans: [{ kind: "preamble", start: 0, end: wrapped.indexOf("make it wider") }],
    });
    // CORS, like the rest of /debug.
    const res = await fetch(`${base}/debug/api/frames`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    // since cursoring: only what's newer comes back; at the head, nothing.
    const mid = entries[3].seq;
    const after = (await (await fetch(`${base}/debug/api/frames?since=${mid}`)).json()) as {
      seq: number;
      entries: FrameLogEntry[];
    };
    expect(after.seq).toBe(seq);
    expect(after.entries.map((e) => e.label)).toEqual(["fin", "push lowered-prompt", "ack"]);
    expect(
      (
        (await (await fetch(`${base}/debug/api/frames?since=${seq}`)).json()) as {
          entries: FrameLogEntry[];
        }
      ).entries,
    ).toEqual([]);

    // The sink saw exactly what the ring served (the recording seam).
    expect(sunk).toEqual(entries);

    // Provenance: the hello's actor landed on the trace manifest.
    const { traces } = (await (await fetch(`${base}/debug/api/traces`)).json()) as {
      traces: Array<{ threadId: string; actor?: string }>;
    };
    expect(traces[0]).toMatchObject({ threadId: "t-frames", actor: "agent" });
  });

  it("replaces a speech push's base64 with its length in the log", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-frames-"));
    server = await startWebServer({
      onPrompt: () => {},
      traceDir: cache,
      // A premium-shaped intent-v1 with the offline speaker, so fin speaks.
      formats: new Map([["intent-v1", createIntentV1Format({ speaker: mockSpeaker() })]]),
    });
    const client = await rawConnect(server.port);
    await client.send(
      encodeFrame({
        v: PROTOCOL_VERSION,
        kind: "hello",
        format: "intent-v1",
        meta: { intent: { transcriber: "mock", audioBack: "acks" } },
      }),
    );
    await client.send(
      encodeFrame(
        { v: PROTOCOL_VERSION, kind: "data", threadId: "t-tts", chunk: { kind: "events" } },
        enc.encode(
          JSON.stringify({
            events: [
              { at: 1, type: "thread-open", trigger: "talk" },
              {
                at: 2,
                type: "transcript-final",
                segment: 1,
                text: "speak up",
                latencyMs: 5,
                model: "mock",
              },
            ],
          }),
        ),
      ),
    );
    await client.send(
      encodeFrame({ v: PROTOCOL_VERSION, kind: "data", threadId: "t-tts", fin: true }),
    );

    // The client received the real base64 clip…
    const speech = client.pushes.find((m) => (m as { kind?: string }).kind === "speech") as {
      data: string;
    };
    expect(typeof speech.data).toBe("string");
    // …but the log holds only its length.
    const { entries } = (await (
      await fetch(`http://127.0.0.1:${server.port}/debug/api/frames`)
    ).json()) as { entries: FrameLogEntry[] };
    const logged = entries.find((e) => e.label === "push speech") as FrameLogEntry;
    expect((logged.data as { data: number }).data).toBe(speech.data.length);
  });

  it("404s /debug/api/frames without a traceDir (no debug routes at all)", async () => {
    server = await startWebServer({ onPrompt: () => {} });
    const res = await fetch(`http://127.0.0.1:${server.port}/debug/api/frames`);
    expect(res.status).toBe(404);
  });

  it("flags debug mode on /debug/api/info when the server runs with debug", async () => {
    const cache = mkdtempSync(join(tmpdir(), "aiui-frames-"));
    server = await startWebServer({ onPrompt: () => {}, traceDir: cache, debug: true });
    const info = (await (await fetch(`http://127.0.0.1:${server.port}/debug/api/info`)).json()) as {
      debug?: boolean;
    };
    expect(info.debug).toBe(true);
  });
});

describe("previewablePath", () => {
  it("requires absolute, image-suffixed, existing files under a root", () => {
    const root = mkdtempSync(join(tmpdir(), "aiui-prev-"));
    writeFileSync(join(root, "a.png"), "x");
    writeFileSync(join(root, "a.txt"), "x");
    expect(previewablePath(join(root, "a.png"), [root])).toBeTruthy();
    expect(previewablePath(join(root, "a.txt"), [root])).toBeUndefined();
    expect(previewablePath("a.png", [root])).toBeUndefined();
    expect(previewablePath(join(root, "nope.png"), [root])).toBeUndefined();
    expect(previewablePath(join(root, "a.png"), [join(root, "sub")])).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("is not fooled by .. traversal out of a root", () => {
    const root = mkdtempSync(join(tmpdir(), "aiui-prev-"));
    const outside = mkdtempSync(join(tmpdir(), "aiui-prev-out-"));
    writeFileSync(join(outside, "secret.png"), "x");
    expect(
      previewablePath(join(root, "..", basename(outside), "secret.png"), [root]),
    ).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
