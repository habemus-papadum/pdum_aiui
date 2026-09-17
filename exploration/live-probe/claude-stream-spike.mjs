// Streaming-input spike: one long-lived query() as a voice backend.
// Questions: are follow-up messages queued or interleaved with a running task?
// What does interrupt() do to the running turn? Does a message after interrupt work?
// Does ending the input iterable end the query? Which messages carry the text?
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const t0 = Date.now();
const T = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID") delete env[k];
}
const said = [];
const live = createSdkMcpServer({
  name: "live",
  version: "0.0.0",
  tools: [
    tool(
      "say",
      "Speak text aloud to the user. The user hears ONLY what you pass here.",
      { text: z.string(), delegation_id: z.string().optional() },
      async ({ text, delegation_id }) => {
        console.log(`${T()} 🔊 SAY[${delegation_id ?? "-"}]: ${text}`);
        said.push(text);
        return { content: [{ type: "text", text: "spoken" }] };
      },
    ),
  ],
});
const queue = [];
let notify;
let ended = false;
const input = {
  [Symbol.asyncIterator]() {
    return {
      async next() {
        while (queue.length === 0 && !ended) {
          await new Promise((r) => {
            notify = r;
          });
        }
        if (queue.length === 0) return { value: undefined, done: true };
        return { value: queue.shift(), done: false };
      },
    };
  },
};
const push = (text) => {
  console.log(`${T()} → push: ${text.slice(0, 70)}`);
  queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  notify?.();
};
const q = query({
  prompt: input,
  options: {
    model: "claude-haiku-4-5-20251001",
    cwd: process.cwd(),
    env,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash", "mcp__live__say"],
    mcpServers: { live },
    includePartialMessages: true,
    maxTurns: 40,
    systemPrompt:
      "You are the reasoning backend of a voice assistant. The user cannot read text; ONLY what you pass to live.say is heard. Each user message carries a delegation id in <delegation id=...>; pass it as delegation_id. Follow the steps literally.",
  },
});
push(
  `<delegation id="d1">Say "starting", then run the shell command "sleep 5", then say "halfway", then run "sleep 5", then say "finished d1".</delegation>`,
);
setTimeout(
  () => push(`<delegation id="d2">Quick one: what is 2 plus 2? Say the answer.</delegation>`),
  4000,
);
setTimeout(
  () => push(`<delegation id="d3">Run "sleep 40" then say "d3 done".</delegation>`),
  17000,
);
setTimeout(async () => {
  console.log(`${T()} → interrupt()`);
  const r = await q.interrupt();
  console.log(`${T()} interrupt returned ${JSON.stringify(r)}`);
}, 25000);
setTimeout(() => push(`<delegation id="d4">Say "after interrupt".</delegation>`), 29000);
setTimeout(() => {
  console.log(`${T()} → end input`);
  ended = true;
  notify?.();
}, 38000);
let textBuf = "";
for await (const m of q) {
  if (m.type === "stream_event") {
    const e = m.event;
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") textBuf += e.delta.text;
    else if (e.type === "content_block_start")
      console.log(`${T()} ▶ block ${e.content_block?.type} ${e.content_block?.name ?? ""}`);
    else if (e.type === "message_stop") {
      if (textBuf) console.log(`${T()} (streamed text) ${textBuf.slice(0, 100)}`);
      textBuf = "";
    }
    continue;
  }
  if (m.type === "assistant") {
    console.log(
      `${T()} assistant: ${m.message.content.map((b) => (b.type === "text" ? `text(${b.text.slice(0, 50)})` : b.type === "tool_use" ? `tool_use(${b.name})` : b.type)).join(" ")}`,
    );
    continue;
  }
  if (m.type === "user") {
    const c = m.message.content;
    console.log(
      `${T()} user(${m.isSynthetic ? "synthetic" : "real"}): ${typeof c === "string" ? c.slice(0, 60) : c.map((b) => (b.type === "tool_result" ? `tool_result(${String(b.content?.[0]?.text ?? b.content ?? "").slice(0, 40)})` : b.type)).join(",")}`,
    );
    continue;
  }
  if (m.type === "result") {
    console.log(
      `${T()} ■ RESULT/${m.subtype} turns=${m.num_turns} cost=$${m.total_cost_usd?.toFixed(3)} text=${JSON.stringify((m.result ?? "").slice(0, 80))}`,
    );
    continue;
  }
  if (m.type === "system") {
    console.log(
      `${T()} system/${m.subtype} model=${m.model} mcp=${JSON.stringify(m.mcp_servers)} mcpTools=${(m.tools || []).filter((t) => t.startsWith("mcp__")).join(",")}`,
    );
    continue;
  }
  console.log(`${T()} ${m.type}${m.subtype ? `/${m.subtype}` : ""}`);
}
console.log(`${T()} query ended; said=${JSON.stringify(said)}`);
