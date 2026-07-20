import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntry as readEntryV2 } from "@habemus-papadum/aiui-registry";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import WebSocket from "ws";
import { connectChannelClient } from "../client";
import type { FrameLogEntry } from "../frame-log";
import { listMcpServers } from "../registry";
import type { Sidecar } from "../sidecar";
import {
  isNarratedTraceStage,
  makeFrameNarrator,
  parsePort,
  runServe as runServeRaw,
  type ServeHandle,
  type ServeOptions,
} from "./serve";

// Every `runServe` here is hermetic: the real `serve` composes standardSidecars
// (which would spin up the intent Vite dev server, a CDP bridge, …), so the
// tests inject `sidecars: []` by default and opt in to a fake when they mean to
// exercise sidecar hosting. A test that needs the real set would pass its own.
const runServe = (opts: ServeOptions = {}): Promise<ServeHandle> =>
  runServeRaw({ sidecars: [], ...opts });

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-serve-"));

/** Poll `predicate` until it holds (the page-tool change signal is debounced). */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor: condition not met before timeout");
};

/** Ask the OS for a free loopback port (bind 0, read it back, release it). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });

describe("runServe (standalone debug channel server)", () => {
  let handle: ServeHandle | undefined;
  let stdout: string[];
  let stderr: string[];
  let outSpy: MockInstance;
  let errSpy: MockInstance;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    // Capture both streams without echoing them into the test run: stdout is the
    // parseable protocol, stderr is the lifecycle + wire narration.
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    // The server registers itself (as debug) — keep that out of the real
    // shared registry.
    vi.stubEnv("AIUI_CACHE", freshCache());
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    outSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("prints the machine-parseable ready line first, exactly once, and serves in debug mode", async () => {
    handle = await runServe({ cacheDir: freshCache() });

    expect(stdout[0]).toMatch(/^AIUI_CHANNEL_SERVE \{.*\}\n$/);
    const ready = JSON.parse(stdout[0].slice("AIUI_CHANNEL_SERVE ".length)) as {
      port: number;
      pid: number;
      debug: boolean;
    };
    expect(ready).toEqual({ port: handle.port, pid: process.pid, debug: true });
    expect(stdout.filter((line) => line.startsWith("AIUI_CHANNEL_SERVE"))).toHaveLength(1);

    // The server is up, in debug mode — /health says so.
    const health = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as {
      ok: boolean;
      debug?: boolean;
      host?: string;
    };
    expect(health).toMatchObject({ ok: true, debug: true });
    // The default posture: loopback only.
    expect(health.host).toBe("127.0.0.1");
  });

  it("binds 0.0.0.0 with bind:'host' (the same contract as `mcp --bind`)", async () => {
    handle = await runServe({ cacheDir: freshCache(), bind: "host" });
    const health = (await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()) as {
      host?: string;
    };
    expect(health.host).toBe("0.0.0.0");
  });

  it("prints lowered prompts to stdout as delimited blocks (the 'session' is stdout)", async () => {
    handle = await runServe({ cacheDir: freshCache() });

    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${handle.port}/ws`,
      format: "text-concat",
    });
    await client.openThread("t-serve").finish({ text: "make the plot wider" });
    await client.close();

    const block = stdout.find((line) => line.startsWith("--- lowered prompt ---"));
    expect(block).toBe("--- lowered prompt ---\nmake the plot wider\n--- end ---\n");
  });

  it("narrates page-tool register/unregister transitions to stdout as text", async () => {
    handle = await runServe({ cacheDir: freshCache() });

    // A page connects to /tools and declares a namespace — exactly what the
    // in-browser bridge does. The directory debounces (500ms) before signalling.
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/tools`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        v: 1,
        type: "register",
        ns: "morpho",
        hash: "h1",
        tools: [{ name: "plot_spectrum" }, { name: "set_range" }],
        url: "http://app/",
      }),
    );

    const pageToolsBlock = () => stdout.find((line) => line.startsWith("--- page tools ---"));
    await waitFor(() => pageToolsBlock() !== undefined);
    expect(pageToolsBlock()).toBe(
      "--- page tools ---\n+ morpho/plot_spectrum, morpho/set_range\n" +
        "= now: morpho/plot_spectrum, morpho/set_range\n--- end ---\n",
    );

    // Closing the socket drops the namespace — the unregister transition.
    stdout.length = 0;
    socket.close();
    await waitFor(() => pageToolsBlock() !== undefined);
    expect(pageToolsBlock()).toBe(
      "--- page tools ---\n- morpho/plot_spectrum, morpho/set_range\n= now: none\n--- end ---\n",
    );
  });

  it("narrates connections and a coalesced media summary to stderr (not stdout)", async () => {
    handle = await runServe({ cacheDir: freshCache() });

    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${handle.port}/ws`,
      format: "text-concat",
    });
    await client.openThread("t-wire").finish({ text: "widen it" });
    await client.close();

    await waitFor(() => stderr.join("").includes("connected:"));
    const narration = stderr.join("");
    // The hello → a connection line; the thread's frames → one coalesced summary.
    expect(narration).toContain("[aiui-channel serve] connected: text-concat");
    expect(narration).toMatch(/\[aiui-channel serve\] thread t-wire: .* → fin/);
    // Wire narration never pollutes the stdout protocol.
    expect(stdout.join("")).not.toContain("connected:");
  });

  it("--record appends JSONL frame-log entries under <cache>/recordings/", async () => {
    const cache = freshCache();
    handle = await runServe({ cacheDir: cache, record: true });

    const client = await connectChannelClient({
      url: `ws://127.0.0.1:${handle.port}/ws`,
      format: "text-concat",
    });
    await client.openThread("t-rec").finish({ text: "record me" });
    await client.close();
    await handle.close(); // flushes the recording

    const dir = join(cache, "recordings");
    const [file] = readdirSync(dir);
    expect(file).toMatch(new RegExp(`-${process.pid}\\.jsonl$`));
    const entries = readFileSync(join(dir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as FrameLogEntry);
    // hello + its ack, then the (fin) data frame + its ack.
    expect(entries.map((e) => e.label)).toEqual(["hello", "ack", "data (fin)", "ack"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("names its trace session after the --tag on /debug/api/traces", async () => {
    handle = await runServe({ cacheDir: freshCache(), tag: "wb" });
    const list = (await (
      await fetch(`http://127.0.0.1:${handle.port}/debug/api/traces`)
    ).json()) as { traces: unknown[]; session?: string };
    expect(list.traces).toEqual([]);
    expect(list.session).toMatch(/^wb·\d+·\d{6}$/);
  });

  it("registers as a debug server (assignedName + kind) and removes its entry on close", async () => {
    handle = await runServe({ cacheDir: freshCache(), tag: "wb", name: "aiui debug" });

    // The v1 listing still shows the entry (transition guarantee, M3→M4)…
    const [server, ...rest] = listMcpServers();
    expect(rest).toEqual([]);
    expect(server).toMatchObject({ tag: "wb", pid: process.pid, port: handle.port });
    // …and the schema-v2 semantics live in the file itself.
    expect(readEntryV2(server.file)).toMatchObject({
      schema: 2,
      kind: "debug",
      assignedName: "aiui debug",
    });

    await handle.close();
    handle = undefined;
    expect(listMcpServers()).toEqual([]);
  });

  it("defaults the registry tag to a UUID when untagged", async () => {
    handle = await runServe({ cacheDir: freshCache() });
    const [server] = listMcpServers();
    expect(server?.tag).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(readEntryV2(server.file)).toMatchObject({ kind: "debug" });
    expect(readEntryV2(server.file)?.assignedName).toBeUndefined();
  });

  it("does not create a recording without --record", async () => {
    const cache = freshCache();
    handle = await runServe({ cacheDir: cache });
    expect(existsSync(join(cache, "recordings"))).toBe(false);
  });

  it("--port binds the requested port, and the ready line reports it", async () => {
    const port = await freePort();
    handle = await runServe({ cacheDir: freshCache(), port });

    expect(handle.port).toBe(port);
    const ready = JSON.parse(stdout[0].slice("AIUI_CHANNEL_SERVE ".length)) as { port: number };
    expect(ready.port).toBe(port);
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      ok: boolean;
    };
    expect(health.ok).toBe(true);
  });

  it("hosts the sidecars it is handed (a client finds their endpoints on the port)", async () => {
    // The real `serve` composes standardSidecars; here we inject one live
    // Sidecar to prove hosting works without booting the heavy standard set.
    const testSidecar: Sidecar = {
      name: "test",
      mount(app) {
        app.get("/__test_sidecar", (_req, res) => res.json({ root: "/proj" }));
        return {};
      },
    };
    handle = await runServe({ cacheDir: freshCache(), sidecars: [testSidecar] });

    const res = await fetch(`http://127.0.0.1:${handle.port}/__test_sidecar`);
    expect(await res.json()).toEqual({ root: "/proj" });
  });

  it("fails loudly — not by drifting — when the requested port is taken", async () => {
    // The first server (OS-assigned) is the squatter; the second asks for its port.
    handle = await runServe({ cacheDir: freshCache() });
    await expect(runServe({ cacheDir: freshCache(), port: handle.port })).rejects.toThrow(
      new RegExp(`port ${handle.port} is already in use — is another`),
    );
    // No stray second ready line: the failed server never announced itself.
    expect(stdout.filter((line) => line.startsWith("AIUI_CHANNEL_SERVE"))).toHaveLength(1);
  });
});

describe("parsePort (--port validation)", () => {
  it("accepts decimal integers in [1, 65535]", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("49223")).toBe(49223);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort(" 8080 ")).toBe(8080); // shells leave whitespace around sometimes
  });

  it("rejects everything else with a readable message", () => {
    for (const bad of ["0", "65536", "-1", "abc", "", "8080.5", "0x1f90", "8080a"]) {
      expect(() => parsePort(bad)).toThrow(/expected an integer between 1 and 65535/);
    }
  });
});

describe("makeFrameNarrator (frame-log → text narration)", () => {
  /** Feed synthetic frame-log entries through the narrator, collecting its lines. */
  const run = (
    entries: Array<Partial<FrameLogEntry> & { dir: "in" | "out"; label: string }>,
  ): string[] => {
    const lines: string[] = [];
    const narrate = makeFrameNarrator((message) => lines.push(message));
    let seq = 0;
    for (const entry of entries) {
      seq += 1;
      narrate({ seq, at: "t", ...entry });
    }
    return lines;
  };

  it("prints a connection line from a hello (format, actor, tab)", () => {
    expect(
      run([
        {
          dir: "in",
          label: "hello",
          data: { format: "intent-v1", meta: { actor: "agent", tab: { title: "Morphogen" } } },
        },
      ]),
    ).toEqual(["connected: intent-v1 (agent) — Morphogen"]);
  });

  it("coalesces a thread's inbound media into ONE summary at fin (no per-chunk spam)", () => {
    expect(
      run([
        { dir: "in", label: "chunk context", threadId: "t", data: {} },
        { dir: "in", label: "chunk audio seg_1 #0", threadId: "t", bytes: 8000 },
        { dir: "in", label: "chunk audio seg_1 #1", threadId: "t", bytes: 8000 },
        { dir: "in", label: "chunk attachment shot_1 (image/png)", threadId: "t", bytes: 20480 },
        { dir: "in", label: "fin", threadId: "t" },
      ]),
    ).toEqual(["thread t: 2 audio (~15.6KB), 1 shot (20.0KB), 1 context → fin"]);
  });

  it("summarizes legacy text-concat data frames at data (fin)", () => {
    expect(
      run([
        { dir: "in", label: "data", threadId: "t", bytes: 10 },
        { dir: "in", label: "data (fin)", threadId: "t", bytes: 12 },
      ]),
    ).toEqual(["thread t: 2 data (~22B) → fin"]);
  });

  it("narrates a speech push (char count), but not the lowered-prompt push or acks", () => {
    expect(
      run([
        { dir: "out", label: "ack", data: {} },
        { dir: "out", label: "push lowered-prompt", data: {} },
        { dir: "out", label: "push speech", data: { kind: "speech", data: 128 } },
      ]),
    ).toEqual(["spoke (128 chars)"]);
  });

  it("reports a malformed frame with its byte count", () => {
    expect(run([{ dir: "in", label: "malformed frame", bytes: 37 }])).toEqual([
      "malformed frame (37B)",
    ]);
  });
});

describe("isNarratedTraceStage (curated pipeline events)", () => {
  it("selects linter / transcription / cost / composed-intent stages", () => {
    for (const label of [
      "linter tool call format_code",
      "linter tool result",
      "linter disabled",
      "cost: transcription",
      "composed intent",
      "fin compose",
    ]) {
      expect(isNarratedTraceStage(label)).toBe(true);
    }
  });

  it("skips the many other IRs a lowering run records", () => {
    // `transcription failed …` has no living writer on this live tap (its spend
    // narrates as `cost: realtime transcription seg_N`), so it is NOT narrated —
    // the old prefix branch was unreachable and was dropped.
    for (const label of [
      "user text",
      "prompt preamble",
      "merged events",
      "app selection",
      "transcription failed abc",
    ]) {
      expect(isNarratedTraceStage(label)).toBe(false);
    }
  });
});
