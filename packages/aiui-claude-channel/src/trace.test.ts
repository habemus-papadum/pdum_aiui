import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTraceStore,
  listTraces,
  projectCacheDir,
  readTrace,
  sessionLabel,
  type TraceStageEvent,
  traceBlobPath,
} from "./trace";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-trace-"));

describe("projectCacheDir", () => {
  it("lives in the USER cache, keyed by the project's full path", () => {
    const dir = projectCacheDir("/some/project");
    expect(dir).toMatch(/[/\\]projects[/\\]project-[0-9a-f]{8}$/);
    // Same basename, different path → different slug (the hash keeps them apart).
    expect(projectCacheDir("/other/project")).not.toBe(dir);
    // Stable per path, and the default base is cwd.
    expect(projectCacheDir("/some/project")).toBe(dir);
    expect(projectCacheDir()).toBe(projectCacheDir(process.cwd()));
  });
});

describe("sessionLabel", () => {
  it("is <tag>·<pid>·<HHMMSS> from the process-start wall clock", () => {
    expect(sessionLabel("lab", 4242, new Date(2026, 6, 5, 9, 5, 7))).toBe("lab·4242·090507");
  });

  it("falls back to 'channel' for an untagged server", () => {
    expect(sessionLabel(undefined, 7, new Date(2026, 6, 5, 23, 59, 0))).toBe("channel·7·235900");
  });

  it("defaults to this process's pid and start time", () => {
    expect(sessionLabel("t")).toMatch(new RegExp(`^t·${process.pid}·\\d{6}$`));
  });
});

describe("createTraceStore", () => {
  it("records stages into a manifest and finalizes on end", () => {
    const cache = freshCache();
    const trace = createTraceStore(cache).begin("text-concat", "thread-1");

    trace.record({ kind: "input", label: "frame 0", data: { text: "hi" } });
    trace.record({ kind: "ir", label: "resolved", data: "hi there" });
    trace.record({ kind: "output", label: "lowered prompt", data: "hi there" });
    trace.end();

    const manifest = readTrace(cache, trace.id);
    expect(manifest).not.toBeNull();
    expect(manifest?.format).toBe("text-concat");
    expect(manifest?.threadId).toBe("thread-1");
    expect(manifest?.status).toBe("completed");
    expect(manifest?.endedAt).toBeDefined();
    expect(manifest?.stages.map((s) => s.kind)).toEqual(["input", "ir", "output"]);
    expect(manifest?.stages[0].data).toEqual({ text: "hi" });
  });

  it("fires the onStage sink for every recorded stage, tagged with thread + format", () => {
    const cache = freshCache();
    const events: TraceStageEvent[] = [];
    const store = createTraceStore(cache, "wb·1·010203", (e) => events.push(e));
    const trace = store.begin("intent-v1", "t-99", "agent");

    trace.record({ kind: "info", label: "cost: transcription", data: { usd: 0.0004 } });
    trace.record({ kind: "ir", label: "composed intent", data: "x" });

    expect(events.map((e) => e.stage.label)).toEqual(["cost: transcription", "composed intent"]);
    expect(events[0]).toMatchObject({ traceId: trace.id, threadId: "t-99", format: "intent-v1" });
    // The `at` timestamp is filled in before the sink sees the stage.
    expect(typeof events[0].stage.at).toBe("string");
  });

  it("swallows a throwing onStage sink — the stage still lands, the record never throws", () => {
    const cache = freshCache();
    const store = createTraceStore(cache, undefined, () => {
      throw new Error("narrator boom");
    });
    const trace = store.begin("f", "t");

    expect(() => trace.record({ kind: "info", label: "x" })).not.toThrow();
    expect(readTrace(cache, trace.id)?.stages.map((s) => s.label)).toEqual(["x"]);
  });

  it("records the actor on the manifest only when one is given", () => {
    const cache = freshCache();
    const store = createTraceStore(cache);
    const tagged = store.begin("intent-v1", "t-agent", "agent");
    tagged.end();
    expect(readTrace(cache, tagged.id)?.actor).toBe("agent");

    const untagged = store.begin("intent-v1", "t-anon");
    untagged.end();
    const manifest = readTrace(cache, untagged.id);
    expect(manifest?.actor).toBeUndefined();
    expect(manifest && "actor" in manifest).toBe(false);
  });

  it("stamps the store's session label on every manifest, and omits it without one", () => {
    const cache = freshCache();
    const labeled = createTraceStore(cache, "wb·1·090507");
    expect(labeled.session).toBe("wb·1·090507");
    const trace = labeled.begin("intent-v1", "t-here");
    trace.end();
    expect(readTrace(cache, trace.id)?.session).toBe("wb·1·090507");

    const bare = createTraceStore(cache).begin("intent-v1", "t-bare");
    bare.end();
    const manifest = readTrace(cache, bare.id);
    expect(manifest?.session).toBeUndefined();
    expect(manifest && "session" in manifest).toBe(false);
  });

  it("writes blobs as files and records their absolute path", () => {
    const cache = freshCache();
    const trace = createTraceStore(cache).begin("shots", "t");
    const bytes = new Uint8Array([137, 80, 78, 71]);

    const path = trace.recordBlob({ kind: "input", label: "screenshot" }, bytes, "shot.png");
    expect(path).toBe(join(trace.dir, "shot.png"));
    expect(new Uint8Array(readFileSync(path as string))).toEqual(bytes);
    expect(readTrace(cache, trace.id)?.stages[0].file).toBe("shot.png");
  });

  it("refuses unsafe blob filenames and records nothing after end", () => {
    const cache = freshCache();
    const trace = createTraceStore(cache).begin("f", "t");
    expect(
      trace.recordBlob({ kind: "input", label: "x" }, new Uint8Array(), "../evil"),
    ).toBeUndefined();
    trace.end();
    trace.record({ kind: "info", label: "late" });
    expect(readTrace(cache, trace.id)?.stages).toEqual([]);
  });

  it("is a silent no-op when the cache dir cannot be created", () => {
    // Block by creating a *file* where the traces directory should go.
    const cache = freshCache();
    const store = createTraceStore(join(cache, "blocked"));
    mkdirSync(join(cache, "blocked"), { recursive: true });
    writeFileSync(join(cache, "blocked", "traces"), "not a dir");
    const trace = store.begin("f", "t");
    trace.record({ kind: "info", label: "x" });
    trace.end();
    expect(existsSync(join(trace.dir, "trace.json"))).toBe(false);
  });
});

describe("listTraces / readTrace / traceBlobPath", () => {
  it("lists newest first and tolerates junk entries", () => {
    const cache = freshCache();
    const store = createTraceStore(cache);
    const first = store.begin("a", "t1");
    const second = store.begin("b", "t2");
    const ids = listTraces(cache).map((t) => t.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([first.id, second.id]));
    // Descending id order = newest first (ids embed a UTC timestamp).
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  it("returns [] / null for a missing cache dir or trace", () => {
    const cache = freshCache();
    expect(listTraces(cache)).toEqual([]);
    expect(readTrace(cache, "nope")).toBeNull();
    expect(readTrace(cache, "../escape")).toBeNull();
  });

  it("rejects path traversal in blob names", () => {
    expect(traceBlobPath("/c", "id", "../../etc/passwd")).toBeNull();
    expect(traceBlobPath("/c", "../id", "f.png")).toBeNull();
    expect(traceBlobPath("/c", "id", "trace.json")).toBeNull();
    expect(traceBlobPath("/c", "id", "shot.png")).toBe("/c/traces/id/shot.png");
  });
});
