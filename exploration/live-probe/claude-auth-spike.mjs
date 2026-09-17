// Minimal: does query() authenticate on this machine without ANTHROPIC_API_KEY?
import { query } from "@anthropic-ai/claude-agent-sdk";

const t0 = Date.now();
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID") delete env[k];
}
try {
  for await (const m of query({
    prompt: "Reply with exactly the word: pong",
    options: {
      maxTurns: 1,
      env,
      permissionMode: "bypassPermissions",
      allowedTools: [],
      model: "claude-haiku-4-5-20251001",
    },
  })) {
    const t = ((Date.now() - t0) / 1000).toFixed(2);
    if (m.type === "system")
      console.log(
        `+${t}s system/${m.subtype} model=${m.model ?? "?"} session=${m.session_id ?? "?"} apiKeySource=${m.apiKeySource ?? "?"}`,
      );
    else if (m.type === "assistant")
      console.log(`+${t}s assistant:`, JSON.stringify(m.message.content).slice(0, 200));
    else if (m.type === "result")
      console.log(
        `+${t}s result/${m.subtype} cost=$${m.total_cost_usd} turns=${m.num_turns} text=${JSON.stringify(m.result ?? "").slice(0, 100)}`,
      );
    else console.log(`+${t}s ${m.type}`);
  }
} catch (e) {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
}
