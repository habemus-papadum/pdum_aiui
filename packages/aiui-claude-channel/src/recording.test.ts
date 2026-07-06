import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FrameLogEntry } from "./frame-log";
import { createJsonlRecorder } from "./recording";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-recording-"));

const entry = (seq: number, label: string): FrameLogEntry => ({
  seq,
  at: new Date().toISOString(),
  dir: "in",
  label,
});

describe("createJsonlRecorder", () => {
  it("writes one JSON line per entry into <cache>/recordings/<stamp>-<pid>.jsonl", async () => {
    const cache = freshCache();
    const recorder = createJsonlRecorder(cache);
    expect(recorder.path).toMatch(new RegExp(`recordings/.*-${process.pid}\\.jsonl$`));

    recorder.sink(entry(1, "hello"));
    recorder.sink({ ...entry(2, "chunk events"), threadId: "t", data: { events: [] } });
    recorder.sink({ ...entry(3, "chunk attachment shot_1 (image/png)"), bytes: 64 });
    await recorder.close();

    const lines = readFileSync(recorder.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as FrameLogEntry);
    expect(parsed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(parsed[1]).toMatchObject({ label: "chunk events", threadId: "t", data: { events: [] } });
    // Binary payloads arrive already reduced to byte counts (frame-log.ts).
    expect(parsed[2].bytes).toBe(64);
    expect(readdirSync(join(cache, "recordings"))).toHaveLength(1);
  });

  it("is a silent no-op when the recordings dir cannot be created", async () => {
    // Block by creating a *file* where the recordings directory should go.
    const cache = freshCache();
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "recordings"), "not a dir");

    const recorder = createJsonlRecorder(cache);
    recorder.sink(entry(1, "hello")); // must not throw
    await recorder.close();
    expect(existsSync(recorder.path)).toBe(false);
  });

  it("close is idempotent and stops further writes", async () => {
    const cache = freshCache();
    const recorder = createJsonlRecorder(cache);
    recorder.sink(entry(1, "hello"));
    await recorder.close();
    recorder.sink(entry(2, "late")); // after close: dropped, not an error
    await recorder.close();
    expect(readFileSync(recorder.path, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
