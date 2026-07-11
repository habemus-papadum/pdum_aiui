import { describe, expect, it } from "vitest";
import { channelLabel, updateRecent } from "./channel";

describe("updateRecent", () => {
  it("prepends, dedupes, caps", () => {
    expect(updateRecent([], 4700)).toEqual([4700]);
    expect(updateRecent([4700, 4800], 4800)).toEqual([4800, 4700]);
    expect(updateRecent([1, 2, 3, 4, 5, 6], 7)).toEqual([7, 1, 2, 3, 4, 5]);
  });
});

describe("channelLabel", () => {
  it("prefers name, then cwd basename, then pid; marks debug servers", () => {
    expect(channelLabel({ port: 4711, name: "gallery" })).toBe("gallery :4711");
    expect(channelLabel({ port: 4711, cwd: "/Users/x/src/demo" })).toBe("demo :4711");
    expect(channelLabel({ port: 4711, pid: 42 })).toBe("pid 42 :4711");
    expect(channelLabel({ port: 4711, name: "s", debug: true })).toBe(
      "s :4711 (debug — no session)",
    );
  });
});
