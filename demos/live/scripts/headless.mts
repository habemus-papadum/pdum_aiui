/**
 * headless.mts — the demo without a browser or a microphone: a real
 * gpt-live-1 session over WebSocket, a synthesized voice as the user, and
 * the backend of your choice — including Claude Code, run IN THIS PROCESS
 * with this demo as its working directory (exactly what the dev server's
 * relay does for the page). The assistant's audio lands in out/ as a WAV.
 *
 *   pnpm headless scripted                     # the wire alone
 *   pnpm headless responses "set the frequency to four"
 *   pnpm headless claude "why does the trace look jagged at low samples?"
 *
 * Needs OPENAI_API_KEY in the environment (direnv) and, for claude, a
 * logged-in Claude Code on this machine.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Delegator,
  LiveSession,
  type LiveTool,
  responsesDelegator,
  scriptedDelegator,
} from "@habemus-papadum/aiui-live";
import { claudeDelegator } from "@habemus-papadum/aiui-live/claude";
import {
  PCM_RATE,
  scriptedMic,
  synthesize,
  wavSink,
  webSocketTransport,
} from "@habemus-papadum/aiui-live/node";
import { APP_BLURB, LIVE_SLOTS } from "../src/live/prompt";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");
mkdirSync(out, { recursive: true });
const key = process.env.OPENAI_API_KEY ?? "";
if (key === "") {
  console.error("no OPENAI_API_KEY");
  process.exit(2);
}

const [which = "scripted", ...rest] = process.argv.slice(2);
const utterances = rest.length > 0 ? rest : ["Please set the frequency to four hertz."];

// A stand-in for the page's control surface: the same tool names the app
// projects, over a plain object, so a backend can be judged on its calls.
const app = { freq: 1, damping: 0.15, amp: 1, samples: 256, kicks: 0 };
const tools: LiveTool[] = [
  ...(["freq", "damping", "amp", "samples"] as const).map(
    (name): LiveTool => ({
      name: `set_live_${name}`,
      description: `Set ${name} (${name === "freq" ? "0.1–5 Hz" : name === "damping" ? "0–1" : name === "amp" ? "0.1–2" : "8–1024 points"}). Returns the value applied.`,
      parameters: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      execute: (args) => {
        app[name] = Number(args.value);
        console.log(`  🔧 ${name} ← ${app[name]}`);
        return { applied: app[name] };
      },
    }),
  ),
  {
    name: "live_kick",
    description: "Kick the oscillator (a quarter-turn phase impulse).",
    parameters: { type: "object", properties: {} },
    execute: () => {
      app.kicks += 1;
      return { kicks: app.kicks };
    },
  },
  {
    name: "report",
    description: "The app's current settings.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ ...app }),
  },
];

function pickDelegator(): Delegator {
  switch (which) {
    case "scripted":
      return scriptedDelegator({ delayMs: 1500, reply: (req) => `Done. I heard: ${req.text}.` });
    case "responses":
      return responsesDelegator({ key, app: APP_BLURB, effort: "low", model: "gpt-5.4-mini" });
    case "claude":
      return claudeDelegator({ cwd: root, log: (line) => console.log(`  ${line}`) });
    default:
      throw new Error(`unknown backend ${which} (scripted | responses | claude)`);
  }
}

const mic = scriptedMic({ rate: PCM_RATE });
const sink = wavSink(PCM_RATE);
const session = new LiveSession({
  transport: webSocketTransport({ key, input: mic, onOutputAudio: (pcm) => sink.push(pcm) }),
  config: { instructions: LIVE_SLOTS, audio: { format: { type: "audio/pcm", rate: PCM_RATE } } },
  delegator: pickDelegator(),
  tools,
  idle: false,
  progress: { afterMs: 9000 },
});
let lastAssistantT = 0;
const until = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return pred();
};
session.onLedger((entry) => {
  if (entry.kind === "transcript" && entry.summary.startsWith("assistant:")) {
    lastAssistantT = entry.t;
  }
  if (entry.kind === "transcript" || entry.kind === "usage") {
    return;
  }
  console.log(
    `+${(entry.t / 1000).toFixed(2)}s ${entry.dir === "in" ? "←" : entry.dir === "out" ? "→" : "·"} ${entry.kind.padEnd(10)} ${entry.summary}`,
  );
});
session.onState((state) => {
  if (state.captions.assistant !== lastCaption) {
    lastCaption = state.captions.assistant;
    console.log(`  🔮 ${lastCaption}`);
  }
});
let lastCaption = "";

const t0 = Date.now();
await session.start();
console.log(
  `session ${session.state().sessionId} started in ${Date.now() - t0} ms; backend = ${session.currentDelegator()?.describe?.() ?? which}`,
);
await new Promise((resolve) => setTimeout(resolve, 800));
for (const text of utterances) {
  const pcm = await synthesize(text, { key, cacheDir: join(out, "tts") });
  console.log(`\n🗣  "${text}" (${(pcm.length / (PCM_RATE * 2)).toFixed(1)} s of audio)`);
  await mic.say(pcm);
  // Wait for the ticket this utterance opens, for it to close, then for the
  // assistant to fall silent (no transcript fragment for 3 s). Output AUDIO
  // never pauses — silence is streamed too — so only transcripts mean speech.
  const before = session.tasks().length;
  const opened = await until(() => session.tasks().length > before, 30_000);
  if (!opened) {
    console.log("  (no delegation arrived within 30 s)");
    continue;
  }
  const task = session.tasks().at(-1);
  await until(() => task?.status !== "open", 240_000);
  await until(() => session.now() - lastAssistantT > 3000, 40_000);
}
await new Promise((resolve) => setTimeout(resolve, 2500));
await session.close();
session.currentDelegator()?.dispose?.();
const wav = join(out, `${which}.wav`);
sink.write(wav);
console.log(
  `\nclosed (${session.state().closeReason}); ${session.state().seconds}s billed; ${sink.seconds().toFixed(1)} s of assistant audio → ${wav}`,
);
for (const task of session.tasks()) {
  console.log(
    `task #${task.seq} ${task.status}: "${task.request}" — first append +${task.firstAppendT === undefined ? "?" : task.firstAppendT - task.createdAt} ms, spoken +${task.firstSpokenT === undefined || task.firstAppendT === undefined ? "?" : task.firstSpokenT - task.firstAppendT} ms, total ${task.doneAt === undefined ? "?" : task.doneAt - task.createdAt} ms`,
  );
}
console.log(`app state: ${JSON.stringify(app)}`);
process.exit(0);
