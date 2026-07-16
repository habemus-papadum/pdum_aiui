import { describe, expect, it } from "vitest";
import { type AiuiArgs, infoFlag, splitAiuiArgs } from "./aiui-args";

/** The result of a bare parse, to spread expected deviations over. */
const none: AiuiArgs = {
  tag: undefined,
  mcp: undefined,
  chrome: false,
  noChrome: false,
  browser: false,
  noBrowser: false,
  chromeProfile: undefined,
  chromeDataDir: undefined,
  passthrough: [],
};

describe("splitAiuiArgs", () => {
  it("forwards non-aiui args untouched", () => {
    expect(splitAiuiArgs(["--resume", "-p", "hello"])).toEqual({
      ...none,
      passthrough: ["--resume", "-p", "hello"],
    });
  });

  it("consumes --aiui-tag <value> and keeps the rest as passthrough", () => {
    expect(splitAiuiArgs(["--aiui-tag", "abc-123", "--resume"])).toEqual({
      ...none,
      tag: "abc-123",
      passthrough: ["--resume"],
    });
  });

  it("accepts the --aiui-tag=<value> form", () => {
    expect(splitAiuiArgs(["--resume", "--aiui-tag=xyz"])).toEqual({
      ...none,
      tag: "xyz",
      passthrough: ["--resume"],
    });
  });

  it("consumes --aiui-mcp <value> and keeps the rest as passthrough", () => {
    expect(splitAiuiArgs(["--aiui-mcp", "srv-1", "--host"])).toEqual({
      ...none,
      mcp: "srv-1",
      passthrough: ["--host"],
    });
  });

  it("accepts the --aiui-mcp=<value> form", () => {
    expect(splitAiuiArgs(["--host", "--aiui-mcp=srv-2"])).toEqual({
      ...none,
      mcp: "srv-2",
      passthrough: ["--host"],
    });
  });

  it("populates tag and mcp independently when both are given", () => {
    expect(splitAiuiArgs(["--aiui-tag", "t1", "--aiui-mcp", "m1", "--resume"])).toEqual({
      ...none,
      tag: "t1",
      mcp: "m1",
      passthrough: ["--resume"],
    });
  });

  it("throws when --aiui-mcp has no value", () => {
    expect(() => splitAiuiArgs(["--aiui-mcp"])).toThrow(/requires a non-empty value/);
    expect(() => splitAiuiArgs(["--aiui-mcp="])).toThrow(/requires a non-empty value/);
  });

  it("consumes --aiui-chrome and --aiui-no-chrome as boolean flags", () => {
    expect(splitAiuiArgs(["--aiui-chrome", "--resume"])).toEqual({
      ...none,
      chrome: true,
      passthrough: ["--resume"],
    });
    expect(splitAiuiArgs(["--aiui-no-chrome", "--resume"])).toEqual({
      ...none,
      noChrome: true,
      passthrough: ["--resume"],
    });
  });

  it("throws when a boolean chrome flag is given a value", () => {
    expect(() => splitAiuiArgs(["--aiui-chrome=1"])).toThrow(/takes no value/);
    expect(() => splitAiuiArgs(["--aiui-no-chrome=1"])).toThrow(/takes no value/);
  });

  it("throws when --aiui-chrome and --aiui-no-chrome are combined", () => {
    expect(() => splitAiuiArgs(["--aiui-chrome", "--aiui-no-chrome"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("consumes --aiui-browser and --aiui-no-browser as boolean flags", () => {
    expect(splitAiuiArgs(["--aiui-browser", "dev"])).toEqual({
      ...none,
      browser: true,
      passthrough: ["dev"],
    });
    expect(splitAiuiArgs(["--aiui-no-browser", "dev"])).toEqual({
      ...none,
      noBrowser: true,
      passthrough: ["dev"],
    });
  });

  it("throws when a boolean browser flag is given a value", () => {
    expect(() => splitAiuiArgs(["--aiui-browser=1"])).toThrow(/takes no value/);
    expect(() => splitAiuiArgs(["--aiui-no-browser=1"])).toThrow(/takes no value/);
  });

  it("throws when --aiui-browser and --aiui-no-browser are combined", () => {
    expect(() => splitAiuiArgs(["--aiui-browser", "--aiui-no-browser"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("keeps --aiui-browser distinct from --aiui-browser-url", () => {
    // The names share a prefix; matching is on the exact flag, so the value
    // flag must not trip the boolean's "takes no value" error (or vice versa).
    expect(splitAiuiArgs(["--aiui-browser", "--aiui-browser-url", "http://x:1"])).toEqual({
      ...none,
      browser: true,
      browserUrl: "http://x:1",
    });
  });

  it("consumes --aiui-chrome-profile in both forms", () => {
    expect(splitAiuiArgs(["--aiui-chrome-profile", "scratch", "--resume"])).toEqual({
      ...none,
      chromeProfile: "scratch",
      passthrough: ["--resume"],
    });
    expect(splitAiuiArgs(["--aiui-chrome-profile=scratch"])).toEqual({
      ...none,
      chromeProfile: "scratch",
    });
  });

  it("consumes --aiui-chrome-data-dir in both forms", () => {
    expect(splitAiuiArgs(["--aiui-chrome-data-dir", "/tmp/profile", "--resume"])).toEqual({
      ...none,
      chromeDataDir: "/tmp/profile",
      passthrough: ["--resume"],
    });
    expect(splitAiuiArgs(["--aiui-chrome-data-dir=/tmp/profile"])).toEqual({
      ...none,
      chromeDataDir: "/tmp/profile",
    });
  });

  it("throws when a chrome value flag has no value", () => {
    expect(() => splitAiuiArgs(["--aiui-chrome-profile"])).toThrow(/requires a non-empty value/);
    expect(() => splitAiuiArgs(["--aiui-chrome-data-dir="])).toThrow(/requires a non-empty value/);
  });

  it("throws when a profile and an explicit data dir are combined", () => {
    expect(() =>
      splitAiuiArgs(["--aiui-chrome-profile", "a", "--aiui-chrome-data-dir", "/tmp/b"]),
    ).toThrow(/mutually exclusive/);
  });

  it("consumes --aiui-browser-url in both forms", () => {
    expect(splitAiuiArgs(["--aiui-browser-url", "http://127.0.0.1:9222", "--resume"])).toEqual({
      ...none,
      browserUrl: "http://127.0.0.1:9222",
      passthrough: ["--resume"],
    });
    expect(splitAiuiArgs(["--aiui-browser-url=http://127.0.0.1:9222"]).browserUrl).toBe(
      "http://127.0.0.1:9222",
    );
    expect(() => splitAiuiArgs(["--aiui-browser-url"])).toThrow(/requires a non-empty value/);
  });

  it("rejects --aiui-browser-url combined with local-browser identity flags", () => {
    expect(() =>
      splitAiuiArgs(["--aiui-browser-url", "http://x:1", "--aiui-chrome-profile", "p"]),
    ).toThrow(/managed elsewhere/);
    expect(() =>
      splitAiuiArgs(["--aiui-browser-url", "http://x:1", "--aiui-chrome-data-dir", "/d"]),
    ).toThrow(/managed elsewhere/);
  });

  it("consumes --aiui-bind in both forms", () => {
    expect(splitAiuiArgs(["--aiui-bind", "host", "--resume"])).toEqual({
      ...none,
      bind: "host",
      passthrough: ["--resume"],
    });
    expect(splitAiuiArgs(["--aiui-bind=loopback"])).toEqual({
      ...none,
      bind: "loopback",
    });
  });

  it("rejects an --aiui-bind value that isn't loopback or host", () => {
    expect(() => splitAiuiArgs(["--aiui-bind", "0.0.0.0"])).toThrow(/loopback, host/);
    expect(() => splitAiuiArgs(["--aiui-bind"])).toThrow(/loopback, host/);
  });

  it("preserves passthrough order around the aiui flag", () => {
    expect(splitAiuiArgs(["a", "--aiui-tag", "t", "b", "c"]).passthrough).toEqual(["a", "b", "c"]);
  });

  it("throws when --aiui-tag has no value", () => {
    expect(() => splitAiuiArgs(["--aiui-tag"])).toThrow(/requires a non-empty value/);
    expect(() => splitAiuiArgs(["--aiui-tag="])).toThrow(/requires a non-empty value/);
  });

  it("throws on an unknown aiui option instead of forwarding it", () => {
    expect(() => splitAiuiArgs(["--aiui-bogus"])).toThrow(/unknown aiui option: --aiui-bogus/);
  });
});

describe("infoFlag", () => {
  it("detects standalone help and version flags in either form", () => {
    expect(infoFlag(["--help"])).toBe("help");
    expect(infoFlag(["-h"])).toBe("help");
    expect(infoFlag(["--resume", "--version"])).toBe("version");
    expect(infoFlag(["-v"])).toBe("version");
  });

  it("prefers help when both appear", () => {
    expect(infoFlag(["--version", "--help"])).toBe("help");
  });

  it("ignores flag values that merely contain the text", () => {
    expect(infoFlag(["-p", "explain --help to me"])).toBeUndefined();
    expect(infoFlag(["--model", "--version-ish"])).toBeUndefined();
    expect(infoFlag([])).toBeUndefined();
  });
});
