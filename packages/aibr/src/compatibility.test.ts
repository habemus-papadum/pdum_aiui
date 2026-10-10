import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { fixture } from "../test/helpers.ts";
import { buildAgentPlan, findExecutable, mcpEntry, temporaryMcpEntry } from "./agents.ts";
import { ensureBrowser, processIdentity, stopBrowser } from "./browser.ts";
import { cdp, probeEndpoint } from "./cdp.ts";
import { defaultConfig } from "./config.ts";
import { createProfile } from "./profiles.ts";
import { writeJson } from "./storage.ts";

const exec = promisify(execFile);

it.runIf(!!process.env.AIBR_TEST_BROWSER)(
  "temporary MCP sessions own separate browsers and remove their data on EOF and SIGTERM",
  async () => {
    const f = await fixture();
    const temporaryRoot = join(f.root, "mcp-temp");
    await mkdir(temporaryRoot);
    const server = createServer((_req, res) => res.end("<title>aibr isolated test</title>"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP port");
    const url = `http://127.0.0.1:${address.port}`;
    const children: Array<ReturnType<typeof spawn>> = [];
    const clients: Array<ReturnType<typeof rpc>> = [];
    const browserPids: number[] = [];
    try {
      const entry = await temporaryMcpEntry(process.env.AIBR_TEST_BROWSER ?? "", true);
      for (let i = 0; i < 2; i++) {
        const child = spawn(entry.command, entry.args, {
          env: {
            ...process.env,
            TMPDIR: temporaryRoot,
            TMP: temporaryRoot,
            TEMP: temporaryRoot,
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        child.stderr?.resume();
        const client = rpc(child);
        clients.push(client);
        await client.request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "aibr-test", version: "1.0.0" },
        });
        client.notify("notifications/initialized");
        // Browser startup is lazy: initialization alone does not create another profile.
        expect(
          (await readdir(temporaryRoot)).filter((n) =>
            n.startsWith("puppeteer_dev_chrome_profile-"),
          ),
        ).toHaveLength(i);
        const page = await client.request("tools/call", { name: "new_page", arguments: { url } });
        expect(page.error).toBeUndefined();
        expect((page.result as { isError?: boolean }).isError).not.toBe(true);
        const pageText = (page.result as { content: Array<{ text?: string }> }).content
          .map((part) => part.text ?? "")
          .join("\n");
        const pageLine = pageText.split("\n").find((line) => line.includes(url));
        const pageId = Number(pageLine?.match(/\d+/)?.[0]);
        expect(Number.isInteger(pageId), pageText).toBe(true);
        const result = await client.request("tools/call", {
          name: "evaluate_script",
          arguments: {
            pageId,
            function:
              i === 0
                ? '() => { document.cookie = "aibr_temp=first; path=/"; return document.cookie; }'
                : "() => document.cookie",
          },
        });
        expect((result.result as { isError?: boolean }).isError, JSON.stringify(result)).not.toBe(
          true,
        );
        if (i === 0) expect(JSON.stringify(result)).toContain("aibr_temp=first");
        else expect(JSON.stringify(result)).not.toContain("aibr_temp=first");
      }
      expect(
        (await readdir(temporaryRoot)).filter((n) => n.startsWith("puppeteer_dev_chrome_profile-")),
      ).toHaveLength(2);
      const ps = (await exec("/bin/ps", ["-axo", "pid=,command="])).stdout;
      const browserLines = ps
        .split("\n")
        .filter(
          (line) =>
            line.includes(temporaryRoot) &&
            line.includes("--remote-debugging-pipe") &&
            !line.includes("--type="),
        );
      expect(browserLines).toHaveLength(2);
      for (const line of browserLines) {
        expect(line).toContain("--headless");
        expect(line).toContain("--auto-accept-camera-and-microphone-capture");
        expect(line).not.toContain("--remote-debugging-port");
        browserPids.push(Number(line.trim().split(/\s+/)[0]));
      }
      const firstExited = once(children[0], "exit");
      children[0].stdin?.end();
      await firstExited;
      expect(
        (await readdir(temporaryRoot)).filter((n) => n.startsWith("puppeteer_dev_chrome_profile-")),
      ).toHaveLength(1);
      const stillOpen = await clients[1].request("tools/call", {
        name: "list_pages",
        arguments: {},
      });
      expect((stillOpen.result as { isError?: boolean }).isError).not.toBe(true);
      const secondExited = once(children[1], "exit");
      children[1].kill("SIGTERM");
      await secondExited;
      expect(
        (await readdir(temporaryRoot)).filter((n) => n.startsWith("puppeteer_dev_chrome_profile-")),
      ).toHaveLength(0);
      for (const pid of browserPids) expect(await processIdentity(pid)).toBeUndefined();
    } finally {
      for (const client of clients) client.close();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.cleanup();
    }
  },
  45_000,
);

function rpc(child: ReturnType<typeof spawn>) {
  if (!child.stdin || !child.stdout) throw new Error("RPC needs pipes");
  const input = child.stdin;
  const pending = new Map<string | number, (value: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const data = JSON.parse(line);
    const key = data.id ?? data.response?.request_id;
    pending.get(key)?.(data);
  });
  let id = 0;
  return {
    async request(method: string, params = {}, control = false): Promise<Record<string, unknown>> {
      const key = control ? String(++id) : ++id;
      const value = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`RPC ${method} timed out`));
        }, 15_000);
        pending.set(key, (reply) => {
          clearTimeout(timer);
          pending.delete(key);
          resolve(reply);
        });
        input.write(
          `${JSON.stringify(control ? { type: "control_request", request_id: key, request: { subtype: method, ...params } } : { jsonrpc: "2.0", id: key, method, params })}\n`,
        );
      });
      return value;
    },
    notify(method: string) {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    close() {
      lines.close();
      child.kill("SIGTERM");
    },
  };
}

