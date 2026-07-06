import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { connectChannelClient } from "../client";
import type { FrameLogEntry } from "../frame-log";
import { runServe, type ServeHandle } from "./serve";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-serve-"));

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
});
