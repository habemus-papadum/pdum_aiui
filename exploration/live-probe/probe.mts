/**
 * live-probe.mts — hands-on measurement of GPT-Live (gpt-live-1) over the
 * primary WebSocket, with synthesized speech as the "user".
 *
 * Scenarios (argv): models | context | client | long | responses
 *   models     which Responses backend models a session.start accepts
 *   context    appends with delegation_id:null before any delegation; oversize append
 *   client     client delegation, fast reply (the oracle's tool-call shape)
 *   long       client delegation, 25 s "long think" with progress + a second
 *              utterance mid-task (overlapping delegations)
 *   responses  Responses delegation with a function tool; the full loop
 *
 *   sideband   attach a second socket by session id and answer from there
 *              (answered 404 for a WebSocket-primary session on 2026-09-15 —
 *              the docs scope the sideband to WebRTC/SIP sessions)
 *
 * Run (after `npm install` here): `npm run probe -- client long`
 * Needs OPENAI_API_KEY in the environment. Output (JSONL event logs + the
 * assistant's audio as WAV) lands in ./out/, gitignored.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const KEY = process.env.OPENAI_API_KEY ?? "";
if (KEY === "") {
  console.error("no OPENAI_API_KEY");
  process.exit(2);
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(join(OUT, "tts"), { recursive: true });

const RATE = 24000;
const CHUNK_MS = 100;
const CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000; // 4800

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── speech synthesis (cached) ────────────────────────────────────────────────

async function tts(text: string): Promise<Buffer> {
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const file = join(OUT, "tts", `${hash}.pcm`);
  if (existsSync(file)) {
    return readFileSync(file);
  }
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      response_format: "pcm",
    }),
  });
  if (!res.ok) {
    throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

// ── the probe session ────────────────────────────────────────────────────────

type Ev = Record<string, any>;

class Probe {
  ws!: WebSocket;
  t0 = 0;
  events: Array<{ t: number; ev: Ev }> = [];
  outAudio: Buffer[] = [];
  inText = "";
  outText = "";
  outSegments: Array<{ t: number; text: string; start_ms?: number; end_ms?: number }> = [];
  inSegments: Array<{ t: number; text: string; start_ms?: number; end_ms?: number }> = [];
  sessionId = "";
  closed = false;
  started = false;
  private queue: Buffer[] = [];
  private pumping = false;
  private pumpTimer: ReturnType<typeof setInterval> | undefined;
  /** ms of input audio sent so far — approximates the session timeline. */
  sentMs = 0;
  /** Observers of every incoming event (the hosted loop hangs off this). */
  hooks: Array<(ev: Ev, t: number) => void> = [];
  private logFile: string;
  private eventSeq = 0;

  constructor(readonly label: string) {
    this.logFile = join(OUT, `${label}.jsonl`);
    writeFileSync(this.logFile, "");
  }

  now(): number {
    return Date.now() - this.t0;
  }

  log(line: string): void {
    const stamp = `+${(this.now() / 1000).toFixed(3)}s`;
    console.log(`[${this.label}] ${stamp} ${line}`);
  }

  send(ev: Ev): string {
    const event_id = ev.event_id ?? `p_${++this.eventSeq}`;
    const full = { event_id, ...ev };
    this.ws.send(JSON.stringify(full));
    if (ev.type !== "session.input_audio.append") {
      this.log(`→ ${ev.type} ${summarize(full)}`);
      appendFileSync(this.logFile, `${JSON.stringify({ t: this.now(), dir: "out", ev: full })}\n`);
    }
    return event_id;
  }

  connect(session: Ev, startTimeoutMs = 15000): Promise<Ev> {
    return new Promise((resolve, reject) => {
      this.t0 = Date.now();
      this.ws = new WebSocket("wss://api.openai.com/v1/live/sessions", {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      const timer = setTimeout(() => reject(new Error("no session.started")), startTimeoutMs);
      this.ws.on("open", () => {
        this.log("socket open");
        this.send({ type: "session.start", event_id: "start", session });
      });
      this.ws.on("message", (data: Buffer) => {
        let ev: Ev;
        try {
          ev = JSON.parse(data.toString());
        } catch {
          this.log(`unparseable: ${data.toString().slice(0, 100)}`);
          return;
        }
        const t = this.now();
        this.events.push({ t, ev });
        if (ev.type !== "session.output_audio.delta") {
          appendFileSync(this.logFile, `${JSON.stringify({ t, dir: "in", ev })}\n`);
        }
        this.onEvent(ev);
        for (const hook of this.hooks) {
          hook(ev, t);
        }
        if (ev.type === "session.started") {
          clearTimeout(timer);
          this.started = true;
          this.sessionId = ev.session?.id ?? "";
          resolve(ev);
        } else if (ev.type === "error" && !this.started) {
          clearTimeout(timer);
          reject(new Error(`start error: ${JSON.stringify(ev.error)}`));
        }
      });
      this.ws.on("close", (code: number, reason: Buffer) => {
        this.log(`socket closed ${code} ${reason.toString()}`);
        this.stopPump();
        if (!this.started) {
          clearTimeout(timer);
          reject(new Error(`socket closed before start: ${code} ${reason.toString()}`));
        }
      });
      this.ws.on("error", (err: Error) => {
        this.log(`socket error ${err.message}`);
        if (!this.started) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private onEvent(ev: Ev): void {
    switch (ev.type) {
      case "session.output_audio.delta": {
        const buf = Buffer.from(ev.delta, "base64");
        if (this.outAudio.length === 0) {
          this.log(
            `← first output audio (${buf.length} bytes)${ev.start_ms !== undefined ? ` start_ms=${ev.start_ms}` : ""}`,
          );
        }
        this.outAudio.push(buf);
        return;
      }
      case "session.output_transcript.delta":
        this.outText += ev.delta;
        this.outSegments.push({
          t: this.now(),
          text: ev.delta,
          start_ms: ev.start_ms,
          end_ms: ev.end_ms,
        });
        this.log(`← assistant: "${ev.delta}" [${ev.start_ms}–${ev.end_ms}]`);
        return;
      case "session.input_transcript.delta":
        this.inText += ev.delta;
        this.inSegments.push({
          t: this.now(),
          text: ev.delta,
          start_ms: ev.start_ms,
          end_ms: ev.end_ms,
        });
        this.log(`← user: "${ev.delta}" [${ev.start_ms}–${ev.end_ms}]`);
        return;
      default:
        this.log(`← ${ev.type} ${summarize(ev)}`);
    }
  }

  /** Feed audio in real time: queued speech first, then silence. */
  startPump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    const silence = Buffer.alloc(CHUNK_BYTES);
    this.pumpTimer = setInterval(() => {
      if (!this.pumping || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const chunk = this.queue.shift() ?? silence;
      this.ws.send(
        JSON.stringify({ type: "session.input_audio.append", audio: chunk.toString("base64") }),
      );
      this.sentMs += CHUNK_MS;
    }, CHUNK_MS);
  }

  stopPump(): void {
    this.pumping = false;
    if (this.pumpTimer !== undefined) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
    }
  }

  /** Speak an utterance; resolves when its last chunk has been SENT. */
  async say(text: string): Promise<{ startMs: number; endMs: number; wallEnd: number }> {
    const pcm = await tts(text);
    const startMs = this.sentMs + this.queue.length * CHUNK_MS;
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      let chunk = pcm.subarray(i, i + CHUNK_BYTES);
      if (chunk.length < CHUNK_BYTES) {
        chunk = Buffer.concat([chunk, Buffer.alloc(CHUNK_BYTES - chunk.length)]);
      }
      this.queue.push(chunk);
    }
    const durMs = Math.ceil(pcm.length / CHUNK_BYTES) * CHUNK_MS;
    this.log(
      `user says (${(durMs / 1000).toFixed(1)}s of audio, session ${startMs}–${startMs + durMs}ms): "${text}"`,
    );
    // wait until the queue drains (the utterance has been fully sent)
    while (this.queue.length > 0) {
      await sleep(CHUNK_MS);
    }
    return { startMs, endMs: startMs + durMs, wallEnd: this.now() };
  }

  waitFor(
    pred: (ev: Ev, t: number) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<{ t: number; ev: Ev } | undefined> {
    const already = this.events.find((e) => pred(e.ev, e.t));
    if (already !== undefined) {
      return Promise.resolve(already);
    }
    return new Promise((resolve) => {
      const start = this.events.length;
      const timer = setInterval(() => {
        for (let i = start; i < this.events.length; i++) {
          const e = this.events[i];
          if (e !== undefined && pred(e.ev, e.t)) {
            clearInterval(timer);
            resolve(e);
            return;
          }
        }
        if (this.now() - t0 > timeoutMs) {
          clearInterval(timer);
          this.log(`⏱ timeout waiting for ${what}`);
          resolve(undefined);
        }
      }, 20);
      const t0 = this.now();
    });
  }

  async close(): Promise<Ev | undefined> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return undefined;
    }
    this.send({ type: "session.close", event_id: "close" });
    const closed = await this.waitFor((e) => e.type === "session.closed", 15000, "session.closed");
    this.stopPump();
    this.ws.close();
    const wav = join(OUT, `${this.label}.wav`);
    writeWav(wav, Buffer.concat(this.outAudio));
    this.log(
      `wrote ${wav} (${(Buffer.concat(this.outAudio).length / (RATE * 2)).toFixed(1)}s of assistant audio)`,
    );
    this.log(`USER TRANSCRIPT: ${this.inText}`);
    this.log(`ASSISTANT TRANSCRIPT: ${this.outText}`);
    return closed?.ev;
  }
}

function summarize(ev: Ev): string {
  const { type: _t, event_id: _e, ...rest } = ev;
  const s = JSON.stringify(rest);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

function writeWav(path: string, pcm: Buffer): void {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

// ── prompts ──────────────────────────────────────────────────────────────────

const LIVE_PROMPT = `You are the oracle, a calm, brief voice assistant embedded in a standing-wave visualizer app.
Speak plainly and briefly. No lists, no preamble.

Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- App control: read the app's current settings (frequency, amplitude, damping, waveform, grid) and change them.
- Analysis: investigate questions about the app's behavior by reading its code and state; this can take a while.

Delegate to the backend when:
- The user asks to change a setting or asks what a setting currently is.
- The user asks why the app behaves some way, or anything needing careful reasoning.

Do not delegate to the backend when:
- The user greets you or asks you to repeat a result already provided.

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting. If the backend says it is still working, tell the user briefly and wait.`;

const BACKEND_PROMPT = `## Voice conversation context
You are helping an assistant in a live voice conversation about a standing-wave visualizer app. Transcripts can contain mistakes. Use the latest context.

## Task instructions
Use the set_frequency tool to change the wave's frequency when asked. The app's current state: frequency 2 Hz, amplitude 0.8, damping 0.1, waveform sine, grid on.

## Return the result
Return the relevant facts in one short sentence, using the value the tool actually applied. Do not invent a successful action.`;

const audio = { format: { type: "audio/pcm", rate: RATE }, output: { voice: "marin" } };

// ── scenarios ────────────────────────────────────────────────────────────────

async function scenarioModels(): Promise<void> {
  for (const model of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.4-mini"]) {
    const p = new Probe(`models-${model}`);
    try {
      const started = await p.connect({
        model: "gpt-live-1",
        instructions: LIVE_PROMPT,
        audio,
        delegation: { type: "responses", responses: { model, instructions: BACKEND_PROMPT } },
      });
      p.log(
        `ACCEPTED backend ${model}; resolved delegation: ${JSON.stringify(started.session?.delegation)}`,
      );
      await p.close();
    } catch (err) {
      p.log(`REJECTED backend ${model}: ${(err as Error).message}`);
      try {
        p.ws.close();
      } catch {}
    }
  }
}

async function scenarioContext(): Promise<void> {
  const p = new Probe("context");
  const started = await p.connect({
    model: "gpt-live-1",
    instructions: LIVE_PROMPT,
    audio,
    delegation: { type: "client" },
  });
  p.log(`session.started in ${p.now()}ms; resolved session: ${JSON.stringify(started.session)}`);
  p.startPump();
  await sleep(500);
  // UI context before any delegation — the "Share UI context" pattern.
  const t1 = p.now();
  p.send({
    type: "session.thinking.append",
    event_id: "ctx_1",
    delegation_id: null,
    content:
      "The user is looking at the wave visualizer. Current settings: frequency 2 Hz, amplitude 0.8, waveform sine.",
  });
  const ack = await p.waitFor(
    (e) => e.client_event_id === "ctx_1" || e.error?.client_event_id === "ctx_1",
    10000,
    "ctx_1 ack",
  );
  p.log(
    `ctx_1 → ${ack?.ev.type} after ${ack === undefined ? "?" : ack.t - t1}ms; ${summarize(ack?.ev ?? {})}`,
  );
  // Oversize append (~900 tokens) → expect an error naming the limit.
  const big = Array.from(
    { length: 150 },
    (_, i) => `Fact number ${i}: the grid has ${200 + i} points.`,
  ).join(" ");
  p.send({
    type: "session.thinking.append",
    event_id: "ctx_big",
    delegation_id: null,
    content: big,
  });
  const bigAck = await p.waitFor(
    (e) => e.client_event_id === "ctx_big" || e.error?.client_event_id === "ctx_big",
    10000,
    "ctx_big ack/error",
  );
  p.log(`ctx_big → ${bigAck?.ev.type}: ${summarize(bigAck?.ev ?? {})}`);
  // A bogus delegation id → expect an error.
  p.send({
    type: "session.commentary.append",
    event_id: "bogus",
    delegation_id: "item_nope",
    content: "hi",
  });
  const bogus = await p.waitFor(
    (e) => e.client_event_id === "bogus" || e.error?.client_event_id === "bogus",
    10000,
    "bogus ack/error",
  );
  p.log(`bogus → ${bogus?.ev.type}: ${summarize(bogus?.ev ?? {})}`);
  // Now ask a question the context answers, WITHOUT delegation: does it use the thinking context?
  await p.say("What's the amplitude set to right now?");
  await p.waitFor(
    (e) => e.type === "session.output_transcript.delta" || e.type === "session.delegation.created",
    12000,
    "reply or delegation",
  );
  await sleep(6000);
  const closed = await p.close();
  p.log(`closed: ${JSON.stringify(closed?.usage)} reason=${closed?.reason}`);
}

async function scenarioClient(): Promise<void> {
  const p = new Probe("client");
  const tConnect = Date.now();
  await p.connect({
    model: "gpt-live-1",
    instructions: LIVE_PROMPT,
    audio,
    delegation: { type: "client" },
  });
  p.log(`session.started ${Date.now() - tConnect}ms after socket open`);
  p.startPump();
  await sleep(800);
  const said = await p.say("Please set the frequency to five hertz.");
  const d = await p.waitFor((e) => e.type === "session.delegation.created", 15000, "delegation");
  if (d === undefined) {
    await sleep(5000);
    await p.close();
    return;
  }
  p.log(
    `DELEGATION ${d.ev.delegation?.id} offset_ms=${d.ev.offset_ms}; arrived ${d.t - said.wallEnd}ms after the utterance finished sending (utterance ended at session ${said.endMs}ms)`,
  );
  // What does the model do between delegation and result? Let it sit 1.5 s.
  await sleep(1500);
  const tAppend = p.now();
  p.send({
    type: "session.commentary.append",
    event_id: "result_1",
    delegation_id: d.ev.delegation.id,
    content: "Done. The frequency is now 5 hertz.",
  });
  const ack = await p.waitFor(
    (e) => e.client_event_id === "result_1" || e.error?.client_event_id === "result_1",
    10000,
    "result ack",
  );
  p.log(
    `result_1 ack ${ack?.ev.type} after ${ack === undefined ? "?" : ack.t - tAppend}ms ${summarize(ack?.ev ?? {})}`,
  );
  const spoken = await p.waitFor(
    (e, t) => e.type === "session.output_transcript.delta" && t >= tAppend,
    10000,
    "spoken result",
  );
  p.log(
    `first assistant transcript after the append: +${spoken === undefined ? "?" : spoken.t - tAppend}ms`,
  );
  await sleep(5000);
  const closed = await p.close();
  p.log(`closed: ${JSON.stringify(closed?.usage)} reason=${closed?.reason}`);
}

async function scenarioLong(): Promise<void> {
  const p = new Probe("long");
  await p.connect({
    model: "gpt-live-1",
    instructions: LIVE_PROMPT,
    audio,
    delegation: { type: "client" },
  });
  p.startPump();
  await sleep(800);
  const said = await p.say(
    "Why does the wave look jagged when I turn the frequency up high? Please look into it properly, take your time.",
  );
  const d1 = await p.waitFor((e) => e.type === "session.delegation.created", 15000, "delegation 1");
  if (d1 === undefined) {
    await sleep(4000);
    await p.close();
    return;
  }
  const id1 = d1.ev.delegation.id;
  p.log(`DELEGATION 1 ${id1} — ${d1.t - said.wallEnd}ms after utterance end`);
  const tD1 = p.now();
  // +3 s: quiet progress
  await sleep(3000);
  p.send({
    type: "session.thinking.append",
    event_id: "prog_1",
    delegation_id: id1,
    content:
      "Still working: reading the wave renderer. The wave is sampled on a 200-point grid; checking whether high frequencies exceed what the grid can show. No answer yet.",
  });
  // +9 s: the user asks something else while the long task runs
  await sleep(6000);
  const said2 = await p.say("Oh, and while you're at it, what's the amplitude right now?");
  const d2 = await p.waitFor(
    (e) => e.type === "session.delegation.created" && e.delegation?.id !== id1,
    15000,
    "delegation 2",
  );
  if (d2 !== undefined) {
    p.log(
      `DELEGATION 2 ${d2.ev.delegation.id} — ${d2.t - said2.wallEnd}ms after utterance end (task 1 still open)`,
    );
    await sleep(700);
    p.send({
      type: "session.commentary.append",
      event_id: "result_2",
      delegation_id: d2.ev.delegation.id,
      content: "The amplitude is 0.8 right now.",
    });
  }
  // +16 s: spoken progress on task 1
  await sleep(Math.max(0, tD1 + 16000 - p.now()));
  p.send({
    type: "session.commentary.append",
    event_id: "prog_2",
    delegation_id: id1,
    content:
      "Still on the jagged-wave question: it looks like a sampling-density problem, confirming now.",
  });
  // +25 s: the result
  await sleep(Math.max(0, tD1 + 25000 - p.now()));
  const tResult = p.now();
  p.send({
    type: "session.commentary.append",
    event_id: "result_1",
    delegation_id: id1,
    content:
      "Finished. The wave looks jagged because the renderer samples it on a fixed 200-point grid: at 12 hertz that is fewer than 17 points per cycle, so you see the straight segments between samples. Raising the grid to 400 points, or drawing with a curve instead of line segments, fixes it.",
  });
  await p.waitFor(
    (e) => e.client_event_id === "result_1" || e.error?.client_event_id === "result_1",
    10000,
    "result ack",
  );
  const spoken = await p.waitFor(
    (e, t) => e.type === "session.output_transcript.delta" && t >= tResult,
    10000,
    "spoken result",
  );
  p.log(
    `first assistant transcript after the final append: +${spoken === undefined ? "?" : spoken.t - tResult}ms`,
  );
  await sleep(14000);
  const closed = await p.close();
  p.log(`closed: ${JSON.stringify(closed?.usage)} reason=${closed?.reason}`);
}

async function scenarioResponses(): Promise<void> {
  const tool = {
    type: "function",
    name: "set_frequency",
    description:
      "Set the wave's frequency in hertz. Returns the value actually applied (clamped to 0.5–20).",
    parameters: {
      type: "object",
      properties: { value: { type: "number", minimum: 0.5, maximum: 20 } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  let p: Probe | undefined;
  for (const model of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
    const candidate = new Probe(`responses-${model}`);
    try {
      const started = await candidate.connect({
        model: "gpt-live-1",
        instructions: LIVE_PROMPT,
        audio,
        delegation: {
          type: "responses",
          responses: {
            model,
            instructions: BACKEND_PROMPT,
            tools: [tool],
            tool_choice: "auto",
            reasoning: { effort: "low" },
          },
        },
      });
      candidate.log(`resolved delegation: ${JSON.stringify(started.session?.delegation)}`);
      p = candidate;
      break;
    } catch (err) {
      candidate.log(`backend ${model} rejected: ${(err as Error).message}`);
    }
  }
  if (p === undefined) {
    return;
  }
  p.startPump();
  await sleep(800);
  const said = await p.say("Please set the frequency to five hertz.");
  const d = await p.waitFor((e) => e.type === "session.delegation.created", 15000, "delegation");
  if (d === undefined) {
    await sleep(4000);
    await p.close();
    return;
  }
  p.log(
    `DELEGATION ${d.ev.delegation?.id} target=${d.ev.delegation?.target} response_id=${d.ev.delegation?.response_id} — ${d.t - said.wallEnd}ms after utterance end`,
  );
  const call = await p.waitFor(
    (e) =>
      e.type === "response.event" &&
      e.event?.type === "response.output_item.done" &&
      e.event?.item?.type === "function_call",
    30000,
    "function_call",
  );
  if (call !== undefined) {
    const item = call.ev.event.item;
    p.log(
      `FUNCTION CALL ${item.name}(${item.arguments}) call_id=${item.call_id} — ${call.t - d.t}ms after delegation`,
    );
    const tReply = p.now();
    p.send({
      type: "response.item.create",
      event_id: "tool_out",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify({ applied: 5 }),
      },
    });
    p.send({ type: "response.create", event_id: "continue" });
    const done = await p.waitFor(
      (e, t) => e.type === "response.event" && e.event?.type === "response.completed" && t > tReply,
      30000,
      "response.completed after tool output",
    );
    p.log(
      `backend completed ${done === undefined ? "?" : done.t - tReply}ms after the tool result; usage=${JSON.stringify(done?.ev.event?.response?.usage)}`,
    );
    const spoken = await p.waitFor(
      (e, t) => e.type === "session.output_transcript.delta" && t >= tReply,
      10000,
      "spoken result",
    );
    p.log(
      `first assistant transcript after the tool result: +${spoken === undefined ? "?" : spoken.t - tReply}ms`,
    );
  }
  await sleep(6000);
  const closed = await p.close();
  p.log(`closed: ${JSON.stringify(closed?.usage)} reason=${closed?.reason}`);
}

async function scenarioSideband(): Promise<void> {
  // Primary WS carries audio (stands in for the browser's WebRTC); a SECOND
  // socket attaches by session id (stands in for the channel process) and
  // answers the delegation from there.
  const p = new Probe("sideband-primary");
  await p.connect({
    model: "gpt-live-1",
    instructions: LIVE_PROMPT,
    audio,
    delegation: { type: "client" },
  });
  p.startPump();
  const side = new Probe("sideband-attached");
  const sideEvents: Array<{ t: number; ev: Ev }> = [];
  let sideOpen = false;
  await new Promise<void>((resolve, reject) => {
    side.t0 = Date.now();
    side.ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${p.sessionId}/attach`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    side.ws.on("open", () => {
      sideOpen = true;
      side.log(`attached to ${p.sessionId} (${Date.now() - side.t0}ms)`);
      resolve();
    });
    side.ws.on("message", (data: Buffer) => {
      const ev = JSON.parse(data.toString());
      sideEvents.push({ t: side.now(), ev });
      if (ev.type === "session.input_audio.append") {
        return; // reflected mic audio — count only
      }
      if (ev.type === "session.output_audio.delta") {
        if (sideEvents.filter((e) => e.ev.type === "session.output_audio.delta").length === 1) {
          side.log(`← first reflected output audio start_ms=${ev.start_ms} end_ms=${ev.end_ms}`);
        }
        return;
      }
      side.log(`← ${ev.type} ${summarize(ev)}`);
    });
    side.ws.on("error", (err: Error) => reject(err));
    side.ws.on("close", (code: number) => side.log(`socket closed ${code}`));
  });
  await sleep(500);
  const said = await p.say("Please set the damping to zero point three.");
  // Both sockets should see the delegation; the ATTACHED one answers.
  const d = await p.waitFor(
    (e) => e.type === "session.delegation.created",
    15000,
    "delegation (primary)",
  );
  const dSide = sideEvents.find((e) => e.ev.type === "session.delegation.created");
  side.log(`delegation seen on sideband: ${dSide !== undefined} (${dSide?.ev.delegation?.id})`);
  if (d !== undefined) {
    p.log(`DELEGATION ${d.ev.delegation?.id} — ${d.t - said.wallEnd}ms after utterance end`);
  }
  if (d !== undefined && sideOpen) {
    await sleep(600);
    const tAppend = p.now();
    side.ws.send(
      JSON.stringify({
        type: "session.commentary.append",
        event_id: "side_result",
        delegation_id: d.ev.delegation.id,
        content: "Done. Damping is now 0.3.",
      }),
    );
    side.log("→ session.commentary.append (from the attached socket)");
    const spoken = await p.waitFor(
      (e, t) => e.type === "session.output_transcript.delta" && t >= tAppend,
      10000,
      "spoken result",
    );
    p.log(`primary heard the sideband's result: ${spoken !== undefined}`);
    const ackOnSide = sideEvents.find(
      (e) =>
        e.ev.client_event_id === "side_result" || e.ev.error?.client_event_id === "side_result",
    );
    const ackOnPrimary = p.events.find(
      (e) =>
        e.ev.client_event_id === "side_result" || e.ev.error?.client_event_id === "side_result",
    );
    side.log(
      `ack arrived on sideband: ${ackOnSide !== undefined}; on primary: ${ackOnPrimary !== undefined}`,
    );
  }
  await sleep(5000);
  const reflectedIn = sideEvents.filter((e) => e.ev.type === "session.input_audio.append").length;
  const reflectedOut = sideEvents.filter((e) => e.ev.type === "session.output_audio.delta").length;
  const transcriptsOnSide = sideEvents.filter((e) => e.ev.type.endsWith("transcript.delta")).length;
  side.log(
    `reflected input chunks: ${reflectedIn}, output chunks: ${reflectedOut}, transcript deltas: ${transcriptsOnSide}`,
  );
  const closed = await p.close();
  p.log(`closed: ${JSON.stringify(closed?.usage)} reason=${closed?.reason}`);
  await sleep(1000);
  side.log(
    `sideband saw session.closed: ${sideEvents.some((e) => e.ev.type === "session.closed")}`,
  );
  side.ws.close();
}

// ── hosted overlap probes (2026-10-10) ───────────────────────────────────────
//
// What happens in Responses (hosted) delegation when the user speaks AGAIN
// while a long hosted task is still waiting on a slow function result.
// `overlap`  — a quick arithmetic question inside a 20 s lookup
// `redirect` — "change that: look up X instead" inside the lookup
// `typed`    — the documented typed-update pair (response.item.create user
//              message + response.create) inside the lookup, no speech
// `models6`  — which gpt-6* backends session.start accepts
//
// Backend model: PROBE_BACKEND (default gpt-6-sol). Slow tool: PROBE_SLOW_MS.

const BACKEND = process.env.PROBE_BACKEND ?? "gpt-6-sol";
const SLOW_MS = Number(process.env.PROBE_SLOW_MS ?? 20000);
const TIMEBOX_MS = 90000;

const LOOKUP_LIVE_PROMPT = `You are a calm, brief voice assistant for a mathematics reference desk.
Speak plainly and briefly. No lists, no preamble.

Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Reference lookup: look a topic up in the reference library; this is slow (about twenty seconds).
- Arithmetic: add numbers.

Delegate to the backend when:
- The user asks to look something up, or asks for a definition or a fact about a mathematical object.
- The user asks for arithmetic.

Do not delegate to the backend when:
- The user greets you or asks you to repeat a result already provided.

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting. If the backend is still working, tell the user briefly and wait.`;

const LOOKUP_BACKEND_PROMPT = `## Voice conversation context
You are helping an assistant in a live voice conversation at a mathematics reference desk. Transcripts can contain mistakes. Use the latest context.

## Task instructions
Use the tools. slow_lookup(topic) looks a topic up in the reference library; it is slow (about twenty seconds). add(a, b) adds two numbers. Always use the tools rather than answering from memory, even for simple arithmetic.

## Return the result
Answer briefly, in one or two short sentences, using what the tools returned. Do not invent a result.`;

const slowLookupTool = {
  type: "function",
  name: "slow_lookup",
  description:
    "Look a topic up in the reference library. Slow: takes about twenty seconds. Returns a short summary.",
  parameters: {
    type: "object",
    properties: { topic: { type: "string", description: "The topic to look up." } },
    required: ["topic"],
    additionalProperties: false,
  },
};

const addTool = {
  type: "function",
  name: "add",
  description: "Add two numbers. Instant.",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
    additionalProperties: false,
  },
};

function lookupAnswer(topic: string): Ev {
  const t = topic.toLowerCase();
  if (t.includes("dirichlet")) {
    return {
      topic: "Dirichlet kernel",
      summary:
        "D_n(x) = sum_{k=-n}^{n} e^{ikx} = sin((n+1/2)x)/sin(x/2). Convolving with it gives the n-th partial sum of a Fourier series. It is not non-negative, and its L1 norm grows like log n, which is why partial sums can fail to converge.",
    };
  }
  if (t.includes("fej")) {
    return {
      topic: "Fejér kernel",
      summary:
        "F_n(x) = (1/n) sum_{k=0}^{n-1} D_k(x) = (1/n) (sin(nx/2)/sin(x/2))^2. It is non-negative with integral 1, so its convolutions (the Cesàro means) converge uniformly for every continuous function — Fejér's theorem.",
    };
  }
  if (t.includes("poisson")) {
    return {
      topic: "Poisson kernel",
      summary:
        "P_r(x) = (1 - r^2) / (1 - 2 r cos x + r^2) for 0 <= r < 1. It is positive with integral 1, and convolving with it solves the Dirichlet problem on the unit disk; as r tends to 1 the Abel means converge for every continuous function.",
    };
  }
  return { topic, summary: `No entry for "${topic}" in the reference library.` };
}

interface HostedCall {
  callId: string;
  name: string;
  arguments: string;
  responseId: string | undefined;
  t: number;
  answeredT?: number;
}

interface HostedDelegation {
  id: string;
  createdT: number;
  /** response_id named on session.delegation.created */
  announcedResponseId: string | undefined;
  /** nested response.created ids, in arrival order */
  responseIds: string[];
  /** nested lifecycle events */
  lifecycle: Array<{
    t: number;
    type: string;
    responseId?: string;
    status?: string;
    reason?: string;
  }>;
  calls: HostedCall[];
  pending: Map<string, HostedCall>;
  text: string;
  /** nested response ids that produced a function_call item */
  callingResponses: Set<string>;
}

/**
 * The hosted function-tool loop, keyed by the OUTER delegation_id, dispatched
 * on the nested event type. Function calls are read from
 * response.output_item.done items only. `slow_lookup` is answered after
 * SLOW_MS of wall time; `add` immediately. After the last pending call of a
 * delegation is answered, one `response.create` continues the backend.
 */
class HostedLoop {
  delegations = new Map<string, HostedDelegation>();
  errors: Array<{ t: number; ev: Ev }> = [];
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private seq = 0;

  constructor(readonly p: Probe) {
    p.hooks.push((ev, t) => this.handle(ev, t));
  }

  private delegation(id: string, t: number): HostedDelegation {
    let d = this.delegations.get(id);
    if (d === undefined) {
      d = {
        id,
        createdT: t,
        announcedResponseId: undefined,
        responseIds: [],
        lifecycle: [],
        calls: [],
        pending: new Map(),
        text: "",
        callingResponses: new Set(),
      };
      this.delegations.set(id, d);
    }
    return d;
  }

  private handle(ev: Ev, t: number): void {
    if (ev.type === "error") {
      this.errors.push({ t, ev });
      return;
    }
    if (ev.type === "session.delegation.created") {
      const d = this.delegation(ev.delegation.id, t);
      d.announcedResponseId = ev.delegation.response_id;
      this.p.log(
        `DELEGATION #${this.delegations.size} ${d.id} target=${ev.delegation.target} response_id=${ev.delegation.response_id} offset_ms=${ev.offset_ms}`,
      );
      return;
    }
    if (ev.type !== "response.event") {
      return;
    }
    const d = this.delegation(ev.delegation_id, t);
    const n: Ev = ev.event ?? {};
    const short = d.id.slice(-6);
    switch (n.type) {
      case "response.created": {
        const rid: string | undefined = n.response?.id;
        if (rid !== undefined) {
          d.responseIds.push(rid);
        }
        d.lifecycle.push({ t, type: n.type, responseId: rid, status: n.response?.status });
        this.p.log(
          `  [${short}] nested response.created ${rid} previous=${n.response?.previous_response_id ?? "-"}`,
        );
        return;
      }
      case "response.completed":
      case "response.failed":
      case "response.incomplete": {
        const r = n.response ?? {};
        const reason = r.incomplete_details?.reason ?? r.error?.message;
        d.lifecycle.push({ t, type: n.type, responseId: r.id, status: r.status, reason });
        this.p.log(
          `  [${short}] nested ${n.type} ${r.id} status=${r.status}${reason !== undefined ? ` reason=${reason}` : ""} output=${JSON.stringify(r.output ?? null).slice(0, 80)} usage=${JSON.stringify(r.usage ?? null).slice(0, 120)}`,
        );
        return;
      }
      case "response.output_text.delta":
        d.text += n.delta ?? "";
        return;
      case "response.output_item.done": {
        const item = n.item ?? {};
        if (item.type === "function_call") {
          const rid = d.responseIds[d.responseIds.length - 1];
          const call: HostedCall = {
            callId: item.call_id,
            name: item.name,
            arguments: item.arguments ?? "{}",
            responseId: rid,
            t,
          };
          d.calls.push(call);
          d.pending.set(call.callId, call);
          if (rid !== undefined) {
            d.callingResponses.add(rid);
          }
          this.p.log(
            `  [${short}] FUNCTION CALL ${call.name}(${call.arguments}) call_id=${call.callId} in ${rid} — ${t - d.createdT}ms after delegation`,
          );
          this.dispatch(d, call);
        } else if (item.type === "message") {
          const text = (item.content ?? []).map((c: Ev) => c.text ?? "").join("");
          this.p.log(`  [${short}] backend message: "${text}"`);
        }
        return;
      }
      default:
        return;
    }
  }

  private dispatch(d: HostedDelegation, call: HostedCall): void {
    const answer = (output: Ev) => {
      if (this.p.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      call.answeredT = this.p.now();
      d.pending.delete(call.callId);
      const id = `tool_${++this.seq}`;
      this.p.send({
        type: "response.item.create",
        event_id: id,
        item: {
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(output),
        },
      });
      if (d.pending.size === 0) {
        this.p.send({ type: "response.create", event_id: `${id}_go` });
      } else {
        this.p.log(
          `  holding response.create for ${d.id.slice(-6)}: ${d.pending.size} call(s) still pending`,
        );
      }
    };
    let args: Ev = {};
    try {
      args = JSON.parse(call.arguments);
    } catch {}
    if (call.name === "slow_lookup") {
      this.p.log(`  slow_lookup("${args.topic}") will be answered in ${SLOW_MS}ms`);
      this.timers.push(setTimeout(() => answer(lookupAnswer(String(args.topic ?? ""))), SLOW_MS));
    } else if (call.name === "add") {
      answer({ sum: Number(args.a) + Number(args.b) });
    } else {
      answer({ error: `unknown tool ${call.name}` });
    }
  }

  /** A delegation is terminal when nothing is pending and its latest nested
   * response ended without asking for a tool (or failed / went incomplete). */
  terminal(d: HostedDelegation): boolean {
    if (d.pending.size > 0) {
      return false;
    }
    const last = d.lifecycle[d.lifecycle.length - 1];
    if (last === undefined || last.type === "response.created") {
      return false;
    }
    if (last.type !== "response.completed") {
      return true;
    }
    return last.responseId === undefined || !d.callingResponses.has(last.responseId);
  }

  allTerminal(): boolean {
    return (
      this.delegations.size > 0 && [...this.delegations.values()].every((d) => this.terminal(d))
    );
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
  }

  summary(): void {
    let i = 0;
    for (const d of this.delegations.values()) {
      i++;
      this.p.log(
        `SUMMARY delegation #${i} ${d.id} created +${(d.createdT / 1000).toFixed(2)}s announced=${d.announcedResponseId} nested=[${d.responseIds.join(", ")}] terminal=${this.terminal(d)}`,
      );
      for (const c of d.calls) {
        this.p.log(
          `  call ${c.name}(${c.arguments}) in ${c.responseId} arrived +${(c.t / 1000).toFixed(2)}s answered ${c.answeredT === undefined ? "never" : `+${(c.answeredT / 1000).toFixed(2)}s`}`,
        );
      }
      for (const l of d.lifecycle) {
        this.p.log(
          `  ${l.type} ${l.responseId ?? ""} +${(l.t / 1000).toFixed(2)}s${l.status !== undefined ? ` status=${l.status}` : ""}${l.reason !== undefined ? ` reason=${l.reason}` : ""}`,
        );
      }
      if (d.text !== "") {
        this.p.log(`  backend text: "${d.text}"`);
      }
    }
    for (const e of this.errors) {
      this.p.log(
        `SUMMARY error +${(e.t / 1000).toFixed(2)}s ${JSON.stringify(e.ev.error ?? e.ev)}`,
      );
    }
  }
}

async function connectHosted(label: string): Promise<{ p: Probe; loop: HostedLoop }> {
  const p = new Probe(label);
  const started = await p.connect({
    model: "gpt-live-1",
    instructions: LOOKUP_LIVE_PROMPT,
    audio,
    delegation: {
      type: "responses",
      responses: {
        model: BACKEND,
        instructions: LOOKUP_BACKEND_PROMPT,
        tools: [slowLookupTool, addTool],
        tool_choice: "auto",
        reasoning: { effort: "low" },
      },
    },
  });
  p.log(
    `session.started in ${p.now()}ms on backend ${BACKEND}; resolved delegation: ${JSON.stringify(started.session?.delegation)}`,
  );
  const loop = new HostedLoop(p);
  p.startPump();
  await sleep(800);
  return { p, loop };
}

/** Wait until every delegation is terminal and the assistant has been silent
 * for `quietMs`, or the timebox runs out. */
async function settle(
  p: Probe,
  loop: HostedLoop,
  minDelegations: number,
  quietMs = 5000,
): Promise<void> {
  const deadline = TIMEBOX_MS;
  for (;;) {
    const now = p.now();
    if (now > deadline) {
      p.log(`⏱ timebox ${TIMEBOX_MS}ms reached`);
      return;
    }
    const lastSpoken = p.outSegments[p.outSegments.length - 1]?.t ?? 0;
    // quiet counts from the LATER of the last spoken word and the last backend
    // lifecycle event, so a result that completed a moment ago gets its chance
    // to be spoken (the voice model takes ~1–2 s to start on a fresh result)
    let lastLifecycle = 0;
    for (const d of loop.delegations.values()) {
      for (const l of d.lifecycle) {
        lastLifecycle = Math.max(lastLifecycle, l.t);
      }
    }
    const lastActivity = Math.max(lastSpoken, lastLifecycle);
    if (
      loop.delegations.size >= minDelegations &&
      loop.allTerminal() &&
      now - lastActivity > quietMs
    ) {
      p.log(
        `settled: ${loop.delegations.size} delegation(s) terminal, quiet ${now - lastActivity}ms`,
      );
      return;
    }
    await sleep(200);
  }
}

async function firstDelegation(p: Probe): Promise<{ t: number; ev: Ev } | undefined> {
  const said = await p.say(
    "Please look up the Dirichlet kernel; it is fine if that takes about twenty seconds.",
  );
  const d1 = await p.waitFor((e) => e.type === "session.delegation.created", 15000, "delegation 1");
  if (d1 !== undefined) {
    p.log(`delegation 1 arrived ${d1.t - said.wallEnd}ms after the utterance finished sending`);
  }
  const call = await p.waitFor(
    (e) =>
      e.type === "response.event" &&
      e.event?.type === "response.output_item.done" &&
      e.event?.item?.type === "function_call",
    20000,
    "first function call",
  );
  if (call !== undefined && d1 !== undefined) {
    p.log(`first function call ${call.t - d1.t}ms after delegation 1`);
  }
  return d1;
}

async function finishHosted(p: Probe, loop: HostedLoop): Promise<void> {
  loop.summary();
  loop.stop();
  const closed = await p.close();
  p.log(`closed: ${JSON.stringify(closed?.usage)} reason=${closed?.reason}`);
}

async function scenarioOverlap(): Promise<void> {
  const { p, loop } = await connectHosted("overlap");
  const d1 = await firstDelegation(p);
  if (d1 === undefined) {
    await sleep(4000);
    await finishHosted(p, loop);
    return;
  }
  await sleep(Math.max(0, d1.t + 6000 - p.now()));
  const said2 = await p.say("While that runs, what is seventeen plus twenty-five?");
  const d2 = await p.waitFor(
    (e) => e.type === "session.delegation.created" && e.delegation?.id !== d1.ev.delegation.id,
    15000,
    "delegation 2",
  );
  p.log(
    d2 === undefined
      ? "NO second delegation within 15 s of utterance 2"
      : `delegation 2 ${d2.ev.delegation.id} arrived ${d2.t - said2.wallEnd}ms after utterance 2 finished sending (task 1 still waiting on slow_lookup)`,
  );
  await settle(p, loop, d2 === undefined ? 1 : 2);
  await finishHosted(p, loop);
}

async function scenarioRedirect(): Promise<void> {
  // PROBE_REDIRECT_TOPIC swaps the redirect target (the synthesizer's "Fejér"
  // was transcribed as "phasor" on 2026-10-10; "Poisson kernel" is unambiguous)
  const topic = process.env.PROBE_REDIRECT_TOPIC ?? "Fejér kernel";
  const label =
    process.env.PROBE_REDIRECT_TOPIC === undefined
      ? "redirect"
      : `redirect-${topic.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const { p, loop } = await connectHosted(label);
  const d1 = await firstDelegation(p);
  if (d1 === undefined) {
    await sleep(4000);
    await finishHosted(p, loop);
    return;
  }
  await sleep(Math.max(0, d1.t + 6000 - p.now()));
  const said2 = await p.say(`Actually, change that: look up the ${topic} instead.`);
  const d2 = await p.waitFor(
    (e) => e.type === "session.delegation.created" && e.delegation?.id !== d1.ev.delegation.id,
    15000,
    "delegation 2",
  );
  p.log(
    d2 === undefined
      ? "NO second delegation within 15 s of the redirect"
      : `delegation 2 ${d2.ev.delegation.id} arrived ${d2.t - said2.wallEnd}ms after the redirect finished sending`,
  );
  await settle(p, loop, d2 === undefined ? 1 : 2);
  await finishHosted(p, loop);
}

async function scenarioTyped(): Promise<void> {
  const { p, loop } = await connectHosted("typed");
  const d1 = await firstDelegation(p);
  if (d1 === undefined) {
    await sleep(4000);
    await finishHosted(p, loop);
    return;
  }
  await sleep(Math.max(0, d1.t + 6000 - p.now()));
  const tTyped = p.now();
  p.send({
    type: "response.item.create",
    event_id: "typed_q",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Also tell me seventeen plus twenty-five." }],
    },
  });
  p.send({ type: "response.create", event_id: "typed_go" });
  const reaction = await p.waitFor(
    (e, t) =>
      t > tTyped &&
      (e.type === "error" ||
        e.type === "session.delegation.created" ||
        (e.type === "response.event" && e.event?.type === "response.created")),
    15000,
    "reaction to the typed pair",
  );
  p.log(
    reaction === undefined
      ? "NO reaction to the typed pair within 15 s"
      : `typed pair → ${reaction.ev.type} ${summarize(reaction.ev)} after ${reaction.t - tTyped}ms`,
  );
  await settle(p, loop, 1);
  await finishHosted(p, loop);
}

/** Is the voice model frozen while a hosted function call is pending, or is
 * only the user's next turn deferred? A commentary append with
 * delegation_id: null at +6 s (the documented steering path), then a spoken
 * question at +12 s. */
async function scenarioHold(): Promise<void> {
  const { p, loop } = await connectHosted("hold");
  const d1 = await firstDelegation(p);
  if (d1 === undefined) {
    await sleep(4000);
    await finishHosted(p, loop);
    return;
  }
  await sleep(Math.max(0, d1.t + 6000 - p.now()));
  const tAppend = p.now();
  p.send({
    type: "session.commentary.append",
    event_id: "hold_note",
    delegation_id: null,
    content: "The lookup is still running; about fifteen more seconds.",
  });
  const ack = await p.waitFor(
    (e) => e.client_event_id === "hold_note" || e.error?.client_event_id === "hold_note",
    10000,
    "hold_note ack",
  );
  p.log(
    `hold_note → ${ack?.ev.type} after ${ack === undefined ? "?" : ack.t - tAppend}ms ${summarize(ack?.ev ?? {})}`,
  );
  const spoken = await p.waitFor(
    (e, t) => e.type === "session.output_transcript.delta" && t >= tAppend,
    6000,
    "commentary spoken during the hold",
  );
  p.log(
    spoken === undefined
      ? "commentary NOT spoken within 6 s (voice held while the function call is pending)"
      : `commentary spoken +${spoken.t - tAppend}ms after the append, while the function call is pending`,
  );
  await sleep(Math.max(0, d1.t + 12000 - p.now()));
  const said2 = await p.say("While that runs, what is seventeen plus twenty-five?");
  const d2 = await p.waitFor(
    (e) => e.type === "session.delegation.created" && e.delegation?.id !== d1.ev.delegation.id,
    25000,
    "delegation 2",
  );
  p.log(
    d2 === undefined
      ? "NO second delegation within 25 s of utterance 2"
      : `delegation 2 ${d2.ev.delegation.id} arrived ${d2.t - said2.wallEnd}ms after utterance 2 finished sending`,
  );
  await settle(p, loop, d2 === undefined ? 1 : 2);
  await finishHosted(p, loop);
}

async function scenarioModels6(): Promise<void> {
  for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]) {
    const p = new Probe(`models6-${model}`);
    try {
      const started = await p.connect({
        model: "gpt-live-1",
        instructions: LOOKUP_LIVE_PROMPT,
        audio,
        delegation: {
          type: "responses",
          responses: {
            model,
            instructions: LOOKUP_BACKEND_PROMPT,
            tools: [slowLookupTool, addTool],
            tool_choice: "auto",
            reasoning: { effort: "low" },
          },
        },
      });
      p.log(
        `ACCEPTED backend ${model}; resolved delegation: ${JSON.stringify(started.session?.delegation)}`,
      );
      await p.close();
    } catch (err) {
      p.log(`REJECTED backend ${model}: ${(err as Error).message}`);
      try {
        p.ws.close();
      } catch {}
    }
  }
}

const scenarios: Record<string, () => Promise<void>> = {
  models: scenarioModels,
  context: scenarioContext,
  client: scenarioClient,
  long: scenarioLong,
  responses: scenarioResponses,
  sideband: scenarioSideband,
  models6: scenarioModels6,
  overlap: scenarioOverlap,
  redirect: scenarioRedirect,
  typed: scenarioTyped,
  hold: scenarioHold,
};

const wanted = process.argv.slice(2);
if (wanted.length === 0) {
  console.error(`usage: live-probe.mts ${Object.keys(scenarios).join("|")} …`);
  process.exit(2);
}
for (const name of wanted) {
  const fn = scenarios[name];
  if (fn === undefined) {
    console.error(`unknown scenario ${name}`);
    continue;
  }
  console.log(`\n═══════════ ${name} ═══════════`);
  try {
    await fn();
  } catch (err) {
    console.error(`[${name}] FAILED: ${(err as Error).stack ?? err}`);
  }
}
process.exit(0);
