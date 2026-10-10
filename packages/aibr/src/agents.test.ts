import { describe, expect, it } from "vitest";
import {
  buildAgentPlan,
  defaultAgentArgs,
  mcpEntry,
  validateAgentArgs,
  YOLO_FLAGS,
} from "./agents.ts";
import { defaultConfig } from "./config.ts";

const entry = {
  command: "/node path/node",
  args: ["/mcp path/server.js", "--ws-endpoint", "ws://127.0.0.1:9222/devtools/browser/id"],
};

describe("agent configuration", () => {
  it("places Claude's variadic MCP option after the prompt and keeps one name", () => {
    const plan = buildAgentPlan("claude", "/claude", entry, defaultConfig(), [
      "-p",
      "a prompt with spaces",
    ]);
    expect(plan.args.slice(0, 3)).toEqual(["-p", "a prompt with spaces", "--mcp-config"]);
    expect(Object.keys(JSON.parse(plan.args.at(-1) ?? "").mcpServers)).toEqual(["chrome-devtools"]);
    expect(plan.args).not.toContain("--strict-mcp-config");
  });
  it("respects explicit prompt terminators", () => {
    const plan = buildAgentPlan("claude", "/claude", entry, defaultConfig(), [
      "-p",
      "--",
      "--literal",
    ]);
    expect(plan.args.slice(-2)).toEqual(["--", "--literal"]);
    expect(plan.args[1]).toBe("--mcp-config");
  });
  it("overrides the entire Codex server entry with native TOML", () => {
    const plan = buildAgentPlan("codex", "/codex", entry, defaultConfig(), ["resume", "--last"]);
    expect(plan.args[1]).toContain("mcp_servers.chrome-devtools={");
    expect(plan.args[1]).toContain('"enabled" = true');
    expect(plan.args[1]).toContain('"required" = true');
    expect(plan.args.slice(-2)).toEqual(["resume", "--last"]);
  });
  it("supports saved arguments and exact per-agent YOLO flags, off by default", () => {
    const config = defaultConfig();
    expect(defaultAgentArgs(config, "codex")).toEqual([]);
    config.agents.claude = { args: ["--model", "example"], yolo: true };
    config.agents.codex.yolo = true;
    expect(defaultAgentArgs(config, "claude")).toEqual(["--model", "example", YOLO_FLAGS.claude]);
    expect(defaultAgentArgs(config, "codex")).toEqual([YOLO_FLAGS.codex]);
    expect(defaultAgentArgs(config, "claude", { yolo: false })).toEqual(["--model", "example"]);
    expect(defaultAgentArgs(config, "claude", { defaultArgs: false })).toEqual([]);
    expect(defaultAgentArgs(config, "claude", { defaultArgs: false, yolo: true })).toEqual([
      YOLO_FLAGS.claude,
    ]);
  });
  it("preserves arbitrary argument boundaries and puts native overrides after defaults", () => {
    const config = defaultConfig();
    config.agents.codex.args = ["--model", "old"];
    const args = ["--model", "new", "literal $(do not run) `this` 'and quotes'"];
    expect(buildAgentPlan("codex", "/codex", entry, config, args).args.slice(-3)).toEqual(args);
  });
  it.each([
    ["-c", "mcp_servers={}"],
    ['--config=mcp_servers."chrome-devtools".enabled=false'],
    ["-cmcp_servers.chrome-devtools.args=[]"],
  ])("rejects conflicting Codex config %j", (...args) => {
    expect(() => validateAgentArgs("codex", args, "chrome-devtools")).toThrow("aibr owns");
  });
  it("allows unrelated configuration but rejects alternative Claude MCP configs", () => {
    expect(() =>
      validateAgentArgs("codex", ["-c", "model='example'"], "chrome-devtools"),
    ).not.toThrow();
    expect(() =>
      validateAgentArgs("claude", ["--mcp-config", "other.json"], "chrome-devtools"),
    ).toThrow("aibr owns");
  });
  it("resolves the pinned MCP dependency without npx or network access", async () => {
    const value = await mcpEntry({
      endpoint: "http://127.0.0.1:9222",
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/id",
      browserVersion: "test",
    });
    expect(value.command).toBe(process.execPath);
    expect(value.args[0]).toContain("chrome-devtools-mcp");
    expect(value.args).toContain("--ws-endpoint");
    expect(value.args).not.toContain("--user-data-dir");
    const auto = await mcpEntry({
      endpoint: "",
      wsEndpoint: "",
      browserVersion: "",
      autoConnectDir: "/profile path",
    });
    expect(auto.args).toContain("--auto-connect");
    expect(auto.args).toContain("/profile path");
  });
});
