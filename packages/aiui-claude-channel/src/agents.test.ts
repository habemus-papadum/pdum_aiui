import { describe, expect, it } from "vitest";
import { agentsByPid, enrichServers, parseClaudeAgents } from "./agents";
import type { RunningServer } from "./registry";

const AGENT_JSON = JSON.stringify([
  {
    pid: 100,
    cwd: "/repo",
    kind: "interactive",
    startedAt: 111,
    sessionId: "s-1",
    name: "pdum-aiui-97",
    status: "idle",
  },
  {
    pid: 200,
    cwd: "/other",
    kind: "interactive",
    startedAt: 222,
    sessionId: "s-2",
    name: "pdum-aiui-4a",
    status: "busy",
  },
]);

function server(overrides: Partial<RunningServer>): RunningServer {
  return {
    tag: "t",
    pid: 1,
    ppid: 100,
    port: 4000,
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    file: "/x.json",
    ...overrides,
  };
}

describe("parseClaudeAgents", () => {
  it("parses well-formed agents", () => {
    const agents = parseClaudeAgents(AGENT_JSON);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ pid: 100, name: "pdum-aiui-97", sessionId: "s-1" });
  });

  it("returns [] for non-JSON or a non-array", () => {
    expect(parseClaudeAgents("{not json")).toEqual([]);
    expect(parseClaudeAgents('{"pid":1}')).toEqual([]);
  });

  it("skips malformed entries but keeps the good ones", () => {
    const raw = JSON.stringify([
      { pid: 100, cwd: "/r", kind: "i", startedAt: 1, sessionId: "s", name: "n", status: "idle" },
      { pid: "bad" },
      null,
      5,
    ]);
    expect(parseClaudeAgents(raw)).toHaveLength(1);
  });
});

describe("agentsByPid", () => {
  it("indexes agents by pid", () => {
    const map = agentsByPid(parseClaudeAgents(AGENT_JSON));
    expect(map.get(200)?.name).toBe("pdum-aiui-4a");
    expect(map.get(999)).toBeUndefined();
  });
});

describe("enrichServers", () => {
  it("attaches the session matched by ppid, and leaves unmatched servers bare", () => {
    const agents = parseClaudeAgents(AGENT_JSON);
    const [matched, unmatched] = enrichServers(
      [server({ ppid: 100 }), server({ ppid: 999 })],
      agents,
    );
    expect(matched.session).toMatchObject({
      name: "pdum-aiui-97",
      sessionId: "s-1",
      status: "idle",
    });
    expect(unmatched.session).toBeUndefined();
  });
});
