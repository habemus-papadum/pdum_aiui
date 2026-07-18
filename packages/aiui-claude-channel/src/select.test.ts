import { describe, expect, it, vi } from "vitest";
import { agentsByPid, parseClaudeAgents } from "./agents";
import type { RunningServer } from "./registry";
import { selectMcpServer, serverLabel } from "./select";

// The interactive widget, mocked so the auto-pick rules are testable; the
// agent listing is stubbed empty so no test shells out to `claude`.
vi.mock("@inquirer/prompts", () => ({ select: vi.fn() }));
vi.mock("./agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents")>()),
  listClaudeAgents: () => [],
}));

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

  it("prefers the entry's own name, and always marks debug servers", () => {
    expect(serverLabel(server({ ppid: 555, name: "aiui debug", debug: true }), agents)).toBe(
      "aiui debug  ·  /repo  ·  port 4000  ·  debug",
    );
    // The name wins even over a known session; debug marks without a name too.
    expect(serverLabel(server({ ppid: 100, name: "custom" }), agents)).toBe(
      "custom  ·  /repo  ·  port 4000",
    );
    expect(serverLabel(server({ ppid: 555, debug: true }), agents)).toBe(
      "pid 555  ·  /repo  ·  port 4000  ·  debug",
    );
  });
});

describe("selectMcpServer auto-pick", () => {
  it("returns a lone real server without prompting", async () => {
    const { select } = await import("@inquirer/prompts");
    vi.mocked(select).mockClear();
    const real = server({ tag: "real" });
    await expect(selectMcpServer([real])).resolves.toBe(real);
    expect(select).not.toHaveBeenCalled();
  });

  it("still prompts for a lone debug server — never a silent default", async () => {
    const { select } = await import("@inquirer/prompts");
    const debug = server({ tag: "wb", name: "aiui debug", debug: true });
    vi.mocked(select).mockClear();
    vi.mocked(select).mockResolvedValueOnce(debug);
    await expect(selectMcpServer([debug])).resolves.toBe(debug);
    expect(select).toHaveBeenCalledOnce();
    const { choices } = vi.mocked(select).mock.calls[0][0] as unknown as {
      choices: Array<{ name: string }>;
    };
    expect(choices[0].name).toContain("debug");
  });
});
