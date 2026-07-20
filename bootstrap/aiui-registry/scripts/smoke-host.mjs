#!/usr/bin/env node
/**
 * Smoke test for the COMPILED native-messaging host: spawn the real binary
 * against a fabricated cache root, drive framed requests over stdio, and
 * assert the responses — including the loud claude-missing path. This is what
 * keeps the compiled artifact honest in CI (the unit tests never leave Node).
 *
 *   node scripts/smoke-host.mjs dist-bin/aiui-registry-host-<platform>
 *
 * Requires `pnpm build` first (frame codecs are imported from dist/).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeNativeFrames, encodeNativeFrame } from "../dist/host.js";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node scripts/smoke-host.mjs <path-to-host-binary>");
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

/** Spawn the host once, send every request, collect one response per request. */
function queryHost(env, requests) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("host did not answer within 15s"));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      const { messages } = decodeNativeFrames(Buffer.concat(chunks));
      if (messages.length >= requests.length) {
        clearTimeout(timer);
        child.stdin.end();
        resolvePromise(messages);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    for (const request of requests) {
      child.stdin.write(encodeNativeFrame(request));
    }
  });
}

/** A fresh cache root pre-seeded with one live channel entry. */
function makeCacheRoot(ppid) {
  const root = mkdtempSync(join(tmpdir(), "aiui-registry-smoke-"));
  mkdirSync(join(root, "mcp"), { recursive: true });
  const entry = {
    schema: 2,
    tag: "smoke",
    pid: process.pid, // this script is alive for the host's liveness probe
    ppid,
    port: 4242,
    cwd: "/",
    startedAt: new Date().toISOString(),
    kind: "channel",
  };
  writeFileSync(join(root, "mcp", `${process.pid}.json`), JSON.stringify(entry, null, 2));
  return root;
}

const SESSION_PID = 424242;
const roots = [];
try {
  // Scenario 1 — enriched listing through a (fake) claude binary.
  {
    const root = makeCacheRoot(SESSION_PID);
    roots.push(root);
    const fakeClaude = join(root, "claude.sh");
    const agents = JSON.stringify([
      {
        pid: SESSION_PID,
        cwd: "/",
        kind: "interactive",
        startedAt: 0,
        sessionId: "sess-1",
        name: "smoke-session",
        status: "idle",
      },
    ]);
    writeFileSync(fakeClaude, `#!/bin/sh\necho '${agents}'\n`);
    chmodSync(fakeClaude, 0o755);

    const [ping, list] = await queryHost({ AIUI_CACHE: root, AIUI_CLAUDE_BIN: fakeClaude }, [
      { cmd: "ping" },
      { cmd: "listChannels" },
    ]);
    console.log("scenario 1: enriched listing");
    check("ping ok + protocol 2", ping?.ok === true && ping?.protocol === 2, ping);
    check("list ok + protocol 2", list?.ok === true && list?.protocol === 2, list);
    check("agents status ok", list?.agents?.status === "ok", list?.agents);
    check("one channel", list?.channels?.length === 1, list?.channels);
    const ch = list?.channels?.[0];
    check("session joined", ch?.session?.sessionId === "sess-1", ch);
    check("resolvedName is the session name", ch?.resolvedName === "smoke-session", ch);
  }

  // Scenario 2 — claude missing: loud status, channels still listed.
  {
    const root = makeCacheRoot(SESSION_PID);
    roots.push(root);
    const [list] = await queryHost(
      { AIUI_CACHE: root, AIUI_CLAUDE_BIN: join(root, "no-such-claude") },
      [{ cmd: "listChannels" }],
    );
    console.log("scenario 2: claude missing (loud, partial)");
    check("list ok", list?.ok === true, list);
    check("agents status claude-missing", list?.agents?.status === "claude-missing", list?.agents);
    check("channels still listed", list?.channels?.length === 1, list?.channels);
    check(
      "resolvedName falls back to pid",
      list?.channels?.[0]?.resolvedName === `pid ${SESSION_PID}`,
      list?.channels?.[0],
    );
  }

  // Scenario 3 — a dead entry is pruned from the listing.
  {
    const root = makeCacheRoot(SESSION_PID);
    roots.push(root);
    const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadEntry = {
      schema: 2,
      tag: "dead",
      pid: gone.pid,
      ppid: 1,
      port: 4243,
      cwd: "/",
      startedAt: new Date().toISOString(),
      kind: "channel",
    };
    writeFileSync(join(root, "mcp", `${gone.pid}.json`), JSON.stringify(deadEntry));
    const [list] = await queryHost(
      { AIUI_CACHE: root, AIUI_CLAUDE_BIN: join(root, "no-such-claude") },
      [{ cmd: "listChannels" }],
    );
    console.log("scenario 3: dead entry pruned");
    check("only the live channel remains", list?.channels?.length === 1, list?.channels);
    check("the live one is ours", list?.channels?.[0]?.tag === "smoke", list?.channels?.[0]);
  }
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`\n${failures} smoke check(s) FAILED`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
