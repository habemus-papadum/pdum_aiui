import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { RunningServer } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";
import { parseViteLocalUrl, resolveChannelTarget, teeAndDetectLocalUrl } from "./vite";

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

describe("parseViteLocalUrl", () => {
  it("parses the plain ready line", () => {
    expect(parseViteLocalUrl("  ➜  Local:   http://localhost:5174/")).toBe(
      "http://localhost:5174/",
    );
  });

  it("strips ANSI codes, including the ones inside the URL", () => {
    // Vite colors the host and port separately, so escape sequences sit in
    // the middle of the URL text (this is verbatim Vite output).
    const line =
      "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   " +
      "\x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m";
    expect(parseViteLocalUrl(line)).toBe("http://localhost:5174/");
  });

  it("accepts 127.0.0.1, https, and a base path", () => {
    expect(parseViteLocalUrl("  ➜  Local:   http://127.0.0.1:5173/")).toBe(
      "http://127.0.0.1:5173/",
    );
    expect(parseViteLocalUrl("  ➜  Local:   https://localhost:5173/")).toBe(
      "https://localhost:5173/",
    );
    expect(parseViteLocalUrl("  ➜  Local:   http://localhost:5173/my-app/")).toBe(
      "http://localhost:5173/my-app/",
    );
  });

  it("ignores everything that is not the local ready line", () => {
    expect(parseViteLocalUrl("  VITE v6.0.0  ready in 210 ms")).toBeUndefined();
    expect(parseViteLocalUrl("  ➜  Network: use --host to expose")).toBeUndefined();
    // A non-loopback host is not a URL to open on this machine.
    expect(parseViteLocalUrl("  ➜  Network: http://192.168.1.10:5173/")).toBeUndefined();
    expect(parseViteLocalUrl("  ➜  press h + enter to show help")).toBeUndefined();
    expect(parseViteLocalUrl("")).toBeUndefined();
  });
});

describe("teeAndDetectLocalUrl", () => {
  /** Drive the tee with the given chunks; return the forwarded output and URLs seen. */
  async function run(chunks: string[]): Promise<{ output: string; urls: string[] }> {
    const source = new PassThrough();
    const pieces: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        pieces.push(chunk);
        cb();
      },
    });
    const urls: string[] = [];
    teeAndDetectLocalUrl(source, sink, (url) => urls.push(url));
    for (const chunk of chunks) {
      source.write(chunk);
    }
    source.end();
    await once(source, "end");
    return { output: Buffer.concat(pieces).toString(), urls };
  }

  it("forwards all output verbatim and reports the URL once", async () => {
    const banner = "  VITE v6.0.0  ready in 210 ms\n\n  ➜  Local:   http://localhost:5173/\n";
    const later = "  ➜  Network: use --host to expose\npage reload src/app.ts\n";
    const { output, urls } = await run([banner, later]);
    expect(output).toBe(banner + later);
    expect(urls).toEqual(["http://localhost:5173/"]);
  });

  it("finds a URL split across chunk boundaries", async () => {
    const { urls } = await run(["  ➜  Local:   http://loc", "alhost:5174/\n"]);
    expect(urls).toEqual(["http://localhost:5174/"]);
  });

  it("stops scanning after the first hit (later Local: lines are just forwarded)", async () => {
    const { output, urls } = await run([
      "  ➜  Local:   http://localhost:5173/\n",
      "  ➜  Local:   http://localhost:9999/\n",
    ]);
    expect(urls).toEqual(["http://localhost:5173/"]);
    expect(output).toContain("9999");
  });

  it("reports nothing when the stream never prints a ready line", async () => {
    const { output, urls } = await run(["error: port scan failed\n", "no banner here"]);
    expect(urls).toEqual([]);
    expect(output).toBe("error: port scan failed\nno banner here");
  });
});
