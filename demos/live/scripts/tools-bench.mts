/**
 * tools-bench.mts — judge a delegation BACKEND on an app's REAL page tools,
 * without a voice model or a microphone. The app's tool document comes from
 * the channel's ledger (what `page_tools_list` shows), every call executes IN
 * THE PAGE over CDP (so the page's own call log attributes it, with the
 * backend's caller tag), and the backend is aiui-live's delegator exactly as
 * the relay would run it.
 *
 *   pnpm tools-bench responses "How many M≥7 quakes were there in 2011?"
 *   pnpm tools-bench claude "Which year had the most M≥8 quakes?"
 *
 * Needs: an `aiui claude` session (the channel at CHANNEL, the session
 * browser at CDP), the intent client at /intent/ relaying the app's tab, and
 * the app open in that browser at PAGE. The responses backend needs
 * OPENAI_API_KEY; claude needs a logged-in Claude Code.
 */
import {
  type DelegationRequest,
  type LiveTool,
  responsesDelegator,
} from "@habemus-papadum/aiui-live";
import { claudeDelegator } from "@habemus-papadum/aiui-live/claude";

const [which = "responses", ...rest] = process.argv.slice(2);
const questions = rest.length > 0 ? rest : ["What does this app show, in one sentence?"];
const CHANNEL = process.env.CHANNEL ?? "http://127.0.0.1:52047";
const CDP = process.env.CDP ?? "http://127.0.0.1:61526";
const PAGE = process.env.PAGE ?? "http://127.0.0.1:5199/";

// 1. The app's tool document, as the channel has it.
interface Registration {
  ns: string;
  url?: string;
  brief?: string;
  tools: Array<{
    name: string;
    description: string;
    usage?: string;
    kind?: "read" | "write";
    inputSchema?: Record<string, unknown>;
  }>;
}
const ledger = (await (await fetch(`${CHANNEL}/debug/api/page-tools`)).json()) as {
  registrations: Registration[];
};
const reg = [...ledger.registrations].reverse().find((r) => r.url === PAGE);
if (reg === undefined) {
  console.error(`no page-tools registration for ${PAGE} — is the intent client relaying it?`);
  process.exit(2);
}
console.log(
  `app: ${reg.ns} — ${reg.tools.length} tools; brief: ${reg.brief !== undefined ? `${reg.brief.length} chars` : "NONE"}`,
);

// 2. CDP into the page: Runtime.evaluate, nothing else.
const targets = (await (await fetch(`${CDP}/json/list`)).json()) as Array<{
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}>;
const target = targets.find((t) => t.type === "page" && t.url.startsWith(PAGE));
if (target === undefined) {
  console.error(`no page target for ${PAGE} in the session browser`);
  process.exit(2);
}
const sock = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  sock.onopen = () => resolve();
  sock.onerror = () => reject(new Error("CDP socket failed"));
});
let seq = 0;
interface CdpReply {
  id: number;
  error?: { message: string };
  result?: { result?: { value?: unknown }; exceptionDetails?: { text: string } };
}
const pending = new Map<number, (m: CdpReply) => void>();
sock.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data)) as CdpReply;
  const cb = pending.get(m.id);
  if (cb !== undefined) {
    pending.delete(m.id);
    cb(m);
  }
};
const evaluate = (expression: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => {
      if (m.error !== undefined) return reject(new Error(m.error.message));
      const d = m.result?.exceptionDetails;
      if (d !== undefined) return reject(new Error(d.text));
      resolve(m.result?.result?.value);
    });
    sock.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
const callInPage = (ns: string, name: string, args: unknown, meta: unknown): Promise<unknown> =>
  evaluate(
    `(async () => { const r = await window.__AIUI__.tools.call(${JSON.stringify(ns)}, ${JSON.stringify(name)}, ${JSON.stringify(args ?? {})}, ${JSON.stringify(meta)}); return JSON.parse(JSON.stringify(r ?? null)); })()`,
  );

// 3. The tools, executing in the page with the backend's own caller tag.
const order: string[] = [];
const tools: LiveTool[] = reg.tools.map((t) => ({
  name: t.name,
  description: t.description,
  ...(t.usage !== undefined ? { usage: t.usage } : {}),
  ...(t.kind !== undefined ? { kind: t.kind } : {}),
  parameters: t.inputSchema ?? { type: "object", properties: {} },
  execute: async (args, context) => {
    const t0 = Date.now();
    order.push(t.name);
    const value = await callInPage(reg.ns, t.name, args, {
      caller: context?.caller ?? "live:bench",
      ref: context?.ref,
    });
    console.log(
      `  🔧 ${t.name}(${JSON.stringify(args)}) ${Date.now() - t0} ms → ${JSON.stringify(value).slice(0, 220)}`,
    );
    return value;
  },
}));

// 4. The backend, as the relay runs it.
const key = process.env.OPENAI_API_KEY ?? "";
const delegator =
  which === "claude"
    ? claudeDelegator({ cwd: process.cwd(), log: (line) => console.log(`  · ${line}`) })
    : responsesDelegator({
        key,
        app: `${reg.ns}, an aiui app the user is looking at in a browser tab`,
        effort: "low",
        model: process.env.MODEL ?? "gpt-5.4-mini",
      });
console.log(`backend: ${delegator.describe?.() ?? delegator.name}`);
let n = 0;
for (const text of questions) {
  n += 1;
  order.length = 0;
  const req: DelegationRequest = {
    id: `bench-${n}`,
    text,
    transcript: { user: [], assistant: [] },
    tools,
    ...(reg.brief !== undefined ? { brief: reg.brief } : {}),
    signal: new AbortController().signal,
    say: async (t) => {
      console.log(`  🔮 say: ${t}`);
    },
    note: async (t) => {
      console.log(`  📝 note: ${t}`);
    },
    steer: async (t) => {
      console.log(`  🧭 steer: ${t}`);
    },
    log: (line) => console.log(`  · ${line}`),
  };
  console.log(`\n🗣  "${text}"`);
  const t0 = Date.now();
  try {
    const out = await delegator.handle(req);
    console.log(`  ✅ ${Date.now() - t0} ms → ${out ?? "(spoken during handling)"}`);
  } catch (err) {
    console.log(`  ❌ ${(err as Error).message}`);
  }
  console.log(`  call order: ${order.join(" → ") || "(no tool calls)"}`);
}
const calls = await evaluate(
  `JSON.stringify(window.__AIUI__.tools.calls().filter((c) => String(c.caller).startsWith("live:")).map((c) => ({ seq: c.seq, tool: c.tool, caller: c.caller, ref: c.ref, ok: c.ok, ms: c.ms })))`,
);
console.log(`\npage call log (live:*): ${String(calls)}`);
delegator.dispose?.();
sock.close();
process.exit(0);
