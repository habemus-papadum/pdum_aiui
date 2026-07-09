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
  traceBlobPath,
} from "./trace";

const freshCache = () => mkdtempSync(join(tmpdir(), "aiui-trace-"));

describe("projectCacheDir", () => {
  it("is .aiui-cache under the given base (default cwd)", () => {
    expect(projectCacheDir("/some/project")).toBe("/some/project/.aiui-cache");
    expect(projectCacheDir()).toBe(join(process.cwd(), ".aiui-cache"));
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
