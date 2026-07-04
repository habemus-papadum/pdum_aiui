import { describe, expect, it } from "vitest";
import { splitAiuiArgs } from "./aiui-args";

describe("splitAiuiArgs", () => {
  it("forwards non-aiui args untouched", () => {
    expect(splitAiuiArgs(["--resume", "-p", "hello"])).toEqual({
      tag: undefined,
      mcp: undefined,
      noChrome: false,
      passthrough: ["--resume", "-p", "hello"],
    });
  });

  it("consumes --aiui-tag <value> and keeps the rest as passthrough", () => {
    expect(splitAiuiArgs(["--aiui-tag", "abc-123", "--resume"])).toEqual({
      tag: "abc-123",
      mcp: undefined,
      noChrome: false,
      passthrough: ["--resume"],
    });
  });

  it("accepts the --aiui-tag=<value> form", () => {
    expect(splitAiuiArgs(["--resume", "--aiui-tag=xyz"])).toEqual({
      tag: "xyz",
      mcp: undefined,
      noChrome: false,
      passthrough: ["--resume"],
    });
  });

  it("consumes --aiui-mcp <value> and keeps the rest as passthrough", () => {
    expect(splitAiuiArgs(["--aiui-mcp", "srv-1", "--host"])).toEqual({
      tag: undefined,
      mcp: "srv-1",
      noChrome: false,
      passthrough: ["--host"],
    });
  });

  it("accepts the --aiui-mcp=<value> form", () => {
    expect(splitAiuiArgs(["--host", "--aiui-mcp=srv-2"])).toEqual({
      tag: undefined,
      mcp: "srv-2",
      noChrome: false,
      passthrough: ["--host"],
    });
  });

  it("populates tag and mcp independently when both are given", () => {
    expect(splitAiuiArgs(["--aiui-tag", "t1", "--aiui-mcp", "m1", "--resume"])).toEqual({
      tag: "t1",
      mcp: "m1",
      noChrome: false,
      passthrough: ["--resume"],
    });
  });

  it("throws when --aiui-mcp has no value", () => {
    expect(() => splitAiuiArgs(["--aiui-mcp"])).toThrow(/requires a non-empty value/);
    expect(() => splitAiuiArgs(["--aiui-mcp="])).toThrow(/requires a non-empty value/);
  });

  it("consumes --aiui-no-chrome as a boolean flag", () => {
    expect(splitAiuiArgs(["--aiui-no-chrome", "--resume"])).toEqual({
      tag: undefined,
      mcp: undefined,
      noChrome: true,
      passthrough: ["--resume"],
    });
  });

  it("throws when --aiui-no-chrome is given a value", () => {
    expect(() => splitAiuiArgs(["--aiui-no-chrome=1"])).toThrow(/takes no value/);
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
