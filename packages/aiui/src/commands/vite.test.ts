import type { RunningServer } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";
import { resolveChannelTarget } from "./vite";

/** Build a `RunningServer` with all required fields, overriding as needed. */
function server(overrides: Partial<RunningServer> = {}): RunningServer {
  return {
    tag: "tag-1",
    pid: 1000,
    ppid: 900,
    port: 5173,
    cwd: "/tmp/project",
    startedAt: "2026-07-04T00:00:00.000Z",
    file: "/tmp/registry/1000.json",
    ...overrides,
  };
}

describe("resolveChannelTarget", () => {
  it("returns the server matching the requested tag", () => {
    const a = server({ tag: "a", port: 1 });
    const b = server({ tag: "b", port: 2 });
    expect(resolveChannelTarget([a, b], "b")).toEqual({ server: b });
  });

  it("errors when the requested tag is not running, naming the tag and running tags", () => {
    const a = server({ tag: "a" });
    const b = server({ tag: "b" });
    const result = resolveChannelTarget([a, b], "missing");
    expect(result.server).toBeUndefined();
    expect(result.error).toContain("missing");
    expect(result.error).toContain("a");
    expect(result.error).toContain("b");
  });

  it("errors with (none running) when no servers exist and a tag is requested", () => {
    const result = resolveChannelTarget([], "wanted");
    expect(result.server).toBeUndefined();
    expect(result.error).toContain("wanted");
    expect(result.error).toContain("(none running)");
  });

  it("defers to the selector (no auto-pick) when no tag is given and servers exist", () => {
    const a = server({ tag: "a", port: 1 });
    const b = server({ tag: "b", port: 2 });
    const result = resolveChannelTarget([a, b], undefined);
    expect(result.server).toBeUndefined();
    expect(result.select).toEqual([a, b]);
  });

  it("returns an empty target (no server, no selection) when no tag and no servers", () => {
    expect(resolveChannelTarget([], undefined)).toEqual({});
  });
});
