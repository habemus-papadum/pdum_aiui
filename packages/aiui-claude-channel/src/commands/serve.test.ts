import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { connectChannelClient } from "../client";
import type { FrameLogEntry } from "../frame-log";
import { parsePort, runServe, type ServeHandle } from "./serve";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-serve-"));

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
  let outSpy: MockInstance;
  let errSpy: MockInstance;

  beforeEach(() => {
    stdout = [];
    // Capture the command's stdout protocol without echoing it into the test
    // run; stderr progress is muted the same way.
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    outSpy.mockRestore();
    errSpy.mockRestore();
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
    };
    expect(health).toMatchObject({ ok: true, debug: true });
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

  it("--sidecars hosts descriptors on the debug server (same contract as mcp)", async () => {
    // A real module on disk, reached by absolute path — the shape launchers
    // hand over (load-sidecars dynamic-imports whatever specifier it's given).
    const fixture = fileURLToPath(new URL("./serve-sidecar.fixture.mjs", import.meta.url));
    handle = await runServe({
      cacheDir: freshCache(),
      sidecars: JSON.stringify([
        { name: "test", module: fixture, export: "testSidecar", options: { root: "/proj" } },
      ]),
    });

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
