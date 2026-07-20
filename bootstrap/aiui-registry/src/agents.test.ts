import { describe, expect, it } from "vitest";
import { fetchAgents, parseClaudeAgents } from "./agents.ts";
import type { ClaudeAgent } from "./types.ts";

const agent: ClaudeAgent = {
  pid: 42,
  cwd: "/w",
  kind: "interactive",
  startedAt: 1_700_000_000_000,
  sessionId: "sess-1",
  name: "pdum-aiui-97",
  status: "idle",
};

describe("parseClaudeAgents", () => {
  it("parses well-formed agents and drops malformed items", () => {
    const raw = JSON.stringify([agent, { pid: "nope" }, null, 7]);
    expect(parseClaudeAgents(raw)).toEqual([agent]);
  });
  it("returns [] for non-JSON and non-arrays", () => {
    expect(parseClaudeAgents("garbage")).toEqual([]);
    expect(parseClaudeAgents('{"a":1}')).toEqual([]);
  });
});

describe("fetchAgents", () => {
  it("classifies an absent absolute path as claude-missing without spawning", () => {
    let spawned = 0;
    const result = fetchAgents("/definitely/not/here/claude", () => {
      spawned++;
      return "[]";
    });
    expect(result.status).toBe("claude-missing");
    expect(result.claudePath).toBe("/definitely/not/here/claude");
    expect(spawned).toBe(0);
  });

  it("classifies ENOENT from the spawn as claude-missing", () => {
    const result = fetchAgents("claude", () => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(result.status).toBe("claude-missing");
  });

  it("classifies other failures as error, with the message", () => {
    const result = fetchAgents("claude", () => {
      throw new Error("timed out");
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("timed out");
    expect(result.agents).toEqual([]);
  });

  it("returns ok with parsed agents on success", () => {
    const result = fetchAgents("claude", () => JSON.stringify([agent]));
    expect(result.status).toBe("ok");
    expect(result.agents).toEqual([agent]);
  });
});
