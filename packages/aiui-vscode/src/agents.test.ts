import { describe, expect, it } from "vitest";
import { parseAgentNames } from "./agents";

describe("parseAgentNames", () => {
  it("maps pid → session name, skipping malformed rows", () => {
    const raw = JSON.stringify([
      { pid: 100, name: "pdum-aiui-97", cwd: "/repo", kind: "interactive" },
      { pid: "not-a-pid", name: "bad" },
      { name: "no-pid" },
      null,
      { pid: 200, name: "other-session" },
    ]);
    const names = parseAgentNames(raw);
    expect([...names.entries()]).toEqual([
      [100, "pdum-aiui-97"],
      [200, "other-session"],
    ]);
  });

  it("returns an empty map for junk", () => {
    expect(parseAgentNames("{not json").size).toBe(0);
    expect(parseAgentNames('{"pid":1}').size).toBe(0);
  });
});
