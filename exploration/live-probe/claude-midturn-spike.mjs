// Mid-turn input spike (2026-10-10): what happens to a user message pushed
// WHILE a turn is running, in streaming-input mode?
//
//   node claude-midturn-spike.mjs A        # append: "...also tell me 17 + 25" at +AT s
//   node claude-midturn-spike.mjs B        # redirect: "stop after step 3, reply STOPPED"
//   node claude-midturn-spike.mjs C        # interrupt() then the redirect
//   node claude-midturn-spike.mjs Dnow     # redirect with priority "now"
//   node claude-midturn-spike.mjs Dnext    # redirect with priority "next" (the CLI default)
//   node claude-midturn-spike.mjs Dlater   # redirect with priority "later"
//
// env: SDK_DIR=<dir whose node_modules holds @anthropic-ai/claude-agent-sdk>
//      (default: this dir); MODEL (default "haiku"); AT (seconds after the
//      first push to inject, default 7); MSG=append|redirect (D variants only).
//
// Evidence recorded per run (out/claude-midturn-<variant>-<sdk>.jsonl):
//   - every SDK message with a timestamp (init, assistant blocks, user echoes,
//     results with user_message_uuid(s), unknown system subtypes);
//   - every `step` tool call (wall clock) — the turn's observable progress;
//   - a final `summary` record with the verdict.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const variant = process.argv[2] ?? "A";
if (!/^(A|B|C|Dnow|Dnext|Dlater)$/.test(variant)) {
  console.error(`unknown variant ${variant}`);
  process.exit(2);
}
const sdkDir = process.env.SDK_DIR ? resolve(process.env.SDK_DIR) : here;
const sdkPkg = join(sdkDir, "node_modules/@anthropic-ai/claude-agent-sdk");
const sdkVersion = JSON.parse(readFileSync(join(sdkPkg, "package.json"), "utf8")).version;
const { createSdkMcpServer, query, tool } = await import(
  pathToFileURL(join(sdkPkg, "sdk.mjs")).href
);
const AT = Number(process.env.AT ?? 7) * 1000;
const msgKind = process.env.MSG ?? (variant === "A" ? "append" : "redirect");

const t0 = Date.now();
const T = () => (Date.now() - t0) / 1000;
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });
const tag = process.env.TAG ? `-${process.env.TAG}` : "";
const logPath = join(outDir, `claude-midturn-${variant}${tag}-${sdkVersion}.jsonl`);
writeFileSync(logPath, "");
const log = (event) => {
  const rec = { t: Number(T().toFixed(2)), ...event };
  appendFileSync(logPath, `${JSON.stringify(rec)}\n`);
  const { t, kind, ...rest } = rec;
  console.log(`+${t.toFixed(2).padStart(6)}s ${kind} ${JSON.stringify(rest).slice(0, 220)}`);
};
log({ kind: "start", variant, sdkVersion, sdkDir, model: process.env.MODEL ?? "haiku", at: AT });

// A nested Claude Code session must not inherit the parent's identity.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined || k === "CLAUDECODE" || k === "CLAUDE_PID" || k.startsWith("CLAUDE_CODE_"))
    continue;
  env[k] = v;
}

const steps = [];
const probe = createSdkMcpServer({
  name: "probe",
  version: "0.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "step",
      "Record that step n is done.",
      { n: z.number() },
      async ({ n }) => {
        steps.push({ n, t: T() });
        log({ kind: "step", n });
        return { content: [{ type: "text", text: `step ${n} recorded` }] };
      },
      { alwaysLoad: true },
    ),
  ],
});

const inbox = [];
let wake;
let ended = false;
const input = {
  [Symbol.asyncIterator]() {
    return {
      async next() {
        while (inbox.length === 0 && !ended) {
          await new Promise((r) => {
            wake = r;
          });
        }
        const m = inbox.shift();
        return m === undefined ? { value: undefined, done: true } : { value: m, done: false };
      },
    };
  },
};
const pushed = [];
const push = (label, text, extra = {}) => {
  const uuid = randomUUID();
  inbox.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    ...extra,
  });
  pushed.push({ label, uuid, t: T(), ...extra });
  wake?.();
  log({ kind: "push", label, uuid, ...extra, text });
  return uuid;
};

const q = query({
  prompt: input,
  options: {
    model: process.env.MODEL ?? "haiku",
    cwd: here,
    env,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: ["Bash", "mcp__probe__step"],
    mcpServers: { probe },
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 20,
    includePartialMessages: false,
    systemPrompt:
      "You are a test harness. Follow the user's instructions literally and completely. Use only the Bash tool and the step tool.",
  },
});

const SLEEP = process.env.SLEEP ?? "3";
const TURN1 = `Do exactly this, nothing else: for n = 1..6, run the Bash command \`sleep ${SLEEP}\` and then call the \`step\` tool with n. Then reply with the single word DONE.`;
const APPEND =
  "Additional request: when you are finished with the steps, also tell me the value of 17 + 25.";
const REDIRECT = "Change of plan: stop after step 3 and reply STOPPED instead of DONE.";
const second = msgKind === "append" ? APPEND : REDIRECT;

const results = [];
let firstResultT;
let finished = false;
const finish = (why) => {
  if (finished) return;
  finished = true;
  log({ kind: "end-input", why });
  ended = true;
  wake?.();
  setTimeout(() => {
    log({ kind: "close", note: "query did not end on its own; close()" });
    q.close();
  }, 10_000).unref();
};
const hard = setTimeout(() => {
  log({ kind: "timeout", note: "120 s hard limit" });
  q.close();
  setTimeout(() => process.exit(3), 1000);
}, 120_000);
hard.unref();

