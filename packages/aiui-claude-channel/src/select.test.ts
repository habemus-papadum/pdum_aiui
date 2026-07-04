import { describe, expect, it } from "vitest";
import { agentsByPid, parseClaudeAgents } from "./agents";
import type { RunningServer } from "./registry";
import { serverLabel } from "./select";

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

const agents = agentsByPid(
  parseClaudeAgents(
    JSON.stringify([
      {
        pid: 100,
        cwd: "/repo",
        kind: "interactive",
        startedAt: 1,
        sessionId: "s-1",
        name: "pdum-aiui-97",
        status: "idle",
      },
    ]),
  ),
);

describe("serverLabel", () => {
  it("uses the Claude session name when the ppid matches an agent", () => {
    expect(serverLabel(server({ ppid: 100, port: 4321 }), agents)).toBe(
      "pdum-aiui-97  ·  /repo  ·  port 4321",
    );
  });

  it("falls back to the parent pid when there's no matching session", () => {
    expect(serverLabel(server({ ppid: 555 }), agents)).toBe("pid 555  ·  /repo  ·  port 4000");
  });
});
