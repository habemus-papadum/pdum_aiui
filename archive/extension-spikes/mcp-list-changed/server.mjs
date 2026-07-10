#!/usr/bin/env node
// M3 probe: a dependency-free stdio MCP server whose tool list CHANGES.
//
// Starts with one tool (probe_alpha). After the first successful tools/call of
// probe_alpha it "flips": probe_beta joins the tool list and (unless
// LISTCHANGED=no) a notifications/tools/list_changed is emitted. Every wire
// message, both directions, is appended to a JSONL log (LOG env) with
// timestamps — that log is the ground truth for what the client actually did.
//
// Env:
//   LOG          path to the JSONL wire log (default ./wire-log.jsonl)
//   STATE        path to a flip marker file; if it exists at startup the server
//                starts already-flipped (lets a *fresh* client process see the
//                post-flip world, e.g. a `claude --continue` run)
//   LISTCHANGED  "no" to flip silently (control: does the client ever re-list
//                without being told?)
//   FLIP_DELAY_MS  delay between the alpha call response and the flip+notify
//                (default 500 — after the response is on the wire, mid-turn)

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import process from "node:process";

const LOG = process.env.LOG ?? new URL("./wire-log.jsonl", import.meta.url).pathname;
const STATE = process.env.STATE;
const NOTIFY = process.env.LISTCHANGED !== "no";
const FLIP_DELAY_MS = Number(process.env.FLIP_DELAY_MS ?? 500);

let flipped = STATE !== undefined && existsSync(STATE);

function logLine(dir, msg) {
  try {
    appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, dir, msg })}\n`);
  } catch {}
}

function send(msg) {
  logLine("send", msg);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const ALPHA = {
  name: "probe_alpha",
  description: "Returns the alpha secret. Always available.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const BETA = {
  name: "probe_beta",
  description: "Returns the beta secret. Appears only after probe_alpha has been called once.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function tools() {
  return flipped ? [ALPHA, BETA] : [ALPHA];
}

function flip() {
  if (flipped) return;
  flipped = true;
  if (STATE) {
    try {
      writeFileSync(STATE, new Date().toISOString());
    } catch {}
  }
  logLine("note", { event: "flipped", willNotify: NOTIFY });
  if (NOTIFY) {
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "listchanged-probe", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return; // notifications: no response
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: tools() } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "probe_alpha") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ALPHA-42" }] } });
      setTimeout(flip, FLIP_DELAY_MS);
      return;
    }
    if (name === "probe_beta" && flipped) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "BETA-99" }] } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Unknown tool: ${name} (flipped=${flipped})` },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logLine("recv-unparseable", line.slice(0, 200));
      continue;
    }
    logLine("recv", msg);
    try {
      handle(msg);
    } catch (e) {
      logLine("note", { event: "handler-error", error: String(e) });
    }
  }
});
process.stdin.on("end", () => {
  logLine("note", { event: "stdin-end" });
  process.exit(0);
});
logLine("note", { event: "started", flipped, notify: NOTIFY });
