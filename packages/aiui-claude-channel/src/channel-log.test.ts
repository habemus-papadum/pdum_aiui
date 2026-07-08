import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannelLog } from "./channel-log";
import type { FrameLogEntry } from "./frame-log";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-channel-log-"));

const pushEntry = (label: string, data: unknown): FrameLogEntry => ({
  seq: 1,
  at: new Date().toISOString(),
  dir: "out",
  label,
  data,
});

describe("createChannelLog", () => {
  it("writes lifecycle lines as JSONL into <cache>/logs/channel-<stamp>-<pid>.jsonl", async () => {
    const cache = freshCache();
    const log = createChannelLog(cache);
    expect(log.path).toMatch(new RegExp(`logs/channel-.*-${process.pid}\\.jsonl$`));

    log.log("up", { tag: "t", port: 1234 });
    log.log("shutdown");
    await log.close();

    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const [up, shutdown] = lines.map((line) => JSON.parse(line));
    expect(up).toMatchObject({ label: "up", data: { tag: "t", port: 1234 } });
    expect(typeof up.at).toBe("string");
    expect(shutdown).toMatchObject({ label: "shutdown" });
    expect(shutdown.data).toBeUndefined();
  });

  it("frameSink appends error pushes (with their payload) and ignores everything else", async () => {
    const cache = freshCache();
    const log = createChannelLog(cache);

    log.frameSink(
      pushEntry("push error", {
        kind: "error",
        source: "voice",
        message: "gemini live session closed (1008: API key not valid.)",
        data: { closeCode: 1008, closeReason: "API key not valid." },
      }),
    );
    log.frameSink(pushEntry("push lowered", { kind: "lowered" }));
    log.frameSink({ seq: 3, at: new Date().toISOString(), dir: "in", label: "hello" });
    await log.close();

    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      label: "error push",
      data: {
        message: "gemini live session closed (1008: API key not valid.)",
        data: { closeCode: 1008 },
      },
    });
  });

  it("is a silent no-op when the logs dir cannot be created", async () => {
    const cache = freshCache();
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "logs"), "not a dir");

    const log = createChannelLog(cache);
    log.log("up"); // must not throw
    await log.close();
    expect(existsSync(log.path)).toBe(false);
  });

  it("close is idempotent and stops further writes", async () => {
    const cache = freshCache();
    const log = createChannelLog(cache);
    log.log("up");
    await log.close();
    log.log("late"); // after close: dropped, not an error
    await log.close();
    expect(readFileSync(log.path, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