it.runIf(process.env.AIBR_TEST_AGENTS === "1")(
  "Codex replaces a complete earlier server entry without retaining its environment",
  async () => {
    const config = defaultConfig();
    config.serverName = "aibr_compat_probe";
    const executable = await findExecutable("codex");
    const plan = buildAgentPlan(
      "codex",
      executable,
      { command: "/bin/true", args: ["chosen"] },
      config,
      ["mcp", "get", config.serverName, "--json"],
    );
    const { stdout } = await exec(executable, [
      "-c",
      `mcp_servers.${config.serverName}={command="/bin/false",args=["old"],env={OLD="old"},enabled=false}`,
      ...plan.args,
    ]);
    const server = JSON.parse(stdout);
    expect(server.enabled).toBe(true);
    expect(server.transport.args).toEqual(["chosen"]);
    expect(server.transport.env).toBeNull();
  },
);

it.runIf(process.env.AIBR_TEST_AGENTS === "1")(
  "Claude overrides a same-name user MCP server while preserving unrelated servers, without a model request",
  async () => {
    const f = await fixture();
    const configDir = join(f.root, "claude-config");
    await mkdir(configDir);
    const log = join(f.root, "started.log");
    const script = fileURLToPath(new URL("../test/fake-mcp.mjs", import.meta.url));
    const entry = (tag: string) => ({ command: process.execPath, args: [script, tag, log] });
    await writeJson(join(configDir, ".claude.json"), {
      mcpServers: { "chrome-devtools": entry("old"), unrelated: entry("unrelated") },
    });
    const executable = await findExecutable("claude");
    const plan = buildAgentPlan("claude", executable, entry("chosen"), defaultConfig(), [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      '{"disableAllHooks":true}',
    ]);
    const child = spawn(executable, plan.args, {
      cwd: f.root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const client = rpc(child);
    try {
      await client.request("initialize", {}, true);
      let status: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        status = await client.request("mcp_status", {}, true);
        let started = "";
        try {
          started = await readFile(log, "utf8");
        } catch {
          /* Not connected yet. */
        }
        if (started.includes("chosen") && started.includes("unrelated")) {
          expect(started.split("\n")).not.toContain("old");
          return;
        }
        await delay(100);
      }
      throw new Error(`MCP overrides were not observed: ${JSON.stringify(status)} ${stderr}`);
    } finally {
      client.close();
      await once(child, "exit");
      await f.cleanup();
    }
  },
  30_000,
);

it.runIf(!!process.env.AIBR_TEST_BROWSER).each([undefined, 0])(
  "real Chrome keeps cookies and survives two MCP clients (debugPort=%s)",
  async (debugPort) => {
    const f = await fixture();
    const { dir } = await createProfile(f.p, "real", {
      browser: { executable: process.env.AIBR_TEST_BROWSER ?? "" },
      headless: true,
      debugPort,
    });
    const clients: Array<ReturnType<typeof rpc>> = [];
    try {
      const connection = await ensureBrowser(f.p, dir);
      await cdp(connection.wsEndpoint, "Storage.setCookies", {
        cookies: [
          {
            name: "aibr_test",
            value: "persist",
            url: "https://example.test",
            expires: Date.now() / 1000 + 3600,
          },
        ],
      });
      const entry = await mcpEntry(connection);
      for (let i = 0; i < 2; i++) {
        const child =
          i === 0
            ? spawn(entry.command, entry.args, { stdio: ["pipe", "pipe", "pipe"] })
            : f.spawn(["mcp", "--profile", "real"]);
        child.stderr.resume();
        const client = rpc(child);
        clients.push(client);
        const init = await client.request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "aibr-test", version: "1.0.0" },
        });
        expect(init.error).toBeUndefined();
        client.notify("notifications/initialized");
        const result = await client.request("tools/call", { name: "list_pages", arguments: {} });
        expect(result.error).toBeUndefined();
        expect((result.result as { isError?: boolean }).isError).not.toBe(true);
      }
      for (const client of clients) client.close();
      await probeEndpoint(connection.wsEndpoint);
      await stopBrowser(f.p, dir);
      const restarted = await ensureBrowser(f.p, dir);
      expect(restarted.wsEndpoint).not.toBe(connection.wsEndpoint);
      const cookies = await cdp(restarted.wsEndpoint, "Storage.getCookies");
      expect(cookies.cookies).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "aibr_test", value: "persist" })]),
      );
    } finally {
      for (const client of clients) client.close();
      try {
        await stopBrowser(f.p, dir);
      } catch {
        /* Startup may have failed. */
      }
      await f.cleanup();
    }
  },
  45_000,
);
