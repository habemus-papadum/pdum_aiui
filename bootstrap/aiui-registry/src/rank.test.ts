import { describe, expect, it } from "vitest";
import { dirRank, sortServers } from "./rank.ts";

describe("dirRank", () => {
  it("ranks same dir 0, descendants by depth, outsiders Infinity", () => {
    expect(dirRank("/a/b", "/a/b")).toBe(0);
    expect(dirRank("/a/b", "/a/b/c")).toBe(1);
    expect(dirRank("/a/b", "/a/b/c/d")).toBe(2);
    expect(dirRank("/a/b", "/a")).toBe(Number.POSITIVE_INFINITY);
    expect(dirRank("/a/b", "/z")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("sortServers", () => {
  const s = (cwd: string, pid: number) => ({ cwd, pid });
  it("orders same-dir, then descendants shallowest-first, then the rest", () => {
    const sorted = sortServers("/a/b", [
      s("/z", 1),
      s("/a/b/c/d", 2),
      s("/a/b", 3),
      s("/a/b/c", 4),
    ]);
    expect(sorted.map((x) => x.pid)).toEqual([3, 4, 2, 1]);
  });
  it("alphabetises within a group and tiebreaks by pid", () => {
    const sorted = sortServers("/base", [s("/y", 9), s("/x", 5), s("/x", 3)]);
    expect(sorted.map((x) => x.pid)).toEqual([3, 5, 9]);
  });
  it("does not mutate its input", () => {
    const input = [s("/b", 2), s("/a", 1)];
    sortServers("/", input);
    expect(input.map((x) => x.pid)).toEqual([2, 1]);
  });
});
