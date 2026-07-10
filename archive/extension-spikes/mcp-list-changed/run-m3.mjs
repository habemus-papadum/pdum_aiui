#!/usr/bin/env node
// M3 driver: runs a real `claude` CLI against the listchanged-probe server and
// reports what the client did. Three runs:
//
//   A  one process, two turns (stream-json input). Turn 1 calls probe_alpha
//      (server flips + notifies mid-session); turn 2 asks for probe_beta.
//      → Distinguishes mid-turn vs turn-boundary refresh inside ONE process.
//   B  fresh `claude -p` process with the server already flipped (STATE file)
//      → sanity: a fresh connection lists both tools.
//   C  like A but LISTCHANGED=no (server flips silently)
//      → control: does the client ever re-list without a notification?
//
// The JSONL wire logs (wire-a.jsonl / wire-b.jsonl / wire-c.jsonl) are the
// ground truth; this script prints a digest of each.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "server.mjs");
const MODEL = process.env.M3_MODEL ?? "haiku";

const cleanEnv = { ...process.env };
delete cleanEnv.CLAUDECODE; // we spawn claude from inside a claude session
delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
// An inherited API key overrides the user's claude.ai login and (here) doesn't
// authenticate — the first run failed every turn with "Invalid API key".
delete cleanEnv.ANTHROPIC_API_KEY;
delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
delete cleanEnv.ANTHROPIC_BASE_URL;

function mcpConfig(log, state, listchanged) {
  return JSON.stringify({
    mcpServers: {
      probe: {
        command: "node",
        args: [server],
        env: {
          LOG: join(here, log),
          ...(state ? { STATE: join(here, state) } : {}),
          ...(listchanged === false ? { LISTCHANGED: "no" } : {}),
        },
      },
    },
  });
}

function digest(logPath) {
  if (!existsSync(logPath)) return { error: "no log written" };
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const out = [];
  for (const { t, pid, dir, msg } of lines) {
    const time = t.slice(11, 23);
    if (dir === "recv" && msg.method === "tools/list") out.push(`${time} pid${pid} <- tools/list (id ${msg.id})`);
    if (dir === "recv" && msg.method === "tools/call") out.push(`${time} pid${pid} <- tools/call ${msg.params?.name}`);
    if (dir === "recv" && msg.method === "initialize") out.push(`${time} pid${pid} <- initialize (client ${msg.params?.clientInfo?.name} ${msg.params?.clientInfo?.version})`);
    if (dir === "send" && msg.method === "notifications/tools/list_changed") out.push(`${time} pid${pid} -> LIST_CHANGED notification`);
    if (dir === "send" && msg.error) out.push(`${time} pid${pid} -> ERROR ${JSON.stringify(msg.error.message)}`);
    if (dir === "note") out.push(`${time} pid${pid} .. ${JSON.stringify(msg)}`);
  }
  return out;
}

function streamJsonUser(text) {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/** Run one multi-turn stream-json session; resolves with collected output events. */
function runStreaming({ label, config, turns, turnTimeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", config,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      "--model", MODEL,
    ];
    console.log(`\n=== run ${label}: claude ${args.slice(0, 6).join(" ")} …`);
    const child = spawn("claude", args, { env: cleanEnv, cwd: here, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let buf = "";
    let turnIdx = 0;
    let timer;

    const sendNext = () => {
      if (turnIdx >= turns.length) {
        child.stdin.end();
        return;
      }
      const text = turns[turnIdx++];
      console.log(`--- turn ${turnIdx}: ${text.slice(0, 80)}…`);
      child.stdin.write(streamJsonUser(text));
      timer = setTimeout(() => {
        console.log(`!!! turn ${turnIdx} timed out after ${turnTimeoutMs}ms`);
        child.kill();
      }, turnTimeoutMs);
    };

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        events.push(ev);
        if (ev.type === "assistant") {
          const texts = (ev.message?.content ?? []).map((c) => c.type === "text" ? c.text : `[${c.type}${c.name ? ":" + c.name : ""}]`).join(" ");
          console.log(`  assistant: ${texts.slice(0, 200)}`);
        }
        if (ev.type === "result") {
          clearTimeout(timer);
          console.log(`  [turn result: ${ev.subtype ?? "ok"}]`);
          // small gap so the server's post-call flip/notification lands before the next turn
          setTimeout(sendNext, 3_000);
        }
      }
    });
    child.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) console.log(`  [stderr] ${s.slice(0, 300)}`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      console.log(`=== run ${label} exited ${code}`);
      resolve(events);
    });
    sendNext();
  });
}

function runOnce({ label, config, prompt }) {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--mcp-config", config,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      "--model", MODEL,
    ];
    console.log(`\n=== run ${label}: claude -p …`);
    const child = spawn("claude", args, { env: cleanEnv, cwd: here, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => console.log(`  [stderr] ${String(d).trim().slice(0, 300)}`));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      console.log(`  output: ${out.trim().slice(0, 400)}`);
      console.log(`=== run ${label} exited ${code}`);
      resolve(out);
    });
  });
}

// ── the three runs ────────────────────────────────────────────────────────────
for (const f of ["wire-a.jsonl", "wire-b.jsonl", "wire-c.jsonl", "wire-d.jsonl", "state.flip"]) {
  rmSync(join(here, f), { force: true });
}

const TURN1 =
  "Call the MCP tool probe_alpha exactly once and report its value. Then STOP — do not call anything else this turn.";
const TURN2 =
  "Now call the MCP tool probe_beta and report its value. If probe_beta is not available to you, reply exactly: BETA NOT AVAILABLE. Do not call any other tool.";

console.log(`claude version: (spawning with model ${MODEL})`);

// Run A: notification ON, single process, two turns.
await runStreaming({ label: "A (list_changed on)", config: mcpConfig("wire-a.jsonl", "state.flip"), turns: [TURN1, TURN2] });

// Run B: fresh process, server starts flipped via STATE file.
await runOnce({ label: "B (fresh process, pre-flipped)", config: mcpConfig("wire-b.jsonl", "state.flip"), prompt: TURN2 });

// Run C: control — flip happens but NO notification is sent.
rmSync(join(here, "state.flip"), { force: true });
await runStreaming({ label: "C (silent flip control)", config: mcpConfig("wire-c.jsonl", null, false), turns: [TURN1, TURN2] });

// Run D: MID-TURN — one turn that calls alpha then immediately beta. The flip
// notification lands while the model is still inside the turn; does the fresh
// tool become callable without a turn boundary?
rmSync(join(here, "state.flip"), { force: true });
await runStreaming({
  label: "D (mid-turn)",
  config: mcpConfig("wire-d.jsonl", null),
  turns: [
    "Call the MCP tool probe_alpha and note its value. A new MCP tool named probe_beta becomes available a moment after probe_alpha returns. In this SAME turn, call probe_beta and report both values. If calling probe_beta fails, try it once more, then report exactly: BETA NOT CALLABLE MID-TURN.",
  ],
});

console.log("\n\n################ WIRE DIGESTS ################");
for (const f of ["wire-a.jsonl", "wire-b.jsonl", "wire-c.jsonl", "wire-d.jsonl"]) {
  console.log(`\n--- ${f}`);
  for (const line of digest(join(here, f))) console.log(line);
}
