import { describe, expect, it, vi } from "vitest";
import type { RunningServer } from "./registry";
import { selectMcpServer, serverLabel } from "./select";

// The interactive widget, mocked so the auto-pick rules are testable. Servers
// arrive ENRICHED — resolvedName is computed by the listing, not here.
vi.mock("@inquirer/prompts", () => ({ select: vi.fn() }));

function server(overrides: Partial<RunningServer>): RunningServer {
  return {
    schema: 2,
    tag: "t",
    pid: 1,
    ppid: 100,
    port: 4000,
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    kind: "channel",
    resolvedName: "pid 100",
    file: "/x.json",
    ...overrides,
  };
}

describe("serverLabel", () => {
  it("shows the resolved name, cwd, and port", () => {
    expect(serverLabel(server({ resolvedName: "pdum-aiui-97", port: 4321 }))).toBe(
      "pdum-aiui-97  ·  /repo  ·  port 4321",
    );
  });

  it("always marks debug servers", () => {
    expect(serverLabel(server({ kind: "debug", resolvedName: "aiui debug" }))).toBe(
      "aiui debug  ·  /repo  ·  port 4000  ·  debug",
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
    const debug = server({ tag: "wb", kind: "debug", resolvedName: "aiui debug" });
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