push("turn1", TURN1);
setTimeout(async () => {
  if (variant === "A" || variant === "B") {
    push("second", second);
  } else if (variant === "C") {
    log({ kind: "interrupt()", note: "calling" });
    const receipt = await q.interrupt();
    log({ kind: "interrupt-receipt", receipt: receipt ?? null });
    push("second", second);
  } else {
    // ORIGIN=human stamps the message as a person's (origin.kind "human"), the
    // interactive "send now" shape; the SDK changelog (0.3.286) says a
    // PERSON's priority "now" joins the running turn instead of stopping it.
    const origin = process.env.ORIGIN ? { kind: process.env.ORIGIN } : undefined;
    push("second", second, { priority: variant.slice(1), ...(origin && { origin }) });
  }
}, AT);

const text = (c) =>
  typeof c === "string"
    ? c
    : c
        .map((b) =>
          b.type === "text"
            ? b.text
            : b.type === "tool_result"
              ? `tool_result(${String(b.content?.[0]?.text ?? b.content ?? "").slice(0, 60)})`
              : b.type,
        )
        .join(" | ");

const assistantTexts = [];
for await (const m of q) {
  if (m.type === "system") {
    if (m.subtype === "init") {
      log({
        kind: "init",
        model: m.model,
        cli: m.claude_code_version,
        capabilities: m.capabilities ?? null,
        apiKeySource: m.apiKeySource,
        mcpTools: (m.tools || []).filter((t) => t.startsWith("mcp__")),
      });
    } else {
      const { type, ...rest } = m;
      log({ kind: `system/${m.subtype}`, ...rest });
    }
    continue;
  }
  if (m.type === "assistant") {
    const blocks = m.message.content.map((b) =>
      b.type === "text"
        ? `text(${b.text.slice(0, 160)})`
        : b.type === "tool_use"
          ? `tool_use(${b.name} ${JSON.stringify(b.input).slice(0, 60)})`
          : b.type,
    );
    for (const b of m.message.content)
      if (b.type === "text") assistantTexts.push({ t: T(), text: b.text });
    log({
      kind: "assistant",
      blocks,
      user_message_uuid: m.user_message_uuid ?? null,
      parent_tool_use_id: m.parent_tool_use_id ?? null,
    });
    continue;
  }
  if (m.type === "user") {
    const c = m.message.content;
    const isToolResult = Array.isArray(c) && c.some((b) => b.type === "tool_result");
    log({
      kind: isToolResult ? "user/tool_result" : "user/echo",
      synthetic: m.isSynthetic ?? false,
      uuid: m.uuid ?? null,
      origin: m.origin ?? null,
      priority: m.priority ?? null,
      text: text(c).slice(0, 200),
    });
    continue;
  }
  if (m.type === "result") {
    results.push({ t: T(), subtype: m.subtype, result: m.result ?? null });
    if (firstResultT === undefined) firstResultT = T();
    log({
      kind: "result",
      subtype: m.subtype,
      num_turns: m.num_turns,
      duration_ms: m.duration_ms,
      queued_turn_count: m.queued_turn_count ?? null,
      user_message_uuid: m.user_message_uuid ?? null,
      user_message_uuids: m.user_message_uuids ?? null,
      errors: m.errors ?? null,
      result: (m.result ?? "").slice(0, 300),
    });
    if (results.length >= 2) finish("two results");
    else setTimeout(() => finish("no second result within 30 s of the first"), 30_000).unref();
    continue;
  }
  const { type, ...rest } = m;
  log({ kind: `other/${type}${m.subtype ? `/${m.subtype}` : ""}`, ...rest });
}
clearTimeout(hard);

// Verdict
const sec = pushed.find((p) => p.label === "second");
const mentions42 = (s) => /\b42\b|17\s*\+\s*25/.test(s);
const before = assistantTexts.filter((a) => firstResultT !== undefined && a.t < firstResultT);
const after = assistantTexts.filter((a) => firstResultT !== undefined && a.t >= firstResultT);
const stepsBefore = steps
  .filter((s) => firstResultT !== undefined && s.t < firstResultT)
  .map((s) => s.n);
const summary = {
  kind: "summary",
  variant,
  sdkVersion,
  msgKind,
  pushedSecondAt: sec?.t ?? null,
  priority: sec?.priority ?? null,
  firstResultT: firstResultT ?? null,
  results: results.map((r) => ({
    t: Number(r.t.toFixed(2)),
    subtype: r.subtype,
    result: (r.result ?? "").slice(0, 80),
  })),
  stepsBeforeFirstResult: stepsBefore,
  stepsAfterFirstResult: steps
    .filter((s) => firstResultT === undefined || s.t >= firstResultT)
    .map((s) => s.n),
  mentions42BeforeFirstResult: before.some((a) => mentions42(a.text)),
  mentions42AfterFirstResult: after.some((a) => mentions42(a.text)),
  stoppedBeforeFirstResult: before.some((a) => /STOPPED/.test(a.text)),
  stoppedAfterFirstResult: after.some((a) => /STOPPED/.test(a.text)),
};
log(summary);
console.log(`log: ${logPath}`);
process.exit(0);
