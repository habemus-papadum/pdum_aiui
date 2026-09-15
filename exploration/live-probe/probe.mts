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

const scenarios: Record<string, () => Promise<void>> = {
  models: scenarioModels,
  context: scenarioContext,
  client: scenarioClient,
  long: scenarioLong,
  responses: scenarioResponses,
  sideband: scenarioSideband,
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
