// @vitest-environment jsdom
import { decodeFrame, jsonCodec } from "@habemus-papadum/aiui-claude-channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountIntentTool, unmountIntentTool } from "../intent";
import type { IntentEvent, IntentPipelineConfig } from "../intent-pipeline";
import { fakeSocketFactory } from "../test-support/fake-socket";
import { installLocalStorage } from "../test-support/local-storage";
import { INTENT_CONFIG_STORAGE_KEY, loadIntentOverrides } from "./advanced-config";
import type { PcmSource } from "./audio";
import type { CaptureOutcome, DisplayCapture } from "./display-capture";
import { type MultimodalDeps, multimodalModality } from "./modality";
import type { SpeechAudioElement } from "./speech";

afterEach(() => {
  unmountIntentTool();
  delete window.__AIUI__;
  // The modality now mirrors an open turn to sessionStorage (turn recovery);
  // jsdom's sessionStorage persists across tests, so clear it or a leftover turn
  // would be "recovered" into the next test's fresh mount.
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.clear();
  }
  window.getSelection()?.removeAllRanges();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Dispatch a document key event (capture-phase keymap listens on document). */
function key(type: "keydown" | "keyup", k: string): void {
  document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
}

/** All frames the fake socket has sent, decoded (envelope + payload). */
function frames(sent: Uint8Array[]) {
  return sent.map((f) => decodeFrame(f));
}

/** Union of every IntentEvent across the connection's `events` chunks. */
function streamedEvents(sent: Uint8Array[]): IntentEvent[] {
  const events: IntentEvent[] = [];
  for (const { envelope, payload } of frames(sent)) {
    if ((envelope as { chunk?: { kind?: string } }).chunk?.kind === "events") {
      const batch = jsonCodec.decode(payload) as { events: IntentEvent[] };
      events.push(...batch.events);
    }
  }
  return events;
}

/**
 * Query the tool's shadow root. The HUD (`.mm-hud` with arm/state/video/meter/
 * speaker) lives INSIDE the widget pill's slot since the unified-widget
 * rewrite (proposal B2), so it is reachable only through the handle's shadow
 * root — `document.querySelector` sees none of it. The page-level layers
 * (preview, veil, strip) still mount into `document.body`.
 */
const q = <T extends Element>(handle: { shadowRoot?: ShadowRoot | null }, sel: string): T =>
  handle.shadowRoot?.querySelector(sel) as T;

/** Mount the multimodal modality alone (no text tab), wired to a fake socket. */
function mountMultimodal(
  config: Parameters<typeof multimodalModality>[0],
  ackOk = true,
  deps?: MultimodalDeps,
) {
  const { factory, sent, push } = fakeSocketFactory(() => ({ ok: ackOk }));
  const handle = mountIntentTool({
    force: true,
    port: 4321,
    webSocketFactory: factory,
    modalities: [multimodalModality(config, deps)],
  });
  return { handle, sent, push };
}

describe("multimodalModality: the turn on the wire", () => {
  it("streams hello(meta.intent) → events chunks → fin on an arm·talk·send turn", async () => {
    const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });

    key("keydown", "`"); // arm
    key("keydown", " "); // talk-start → thread-open → socket opens
    await wait(50); // let the socket connect + hello send
    key("keyup", " "); // talk-end → mock transcribe (instant) → transcript-final
    await wait(50);
    key("keydown", "Enter"); // send → context (none) → fin
    await wait(120);

    const decoded = frames(sent);
    // Hello carries the format + the effective config as meta.intent.
    expect(decoded[0].envelope).toMatchObject({ kind: "hello", format: "intent-v1" });
    const helloMeta = (decoded[0].envelope as { meta?: { intent?: Record<string, unknown> } }).meta;
    expect(helloMeta?.intent).toMatchObject({ transcriber: "mock", talkMode: "hold" });

    // The event log arrived over one or more `events` chunks, in order.
    const events = streamedEvents(sent);
    const types = events.map((e) => e.type);
    expect(types).toContain("thread-open");
    expect(types).toContain("talk-start");
    expect(types).toContain("transcript-final");
    expect(types.indexOf("thread-open")).toBeLessThan(types.indexOf("talk-start"));

    // The thread ended with a fin frame (no chunk on the terminator).
    const last = decoded.at(-1);
    expect(last?.envelope.fin).toBe(true);
    expect((last?.envelope as { chunk?: unknown }).chunk).toBeUndefined();
  });

  it("sends NO fin when the turn is cancelled with Esc", async () => {
    const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });

    key("keydown", "`"); // arm
    key("keydown", " "); // talk-start → thread opens
    await wait(50);
    key("keyup", " "); // talk-end
    await wait(50);
    key("keydown", "Escape"); // step out: cancels the open thread (no send)
    await wait(80);

    expect(frames(sent).some((f) => f.envelope.fin === true)).toBe(false);
  });
});

describe("multimodalModality: the mic is only for the channel transcriber", () => {
  /** Install a getUserMedia that NEVER settles (the real pending-prompt case). */
  function neverResolvingMic(): { restore: () => void; calls: () => number } {
    let calls = 0;
    const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () => {
          calls++;
          return new Promise<MediaStream>(() => {}); // hangs forever, like an open prompt
        },
      },
      configurable: true,
    });
    return {
      calls: () => calls,
      restore: () => {
        if (original) {
          Object.defineProperty(navigator, "mediaDevices", original);
        } else {
          // jsdom has no mediaDevices to begin with — remove the stub entirely so
          // the never-resolving getUserMedia can't leak into a later test.
          delete (navigator as { mediaDevices?: unknown }).mediaDevices;
        }
      },
    };
  }

  it("mock: Space starts the turn synchronously and never touches the mic", async () => {
    const mic = neverResolvingMic();
    try {
      const { handle, sent } = mountMultimodal({
        transcriber: "mock",
        mockWordMs: 0,
        mockTypoRate: 0,
      });

      key("keydown", "`"); // arm
      key("keydown", " "); // talk-start — the mock path has no mic await, so this
      //                      runs to completion synchronously in the dispatch.

      // Talking is live already, without the getUserMedia promise ever settling —
      // the mock path has no await, so renderHud() ran synchronously in dispatch
      // (the state label is vanilla-written into the pill's HUD slot: no flush).
      expect(q(handle, ".mm-state")?.textContent).toContain("REC");
      expect(mic.calls()).toBe(0); // the mock never reads audio

      // And it still streams the turn + a transcript on talk-end — audio untouched.
      key("keyup", " ");
      await wait(60);
      const preview = document.querySelector(".mm-preview-body") as HTMLElement;
      expect(preview.textContent?.trim().length).toBeGreaterThan(0);
      expect(streamedEvents(sent).map((e) => e.type)).toContain("talk-start");
      expect(mic.calls()).toBe(0);
    } finally {
      mic.restore();
    }
  });

  it("openai: talk-start awaits the mic (getUserMedia is called)", async () => {
    const mic = neverResolvingMic();
    try {
      mountMultimodal({ transcriber: "openai" });
      key("keydown", "`");
      key("keydown", " "); // openai path awaits ensureStream → getUserMedia called
      await wait(0);
      expect(mic.calls()).toBe(1);
    } finally {
      mic.restore();
    }
  });
});

/** Stub getDisplayMedia + the canvas stack so a shot produces real bytes. */
function stubCapture(): () => void {
  const track = { addEventListener() {}, stop() {} };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia: async () => stream, getUserMedia: async () => stream },
    configurable: true,
  });
  const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  const media = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    getContext: canvas.getContext,
    toBlob: canvas.toBlob,
    toDataURL: canvas.toDataURL,
    play: media.play,
    srcObject: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject"),
  };
  canvas.getContext = () => fakeCtx;
  canvas.toBlob = (cb: (b: Blob) => void) =>
    cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  canvas.toDataURL = () => "data:image/png;base64,iVBOR";
  media.play = async () => {};
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  return () => {
    if (originalMedia) {
      Object.defineProperty(navigator, "mediaDevices", originalMedia);
    }
    canvas.getContext = saved.getContext;
    canvas.toBlob = saved.toBlob;
    canvas.toDataURL = saved.toDataURL;
    media.play = saved.play;
    if (saved.srcObject) {
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", saved.srcObject);
    }
  };
}

describe("multimodalModality: shot attachments", () => {
  it("uploads the shot PNG as a raw-binary attachment frame (id shot_1)", async () => {
    const restore = stubCapture();
    try {
      const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
      key("keydown", "`"); // arm
      key("keydown", "s"); // S: whole-viewport shot → opens thread, uploads bytes
      await wait(250); // socket connect + ~120ms compositor wait + flush

      const attachment = frames(sent).find(
        (f) => (f.envelope as { chunk?: { kind?: string } }).chunk?.kind === "attachment",
      );
      expect(attachment).toBeDefined();
      const chunk = (attachment?.envelope as { chunk: { id: string; mime: string } }).chunk;
      expect(chunk).toMatchObject({ id: "shot_1", mime: "image/png" });
      expect([...(attachment?.payload ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      // The shot event itself rode the events stream (correlated by marker).
      const shotEvent = streamedEvents(sent).find((e) => e.type === "shot");
      expect(shotEvent).toMatchObject({ marker: "shot_1" });
    } finally {
      restore();
    }
  });

  it("the preview thumb's ✕ retracts the shot: piece gone, shot-drop streamed", async () => {
    const restore = stubCapture();
    try {
      const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
      key("keydown", "`");
      key("keydown", "s"); // whole-viewport shot
      await wait(250);

      const wrap = document.querySelector<HTMLElement>(".mm-preview-body .mm-thumb-wrap");
      expect(wrap).not.toBeNull();
      expect(wrap?.querySelector(".mm-thumb")).not.toBeNull();
      const x = wrap?.querySelector<HTMLButtonElement>(".mm-thumb-x");
      expect(x?.title).toContain("shot_1");
      x?.click();
      await wait(120); // let the events debounce flush

      // The thumbnail left the preview, and the retraction streamed to the
      // channel — the shared composeIntent drops it server-side too.
      expect(document.querySelector(".mm-preview-body .mm-thumb-wrap")).toBeNull();
      const drop = streamedEvents(sent).find((e) => e.type === "shot-drop");
      expect(drop).toMatchObject({ marker: "shot_1" });
    } finally {
      restore();
    }
  });

  it("a fast region drag (pointerup before D-up) yields exactly one shot — the race the split fixed", async () => {
    const restore = stubCapture();
    try {
      const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
      const veil = document.querySelector<HTMLElement>(".mm-shot-veil");
      expect(veil).not.toBeNull();
      // jsdom elements have no setPointerCapture; the veil calls it on pointerdown.
      (veil as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {};

      key("keydown", "`"); // arm
      key("keydown", "d"); // D down: arm the region veil

      // The drag: down · move · up, a rect well past the 8px threshold. Its
      // pointerup fires the region capture BEFORE the key comes up — exactly the
      // fast-drag ordering that used to ALSO trigger a whole-viewport shot.
      const at = (x: number, y: number) => ({
        clientX: x,
        clientY: y,
        pointerId: 1,
        bubbles: true,
      });
      veil?.dispatchEvent(new PointerEvent("pointerdown", at(20, 20)));
      veil?.dispatchEvent(new PointerEvent("pointermove", at(120, 90)));
      veil?.dispatchEvent(new PointerEvent("pointerup", at(120, 90)));

      key("keyup", "d"); // D up AFTER the drag completed: must NOT add a viewport shot

      await wait(250); // socket + ~120ms compositor wait + flush

      const shots = streamedEvents(sent).filter((e) => e.type === "shot");
      expect(shots).toHaveLength(1);
      // ...and the single shot is the dragged region (100×70), not the viewport.
      expect((shots[0] as { rect?: { w: number; h: number } }).rect).toMatchObject({
        w: 100,
        h: 70,
      });
    } finally {
      restore();
    }
  });
});

describe("multimodalModality: lowered echoes merge in", () => {
  it("fills the preview from a transcript-final echo (channel transcriber)", async () => {
    const { push } = mountMultimodal({ transcriber: "openai" });

    key("keydown", "`");
    key("keydown", " ");
    await wait(50);
    key("keyup", " "); // uploads seg_1, awaits the echo (no local transcription)
    await wait(50);

    // The preview has no text yet — the channel owns transcription.
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.textContent?.trim()).toBe("");

    // Server echoes the segment's final; it merges as if local.
    push({
      kind: "lowered",
      events: [
        {
          at: Date.now(),
          type: "transcript-final",
          segment: 1,
          text: "reaction diffusion on the GPU",
          latencyMs: 900,
          model: "gpt-4o-transcribe",
        },
      ],
    });
    await flush();
    expect(body.textContent).toContain("reaction diffusion on the GPU");
  });
});

describe("multimodalModality: degradation", () => {
  it("composes locally and reports the failure when no channel port is set", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({
      force: true,
      // no port
      webSocketFactory: factory,
      modalities: [multimodalModality({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 })],
    });

    key("keydown", "`");
    key("keydown", " ");
    await wait(30);
    key("keyup", " ");
    await wait(30);
    // The preview still filled locally (mock transcription needs no channel).
    const preview = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(preview.textContent?.trim().length).toBeGreaterThan(0);

    key("keydown", "Enter"); // send with no channel → a reported failure, no throw
    await wait(60);
    const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
    expect(status.toLowerCase()).toMatch(/no channel|unavailable|send/);
  });

  it("tells the user transcription needs the channel (openai transcriber, no port)", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({
      force: true,
      // no port → openThread rejects → the turn has no channel to upload to
      webSocketFactory: factory,
      modalities: [multimodalModality({ transcriber: "openai" })],
    });

    key("keydown", "`"); // arm
    key("keydown", " "); // talk-start (openai path; jsdom has no mic → degrades)
    await wait(40);
    key("keyup", " "); // talk-end: no channel for the openai transcriber
    await wait(40);

    const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
    // The status names the fix, never silently switches to mock.
    expect(status).toMatch(/transcription needs the channel/i);
    expect(status).toMatch(/aiui claude|mock/i);
  });

  it("surfaces a server note echo (e.g. a missing key) in the widget status", async () => {
    const { handle, push } = mountMultimodal({ transcriber: "openai" });

    key("keydown", "`");
    key("keydown", " ");
    await wait(50);
    key("keyup", " "); // uploads seg_1, awaits the channel echo
    await wait(30);

    // The channel echoes an empty final + a note (its keyless/degraded path).
    push({
      kind: "lowered",
      events: [
        {
          at: Date.now(),
          type: "transcript-final",
          segment: 1,
          text: "",
          latencyMs: 0,
          model: "gpt-4o-transcribe",
        },
        {
          at: Date.now(),
          type: "note",
          text: "server-side transcription is unavailable — the channel process has no OPENAI_API_KEY.",
        },
      ],
    });
    await flush();

    const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
    expect(status).toMatch(/OPENAI_API_KEY/);
  });
});

/** A scriptable fake {@link PcmSource}: jsdom has no AudioWorklet, so realtime
 * capture is injected. `emit` fires a captured frame; `available:false` models a
 * mic/AudioWorklet that can't start. */
function fakePcmSource(opts: { available?: boolean } = {}) {
  let onFrame: ((f: Int16Array) => void) | undefined;
  let started = false;
  const source: PcmSource = {
    async start(cb) {
      if (opts.available === false) {
        return false;
      }
      onFrame = cb;
      started = true;
      return true;
    },
    async stop() {
      started = false;
      onFrame = undefined;
    },
    level: () => (started ? 0.5 : 0),
    dispose() {
      started = false;
    },
  };
  return {
    source,
    emit: (frame: Int16Array) => onFrame?.(frame),
    isStarted: () => started,
  };
}

/** Every `audio` chunk frame the connection sent, decoded. */
function audioChunks(sent: Uint8Array[]) {
  return frames(sent)
    .map((f) => f.envelope as { chunk?: { kind?: string; id?: string; seq?: number } })
    .filter((e) => e.chunk?.kind === "audio")
    .map((e) => e.chunk);
}

/** Mount the realtime modality with an injected PCM source + fake socket. */
function mountRealtime(pcm: PcmSource, over: Record<string, unknown> = {}) {
  const { factory, sent, push } = fakeSocketFactory(() => ({ ok: true }));
  const handle = mountIntentTool({
    force: true,
    port: 4321,
    webSocketFactory: factory,
    modalities: [
      multimodalModality({ transcriber: "openai-realtime", ...over }, { pcmSource: () => pcm }),
    ],
  });
  return { handle, sent, push };
}

describe("multimodalModality: realtime (streaming) transcriber", () => {
  it("streams PCM as audio chunks while talking, then flushes talk-end immediately", async () => {
    const pcm = fakePcmSource();
    const { sent } = mountRealtime(pcm.source);

    key("keydown", "`"); // arm
    key("keydown", " "); // talk-start → realtime capture starts → thread opens
    await wait(50); // socket connect
    expect(pcm.isStarted()).toBe(true);

    // Frames captured during talk stream as `audio` chunks, in seq order.
    pcm.emit(Int16Array.of(1000, -1000, 500));
    pcm.emit(Int16Array.of(200, 300));
    await wait(20);
    const chunks = audioChunks(sent);
    expect(chunks.map((c) => c?.seq)).toEqual([0, 1]);
    expect(chunks.every((c) => c?.id === "seg_1")).toBe(true);
    // The raw PCM rode the payload (2 bytes/sample) — first frame was 3 samples.
    const firstAudio = frames(sent).find(
      (f) => (f.envelope as { chunk?: { kind?: string } }).chunk?.kind === "audio",
    );
    expect(firstAudio?.payload.length).toBe(6);

    key("keyup", " "); // talk-end → stop capture → flush talk-end past the debounce
    await wait(30); // < EVENTS_DEBOUNCE_MS (60): only the immediate flush can have sent it
    expect(pcm.isStarted()).toBe(false);
    const types = streamedEvents(sent).map((e) => e.type);
    expect(types).toContain("talk-end");
  });

  it("Enter mid-hold (send) releases realtime capture — no frame chases the closed thread", async () => {
    const pcm = fakePcmSource();
    const { sent } = mountRealtime(pcm.source);

    key("keydown", "`"); // arm
    key("keydown", " "); // talk-start → realtime capture starts → thread opens
    await wait(50);
    pcm.emit(Int16Array.of(1, 2, 3));
    await wait(20);
    expect(audioChunks(sent)).toHaveLength(1);

    // Send while still holding Space: the engine ends the talk ITSELF
    // (engine.send → log-level talkEnd + thread-close) — the keymap's
    // talk-end never fires. The shell's capture must not outlive the thread:
    // before the fix, the worklet kept streaming into the closing socket
    // ("audio frame rejected: connection closed" ×N) and stayed hot after.
    key("keydown", "Enter");
    await wait(30);
    expect(pcm.isStarted()).toBe(false);
    pcm.emit(Int16Array.of(4, 5, 6)); // a straggler frame — must go nowhere
    await wait(30);
    expect(audioChunks(sent)).toHaveLength(1);

    // The late Space release is a clean no-op (the talk already ended).
    key("keyup", " ");
    await wait(30);
    expect(audioChunks(sent)).toHaveLength(1);
  });

  it("Esc mid-hold (cancel) releases realtime capture the same way", async () => {
    const pcm = fakePcmSource();
    const { sent } = mountRealtime(pcm.source);

    key("keydown", "`");
    key("keydown", " ");
    await wait(50);
    pcm.emit(Int16Array.of(1, 2));
    await wait(20);
    expect(audioChunks(sent)).toHaveLength(1);

    key("keydown", "Escape"); // cancel the thread while still holding Space
    await wait(30);
    expect(pcm.isStarted()).toBe(false);
    pcm.emit(Int16Array.of(3, 4));
    key("keyup", " ");
    await wait(30);
    expect(audioChunks(sent)).toHaveLength(1);
  });

  it("renders transcript-delta echoes progressively into the preview", async () => {
    const pcm = fakePcmSource();
    const { push } = mountRealtime(pcm.source);

    key("keydown", "`");
    key("keydown", " ");
    await wait(50);
    pcm.emit(Int16Array.of(1, 2, 3));
    key("keyup", " ");
    await wait(20);

    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    // Partial deltas fill the preview as they arrive (cumulative text).
    push({
      kind: "lowered",
      events: [{ at: Date.now(), type: "transcript-delta", segment: 1, text: "make the" }],
    });
    await flush();
    expect(body.textContent).toContain("make the");
    push({
      kind: "lowered",
      events: [
        { at: Date.now(), type: "transcript-delta", segment: 1, text: "make the plot wider" },
      ],
    });
    await flush();
    expect(body.textContent).toContain("make the plot wider");

    // The final resolves the segment.
    push({
      kind: "lowered",
      events: [
        {
          at: Date.now(),
          type: "transcript-final",
          segment: 1,
          text: "make the plot wider",
          latencyMs: 700,
          model: "gpt-realtime-whisper",
        },
      ],
    });
    await flush();
    expect(body.textContent).toContain("make the plot wider");
  });

  it("degrades loudly when capture is unavailable — no silent fallback", async () => {
    const pcm = fakePcmSource({ available: false });
    const { handle, sent } = mountRealtime(pcm.source);

    key("keydown", "`");
    key("keydown", " "); // realtime capture can't start
    await wait(50);
    // A stray frame can't be emitted (start returned false) — no audio streams.
    expect(audioChunks(sent)).toHaveLength(0);

    const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
    // Names the fix and the alternatives; never silently switches backend.
    expect(status).toMatch(/realtime dictation needs/i);
    expect(status).toMatch(/openai|mock/i);
  });

  it("tells the user realtime transcription needs the channel (no port)", async () => {
    const pcm = fakePcmSource();
    const { factory } = fakeSocketFactory(() => ({ ok: true }));
    const handle = mountIntentTool({
      force: true,
      // no port → openThread rejects → no channel to stream to
      webSocketFactory: factory,
      modalities: [
        multimodalModality({ transcriber: "openai-realtime" }, { pcmSource: () => pcm.source }),
      ],
    });

    key("keydown", "`");
    key("keydown", " ");
    await wait(40);
    key("keyup", " "); // talk-end: no channel for the realtime session
    await wait(40);

    const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
    expect(status).toMatch(/realtime transcription needs the channel/i);
    expect(status).toMatch(/aiui claude|mock/i);
  });

  it("openai-voice streams PCM like openai-realtime (shares the capture path)", async () => {
    const pcm = fakePcmSource();
    // openai-voice is the flagship transcriber — it reuses the realtime PCM path.
    const { sent } = mountRealtime(pcm.source, { transcriber: "openai-voice" });

    key("keydown", "`");
    key("keydown", " "); // talk-start → PCM capture starts (usesPcmStream includes voice)
    await wait(50);
    expect(pcm.isStarted()).toBe(true);
    pcm.emit(Int16Array.of(1, 2, 3));
    await wait(20);
    expect(audioChunks(sent).length).toBeGreaterThan(0);
  });
});

/** Every `video` chunk frame the connection sent, decoded. */
function videoChunks(sent: Uint8Array[]) {
  return frames(sent)
    .map(
      (f) => f.envelope as { chunk?: { kind?: string; id?: string; seq?: number; mime?: string } },
    )
    .filter((e) => e.chunk?.kind === "video")
    .map((e) => e.chunk);
}

/**
 * Mount a live (realtime submode) tier: a stubbed PCM source (jsdom has no
 * AudioWorklet), a fast video sampler cadence so a few frames flow inside a
 * `wait()`, and a fake socket. `live-gemini` sets `submode:"realtime"`.
 */
function mountLive(over: Record<string, unknown> = {}) {
  const { factory, sent, push } = fakeSocketFactory(() => ({ ok: true }));
  const pcm = fakePcmSource();
  const handle = mountIntentTool({
    force: true,
    port: 4321,
    webSocketFactory: factory,
    modalities: [
      multimodalModality(
        { tier: "live-gemini", ...over },
        { pcmSource: () => pcm.source, videoSampleIntervalMs: 20 },
      ),
    ],
  });
  return { handle, sent, push, pcm };
}

describe("multimodalModality: help (H) and the condensed cheat sheet", () => {
  it("? toggles the panel; its body is the keymap table (H is hands-free talk)", async () => {
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    key("keydown", "`"); // arm — ? lives in the armed base layer
    key("keydown", "?");
    await flush();
    expect(handle.shadowRoot?.querySelector(".panel")?.hasAttribute("hidden")).toBe(false);
    const help = handle.shadowRoot?.querySelector(".mm-keymap-help");
    expect(help?.textContent).toContain("armed");
    expect(help?.textContent).toContain("hold to talk");
    expect(help?.textContent).toContain("hands-free talk");
    expect(help?.textContent).toContain("VS Code jump mode");
    key("keydown", "?");
    await flush();
    expect(handle.shadowRoot?.querySelector(".panel")?.hasAttribute("hidden")).toBe(true);
  });

  it("the cheat sheet shows the CURRENT state's icons while armed, and hides when off", async () => {
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    // The sheet lives in the widget's below-pill slot (shadow root) so it
    // rides the draggable root under the pill.
    const wrap = (): Element | null =>
      handle.shadowRoot?.querySelector(".below-slot .mm-cheat-wrap") ?? null;
    const caps = (): HTMLButtonElement[] => [
      ...(wrap()?.querySelectorAll<HTMLButtonElement>(".mm-keycap") ?? []),
    ];
    expect(wrap()?.classList.contains("visible")).toBe(false); // off → the ? teaches

    key("keydown", "`");
    await flush();
    expect(wrap()?.classList.contains("visible")).toBe(true);
    // Icons only — no kbd caps in the sheet body (keys live in the tooltip).
    const icons = caps().map((c) => c.textContent);
    expect(icons).toContain("📸"); // D — region shot
    expect(icons.some((i) => i?.includes("✏️"))).toBe(true); // the drag gesture row
    // Icon-only caps; an iconless row (esc) falls back to its key cap — the
    // one kbd allowed in the body.
    const kbds = [...(wrap()?.querySelectorAll(".mm-cheat kbd") ?? [])].map((k) => k.textContent);
    expect(kbds).toEqual(["esc"]);

    key("keydown", "t"); // tweak: the handover shrinks the sheet to its claims
    await flush();
    expect(caps().length).toBe(3); // arm · T · esc

    key("keydown", "`"); // disarm hides it
    await flush();
    expect(wrap()?.classList.contains("visible")).toBe(false);
  });

  it("cheat caps execute on click and reveal their key pill on hover", async () => {
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    key("keydown", "`");
    await flush();
    const wrap = (): Element | null =>
      handle.shadowRoot?.querySelector(".below-slot .mm-cheat-wrap") ?? null;
    const capFor = (icon: string): HTMLButtonElement | undefined =>
      [...(wrap()?.querySelectorAll<HTMLButtonElement>(".mm-keycap") ?? [])].find((c) =>
        c.textContent?.includes(icon),
      );

    // Hover: the tooltip shows the KEY as a kbd pill + the label.
    const shot = capFor("🖼");
    expect(shot).toBeDefined();
    shot?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await flush();
    const tip = wrap()?.querySelector(".mm-cheat-tip");
    expect(tip?.querySelector("kbd")?.textContent).toBe("S");
    expect(tip?.textContent).toContain("viewport shot");
    shot?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    await flush();
    expect(wrap()?.querySelector(".mm-cheat-tip")).toBeNull();

    // Click: the cap executes its command through the SAME resolver the
    // keyboard uses — ⚙️ (K) opens the config strip, ✕-free and stub-free.
    capFor("⚙️")?.click();
    await flush();
    expect(document.querySelector(".mm-config-strip")?.classList.contains("visible")).toBe(true);

    // Hands-free (🙌 = H, a real toggle) click-toggles; push-to-talk (🎙 =
    // Space) is deliberately keyboard-only — its cap is inert.
    key("keydown", "Escape"); // close the strip first (it claims digits/S)
    await flush();
    const state = (): string => handle.shadowRoot?.querySelector(".mm-state")?.textContent ?? "";
    capFor("🎙")?.click();
    await wait(30);
    expect(state()).not.toContain("REC"); // inert: a mouse can't "hold"
    capFor("🙌")?.click();
    await wait(30);
    expect(state()).toContain("REC");
    capFor("🙌")?.click();
    await wait(30);
    expect(state()).not.toContain("REC");
  });
});

/**
 * A scriptable {@link DisplayCapture}. The real broker's job here is to answer
 * one question — "is the blur that just fired one *we* caused?" — so the fake
 * lets a test say yes or no and nothing else.
 */
function fakeDisplayCapture(overrides: Partial<DisplayCapture> = {}): DisplayCapture {
  return {
    policy: () => "gesture",
    acquire: async (): Promise<CaptureOutcome> => "denied",
    prewarm: () => {},
    active: () => false,
    video: () => undefined,
    stream: () => undefined,
    lastError: () => undefined,
    blurIsSelfInflicted: () => false,
    dispose: () => {},
    ...overrides,
  };
}

describe("multimodalModality: window blur vs. the capture picker's blur", () => {
  const state = (handle: { shadowRoot: ShadowRoot | null }): string =>
    handle.shadowRoot?.querySelector(".mm-state")?.textContent ?? "";

  it("a real blur stops listening — a mic left open on another window bills for it", async () => {
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 }, true, {
      displayCapture: fakeDisplayCapture({ blurIsSelfInflicted: () => false }),
    });
    key("keydown", "`");
    key("keydown", "h"); // hands-free: listening survives the keyup
    await wait(30);
    expect(state(handle)).toContain("REC");

    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(state(handle)).not.toContain("REC");
  });

  it("the FIRST screenshot's own blur does not drop you out of hands-free mode", async () => {
    // getDisplayMedia blurs the window on every call, dialog or no dialog. That
    // blur used to look exactly like the user walking away — so the first shot
    // of a hands-free session silently stopped the mic, and every shot after it
    // (the grant already held, no call, no blur) worked fine. The regression is
    // precisely that asymmetry.
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 }, true, {
      displayCapture: fakeDisplayCapture({ blurIsSelfInflicted: () => true }),
    });
    key("keydown", "`");
    key("keydown", "h");
    await wait(30);
    expect(state(handle)).toContain("REC");

    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(state(handle)).toContain("REC");
  });
});

describe("multimodalModality: vscode jump mode (J — double-click opens the jump picker)", () => {
  /** A dblclick as the browser fires it (bubbles up to the document listener). */
  const dblclick = (el: Element): void => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  };
  const pickerEl = (): Element | null => document.querySelector(".mm-jump-picker");
  const pickerOpen = (): boolean => pickerEl()?.classList.contains("visible") ?? false;

  it("J enters the mode; double-click opens the picker; Enter commits the nearest stamp", async () => {
    const opened: string[] = [];
    // The Vite plugin seeds sourceRoot in real pages; getInstrumentation ??=
    // keeps a pre-seeded global, so set it before mount.
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/home/me/app" };
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 }, true, {
      navigate: (url) => opened.push(url),
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="vsc-fixture" data-source-loc="src/App.tsx:5:3"><span id="vsc-leaf">x</span></div>`,
    );
    try {
      key("keydown", "`"); // arm
      key("keydown", "j"); // enter vscode jump mode
      await flush();
      expect(q<HTMLElement>(handle, ".mm-state")?.textContent).toContain("vscode");

      dblclick(document.getElementById("vsc-leaf") as Element);
      await flush();
      // Two-step: the click itself never navigates — the picker opens, the
      // nearest stamp listed and the selection highlight up.
      expect(opened).toEqual([]);
      expect(pickerOpen()).toBe(true);
      expect(pickerEl()?.textContent).toContain("src/App.tsx:5:3");
      expect(document.querySelector(".mm-jump-highlight")?.classList.contains("visible")).toBe(
        true,
      );

      key("keydown", "Enter"); // commit the preselected nearest element
      await flush();
      expect(opened).toEqual(["vscode://file/home/me/app/src/App.tsx:5:3"]);
      expect(pickerOpen()).toBe(false);
      expect(handle.shadowRoot?.querySelector(".status")?.textContent).toContain(
        "vscode → src/App.tsx:5:3",
      );

      // The jump lands in the editor → this window blurs → the mode ends
      // (blurExits in the mode table): returning to the tab resumes composing.
      window.dispatchEvent(new Event("blur"));
      await flush();
      expect(q<HTMLElement>(handle, ".mm-state")?.textContent).toContain("ink");
      // Still armed — blur stepped out one level, not to off.
      expect(q<HTMLElement>(handle, ".mm-state")?.textContent).not.toBe("off");
    } finally {
      document.getElementById("vsc-fixture")?.remove();
    }
  });

  it("lists cells at their DEFINITION sites; arrows + Enter commit; Esc dismisses; misses are NAMED", async () => {
    const opened: string[] = [];
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/home/me/app" };
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 }, true, {
      navigate: (url) => opened.push(url),
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="vsc-fixture">
         <p id="vsc-bare">unstamped</p>
         <div data-cell="dashboard" data-cell-loc="src/model.ts:10">
           <div data-cell="catalog" data-cell-loc="src/model.ts:20">
             <span id="vsc-cell-leaf" data-source-loc="src/View.tsx:9:5">point</span>
           </div>
         </div>
       </div>`,
    );
    try {
      key("keydown", "`");
      key("keydown", "j");
      await flush();

      // Unstamped: the picker still opens and NAMES the miss; Esc dismisses
      // it without leaving jump mode.
      dblclick(document.getElementById("vsc-bare") as Element);
      await flush();
      expect(pickerOpen()).toBe(true);
      expect(pickerEl()?.textContent).toContain("no source location on or around this element");
      key("keydown", "Escape");
      await flush();
      expect(pickerOpen()).toBe(false);
      expect(q<HTMLElement>(handle, ".mm-state")?.textContent).toContain("vscode");

      // A stamped leaf inside nested cells: one element row + both cells at
      // their definition sites, nearest cell first.
      dblclick(document.getElementById("vsc-cell-leaf") as Element);
      await flush();
      const text = pickerEl()?.textContent ?? "";
      expect(text).toContain("src/View.tsx:9:5");
      expect(text).toContain("catalog");
      expect(text).toContain("src/model.ts:20");
      expect(text).toContain("dashboard");
      expect(text).toContain("src/model.ts:10");

      // ↓ ↓ walks nearest element → catalog → dashboard; Enter commits the
      // OUTERMOST cell at its definition site.
      key("keydown", "ArrowDown");
      key("keydown", "ArrowDown");
      key("keydown", "Enter");
      await flush();
      expect(opened).toEqual(["vscode://file/home/me/app/src/model.ts:10"]);
      expect(handle.shadowRoot?.querySelector(".status")?.textContent).toContain(
        "cell dashboard @ src/model.ts:10",
      );
    } finally {
      document.getElementById("vsc-fixture")?.remove();
    }
  });

  it("digits commit their numbered row directly", async () => {
    const opened: string[] = [];
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/home/me/app" };
    mountMultimodal({ transcriber: "mock", mockWordMs: 0 }, true, {
      navigate: (url) => opened.push(url),
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="vsc-fixture" data-source-loc="src/App.tsx:5:3">
         <section data-source-loc="src/Panel.tsx:12:5"><span id="vsc-leaf">x</span></section>
       </div>`,
    );
    try {
      key("keydown", "`");
      key("keydown", "j");
      dblclick(document.getElementById("vsc-leaf") as Element);
      await flush();
      key("keydown", "2"); // row 2: the OUTER element (nearest is row 1)
      await flush();
      expect(opened).toEqual(["vscode://file/home/me/app/src/App.tsx:5:3"]);
    } finally {
      document.getElementById("vsc-fixture")?.remove();
    }
  });

  it("double-clicks OUTSIDE vscode mode belong to the page — no picker, no jump", async () => {
    const opened: string[] = [];
    window.__AIUI__ = { v: 1, frames: [], sourceRoot: "/home/me/app" };
    mountMultimodal({ transcriber: "mock", mockWordMs: 0 }, true, {
      navigate: (url) => opened.push(url),
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="vsc-fixture" data-source-loc="src/App.tsx:5:3"></div>`,
    );
    try {
      key("keydown", "`"); // armed, but ink mode — the gesture is the page's
      dblclick(document.getElementById("vsc-fixture") as Element);
      await flush();
      expect(opened).toEqual([]);
      expect(pickerOpen()).toBe(false);
    } finally {
      document.getElementById("vsc-fixture")?.remove();
    }
  });
});

describe("multimodalModality: realtime submode screen share (V)", () => {
  it("V streams video-share + sampled JPEG frames; disarm stops the sampler", async () => {
    const restore = stubCapture();
    try {
      const { handle, sent } = mountLive();
      key("keydown", "`"); // arm
      key("keydown", "v"); // video-toggle → videoShare(true) opens the thread, sampler starts
      await wait(120); // socket connect + grant + immediate frame + a few 20ms intervals

      // The share's ON edge rode the events stream.
      const events = streamedEvents(sent);
      expect(
        events.some((e) => e.type === "video-share" && (e as { on?: boolean }).on === true),
      ).toBe(true);

      // Sampled frames flowed as `video` chunks — one share (vid_1), seq from 0.
      const vids = videoChunks(sent);
      expect(vids.length).toBeGreaterThan(0);
      expect(vids[0]).toMatchObject({ id: "vid_1", seq: 0, mime: "image/jpeg" });
      expect(vids.map((c) => c?.seq)).toEqual(vids.map((_, i) => i));
      // The raw JPEG bytes rode the payload (the stubbed canvas hands back PNG magic).
      const firstVideo = frames(sent).find(
        (f) => (f.envelope as { chunk?: { kind?: string } }).chunk?.kind === "video",
      );
      expect([...(firstVideo?.payload ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      // The badge shows while sharing (vanilla-written by renderHud: no flush).
      expect(q<HTMLElement>(handle, ".mm-video")?.hidden).toBe(false);

      key("keydown", "`"); // disarm → renderHud stops the sampler (share can't outlive the turn)
      await wait(60); // let the stop + any in-flight upload settle
      const settled = videoChunks(sent).length;
      await wait(60); // three more 20ms intervals would have fired if it were still running
      expect(videoChunks(sent).length).toBe(settled); // frozen — nothing new after disarm
      expect(q<HTMLElement>(handle, ".mm-video")?.hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it("toggling V off stops sampling and records the OFF edge (thread stays open)", async () => {
    const restore = stubCapture();
    try {
      const { handle, sent } = mountLive();
      key("keydown", "`");
      key("keydown", "v"); // on
      await wait(80);
      expect(videoChunks(sent).length).toBeGreaterThan(0);

      key("keydown", "v"); // off
      await wait(60);
      const settled = videoChunks(sent).length;
      await wait(60);
      expect(videoChunks(sent).length).toBe(settled); // no more frames
      expect(q<HTMLElement>(handle, ".mm-video")?.hidden).toBe(true);
      const shares = streamedEvents(sent).filter((e) => e.type === "video-share");
      expect(shares.map((e) => (e as { on?: boolean }).on)).toEqual([true, false]);
    } finally {
      restore();
    }
  });

  it("V with the linter off is inert with a hint (dispatch gates on linter)", async () => {
    const restore = stubCapture();
    try {
      const { handle, sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
      key("keydown", "`");
      key("keydown", "v");
      await wait(60);
      expect(videoChunks(sent)).toHaveLength(0);
      expect(streamedEvents(sent).some((e) => e.type === "video-share")).toBe(false);
      const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
      expect(status).toMatch(/needs the linter/i);
    } finally {
      restore();
    }
  });
});

/** A scriptable fake {@link SpeechAudioElement}: jsdom can't play, so the audio
 * element is injected; `end()` fires the `ended` listener to advance the queue. */
function fakeSpeechAudio() {
  const created: Array<{ src: string; played: boolean; paused: boolean; end: () => void }> = [];
  const factory = (src: string): SpeechAudioElement => {
    const listeners: Record<string, () => void> = {};
    const rec = { src, played: false, paused: false, end: () => listeners.ended?.() };
    created.push(rec);
    return {
      play: () => {
        rec.played = true;
      },
      pause: () => {
        rec.paused = true;
      },
      addEventListener: (type, listener) => {
        listeners[type] = listener;
      },
    };
  };
  return { factory, created };
}

/** Mount with an injected speech audio element + fake socket; audioBack on by default. */
function mountWithSpeech(
  over: Record<string, unknown>,
  speechAudio: (src: string) => SpeechAudioElement,
) {
  const { factory, sent, push } = fakeSocketFactory(() => ({ ok: true }));
  const handle = mountIntentTool({
    force: true,
    port: 4321,
    webSocketFactory: factory,
    modalities: [
      multimodalModality(
        { transcriber: "mock", mockWordMs: 0, mockTypoRate: 0, audioBack: "acks", ...over },
        { speechAudio },
      ),
    ],
  });
  return { handle, sent, push };
}

/** Arm + talk so the thread socket opens (and onServerMessage is wired). */
async function openThread(): Promise<void> {
  key("keydown", "`");
  key("keydown", " ");
  await wait(50);
  key("keyup", " ");
  await wait(20);
}

describe("multimodalModality: speech playback (premium/flagship audio-back)", () => {
  it("plays a pushed speech clip, shows the speaker line, clears on end", async () => {
    const audio = fakeSpeechAudio();
    const { handle, push } = mountWithSpeech({}, audio.factory);
    await openThread();

    push({ kind: "speech", id: "ack_0", mime: "audio/mpeg", data: btoa("clip"), label: "sent" });
    await flush();

    expect(audio.created).toHaveLength(1);
    expect(audio.created[0].src).toBe(`data:audio/mpeg;base64,${btoa("clip")}`);
    expect(audio.created[0].played).toBe(true);
    const speaker = q<HTMLElement>(handle, ".mm-speaker");
    expect(speaker.hidden).toBe(false);
    expect(speaker.textContent).toContain("sent");

    audio.created[0].end(); // the clip finishes
    await flush();
    expect(speaker.hidden).toBe(true);
  });

  it("does NOT play when audioBack is off (client-side mute)", async () => {
    const audio = fakeSpeechAudio();
    const { push } = mountWithSpeech({ audioBack: "off" }, audio.factory);
    await openThread();

    push({ kind: "speech", id: "ack_0", mime: "audio/mpeg", data: btoa("x"), label: "sent" });
    await flush();
    expect(audio.created).toHaveLength(0);
  });

  it("barge-in: a new talk-start stops the playing clip", async () => {
    const audio = fakeSpeechAudio();
    const { push } = mountWithSpeech({}, audio.factory);
    await openThread();

    push({ kind: "speech", id: "ack_0", mime: "audio/mpeg", data: btoa("x"), label: "sent" });
    await flush();
    expect(audio.created[0].played).toBe(true);

    key("keydown", " "); // talk-start again → barge-in ducks the clip
    await wait(20);
    expect(audio.created[0].paused).toBe(true);
  });
});

describe("multimodalModality: tiers via set_config (the agent path)", () => {
  let uninstallStorage: () => void;
  beforeEach(() => {
    uninstallStorage = installLocalStorage();
  });
  afterEach(() => {
    uninstallStorage();
  });

  type SetConfigOk = { ok: true; config: IntentPipelineConfig };

  it("switch tier rapid persists just {tier}; then flagship re-derives its fields", () => {
    // Vite intent empty → the base is pure `standard`, so the delta is the tier only.
    mountMultimodal({});
    const overlay = window.__aiui_overlay;
    expect(overlay).toBeDefined();

    const rapid = overlay?.call("set_config", { config: { tier: "rapid" } }) as SetConfigOk;
    expect(rapid.ok).toBe(true);
    // The persisted delta is JUST {tier} — no transcriber override frozen in.
    expect(loadIntentOverrides()).toEqual({ tier: "rapid" });
    // Tiers no longer pin a transcriber — the DEFAULT (Scribe) shows through.
    expect(rapid.config.transcriber).toBe("elevenlabs");

    // Switching to flagship re-derives flagship's fields (not rapid's frozen ones).
    const flagship = overlay?.call("set_config", { config: { tier: "flagship" } }) as SetConfigOk;
    expect(loadIntentOverrides()).toEqual({ tier: "flagship" });
    expect(flagship.config.transcriber).toBe("openai-voice");
    expect(flagship.config.audioBack).toBe("voice");
    expect(flagship.config.realtimeVoiceModel).toBe("gpt-realtime-2");
  });

  it("an explicit fine field still wins over the tier preset", () => {
    mountMultimodal({});
    const overlay = window.__aiui_overlay;
    const result = overlay?.call("set_config", {
      config: { tier: "flagship", model: "whisper-1" },
    }) as SetConfigOk;
    expect(result.config.transcriber).toBe("openai-voice"); // from the preset
    expect(result.config.model).toBe("whisper-1"); // explicit wins
  });

  it("rejects an unknown tier loudly (validated exactly like the panel)", () => {
    mountMultimodal({});
    const overlay = window.__aiui_overlay;
    expect(() => overlay?.call("set_config", { config: { tier: "deluxe" } })).toThrow(/tier/);
    expect(loadIntentOverrides()).toEqual({});
  });
});

describe("multimodalModality: advanced config panel", () => {
  let uninstallStorage: () => void;
  beforeEach(() => {
    uninstallStorage = installLocalStorage();
  });
  afterEach(() => {
    uninstallStorage();
  });

  /** The `meta.intent` on the connection's hello frame. */
  function helloIntent(sent: Uint8Array[]): Record<string, unknown> | undefined {
    const hello = frames(sent)[0]?.envelope as { meta?: { intent?: Record<string, unknown> } };
    return hello?.meta?.intent;
  }

  /** Arm + talk-start so a thread opens and the hello (with meta.intent) is sent. */
  async function openThreadForHello(): Promise<void> {
    key("keydown", "`");
    key("keydown", " ");
    await wait(50);
  }

  it("gear opens the editor over the full effective config", async () => {
    // Explicit mock (the shipped default is the real `openai` backend) so the
    // assertion below tests a subset present, not the default.
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    const panel = q<HTMLElement>(handle, ".mm-config");
    expect(panel.hidden).toBe(true);
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    await flush(); // hidden rides a signal now (Solid batches writes)
    expect(panel.hidden).toBe(false);
    const editor = q<HTMLTextAreaElement>(handle, ".mm-config-editor");
    const shown = JSON.parse(editor.value);
    // Every known key is present — it's the whole effective config, not a subset.
    expect(shown).toMatchObject({ talkMode: "hold", transcriber: "mock" });
  });

  it("applies a valid edit live + persists it; the next hello reflects it", async () => {
    const { handle, sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    const editor = q<HTMLTextAreaElement>(handle, ".mm-config-editor");
    const edited = JSON.parse(editor.value);
    expect(edited.talkMode).toBe("hold");
    edited.talkMode = "toggle";
    editor.value = JSON.stringify(edited);
    q<HTMLButtonElement>(handle, ".mm-config-apply").click();
    await flush(); // the message div renders from a signal

    // Persisted as a minimal delta, with a success message shown.
    expect(loadIntentOverrides()).toEqual({ talkMode: "toggle" });
    expect(q<HTMLElement>(handle, ".mm-config-msg").textContent).toContain("applied");

    // The next thread's hello carries the updated effective config.
    await openThreadForHello();
    expect(helloIntent(sent)).toMatchObject({ talkMode: "toggle" });
  });

  it("rejects an unknown key loudly and changes nothing", async () => {
    const { handle, sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    const editor = q<HTMLTextAreaElement>(handle, ".mm-config-editor");
    editor.value = JSON.stringify({ talkMdoe: "toggle" }); // typo
    q<HTMLButtonElement>(handle, ".mm-config-apply").click();
    await flush(); // the message div renders from a signal

    expect(q<HTMLElement>(handle, ".mm-config-msg").textContent).toContain(
      'unknown config key "talkMdoe"',
    );
    expect(loadIntentOverrides()).toEqual({}); // nothing persisted

    await openThreadForHello();
    expect(helloIntent(sent)).toMatchObject({ talkMode: "hold" }); // unchanged
  });

  it("rejects a type mismatch loudly, naming the expected type", async () => {
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    const editor = q<HTMLTextAreaElement>(handle, ".mm-config-editor");
    editor.value = JSON.stringify({ inkFadeSec: "wide" });
    q<HTMLButtonElement>(handle, ".mm-config-apply").click();
    await flush(); // the message div renders from a signal

    const msg = q<HTMLElement>(handle, ".mm-config-msg").textContent ?? "";
    expect(msg).toContain('"inkFadeSec"');
    expect(msg).toContain("must be a number");
    expect(loadIntentOverrides()).toEqual({});
  });

  it("reset clears the persisted layer and reverts to the base", async () => {
    localStorage.setItem(INTENT_CONFIG_STORAGE_KEY, JSON.stringify({ talkMode: "toggle" }));
    const { handle, sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    q<HTMLButtonElement>(handle, ".mm-config-reset").click();

    expect(loadIntentOverrides()).toEqual({});
    await openThreadForHello();
    expect(helloIntent(sent)).toMatchObject({ talkMode: "hold" });
  });

  it("layers DEFAULT ← vite intent ← persisted overrides in the hello", async () => {
    localStorage.setItem(INTENT_CONFIG_STORAGE_KEY, JSON.stringify({ talkMode: "toggle" }));
    const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 99 }); // vite option
    await openThreadForHello();
    expect(helloIntent(sent)).toMatchObject({
      talkMode: "toggle", // persisted override
      mockWordMs: 99, // vite intent option
      model: "gpt-4o-mini-transcribe", // DEFAULT (untouched by either layer)
    });
  });
});

describe("multimodalModality: the quick-config strip (the K layer)", () => {
  let uninstallStorage: () => void;
  beforeEach(() => {
    uninstallStorage = installLocalStorage();
  });
  afterEach(() => {
    uninstallStorage();
  });

  const strip = (): HTMLElement | null => document.querySelector(".mm-config-strip");
  const stripOpen = (): boolean => strip()?.classList.contains("visible") ?? false;
  const activeChip = (): string =>
    strip()?.querySelector(".mm-tier-chip.active")?.textContent ?? "";

  /** Every hello frame's meta.intent, in send order (one per thread socket). */
  function helloIntents(sent: Uint8Array[]): Record<string, unknown>[] {
    return frames(sent)
      .filter(({ envelope }) => (envelope as { kind?: string }).kind === "hello")
      .map(
        ({ envelope }) =>
          (envelope as { meta?: { intent?: Record<string, unknown> } }).meta?.intent ?? {},
      );
  }

  const MOCK = { transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 } as const;

  it("K opens the strip; a digit switches tier for the session only", async () => {
    const { sent } = mountMultimodal(MOCK);
    key("keydown", "`"); // arm
    expect(stripOpen()).toBe(false);
    key("keydown", "k");
    expect(stripOpen()).toBe(true);
    key("keydown", "2"); // GPT-4o Transcribe (request-response)
    await flush(); // the strip content is Solid-rendered (batched writes)
    expect(activeChip()).toContain("GPT-4o Transcribe");

    // Session-scoped: NOTHING persisted — a reload would return to the file config.
    expect(loadIntentOverrides()).toEqual({});

    // The next thread's hello carries the session engine's fields. (The
    // engine bundle SETS transcriber — unlike the old tier presets, picking
    // an engine overrides an explicit vite transcriber deliberately: the
    // strip's whole point is switching backends.)
    key("keydown", " ");
    await wait(50);
    expect(helloIntents(sent)[0]).toMatchObject({
      transcriber: "openai-realtime",
      realtimeModel: "gpt-4o-transcribe",
    });
  });

  it("clicking a tier chip (or an action) works like its key — the strip is mouse-operable", async () => {
    mountMultimodal(MOCK);
    key("keydown", "`"); // arm
    key("keydown", "k"); // open the strip
    expect(stripOpen()).toBe(true);
    await flush(); // the chips are Solid-rendered (batched writes)

    // Click the Scribe chip: same dispatch as pressing 3. (Regression: chips
    // used to be display-only spans — under the armed crosshair cursor they
    // read as broken buttons, and the mouse path silently did nothing.)
    const scribe = strip()?.querySelector<HTMLElement>('[data-engine="2"]');
    scribe?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(activeChip()).toContain("Scribe v2");
    expect(loadIntentOverrides()).toEqual({}); // still session-only

    // Click "Esc close" in the action row: closes the strip like the key.
    const close = strip()?.querySelector<HTMLElement>('[data-cmd="close"]');
    close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(stripOpen()).toBe(false);
  });

  it("a tier picked mid-thread waits for the thread to close", async () => {
    const { sent } = mountMultimodal(MOCK);
    key("keydown", "`");
    key("keydown", " "); // talk → thread opens
    await wait(50);
    key("keyup", " ");
    await wait(50);

    key("keydown", "k");
    key("keydown", "2"); // GPT-4o Transcribe — but a thread is open
    await flush(); // picking auto-dismisses; reopen to see the pending note
    expect(stripOpen()).toBe(false);
    key("keydown", "k");
    await flush();
    expect(strip()?.querySelector(".mm-strip-pending")?.textContent).toContain("GPT-4o Transcribe");
    expect(helloIntents(sent)[0]?.realtimeModel).not.toBe("gpt-4o-transcribe"); // this thread keeps its config

    key("keydown", "Escape"); // close the reopened strip (not the thread)
    expect(stripOpen()).toBe(false);
    key("keydown", "Enter"); // send → thread closes (and disarms) → the pending tier lands
    await wait(120);

    key("keydown", "`"); // re-arm — send disarmed
    key("keydown", " "); // next thread
    await wait(50);
    const hellos = helloIntents(sent);
    expect(hellos).toHaveLength(2);
    expect(hellos[1]).toMatchObject({
      transcriber: "openai-realtime",
      realtimeModel: "gpt-4o-transcribe",
    });
    expect(loadIntentOverrides()).toEqual({}); // still session-only
  });

  it("S persists the session layer for the site as a minimal delta", async () => {
    mountMultimodal(MOCK);
    key("keydown", "`");
    key("keydown", "k");
    key("keydown", "2"); // GPT-4o Transcribe, session layer (auto-dismisses)
    expect(loadIntentOverrides()).toEqual({});
    key("keydown", "k"); // reopen for the save
    key("keydown", "s"); // save
    expect(loadIntentOverrides()).toMatchObject({ realtimeModel: "gpt-4o-transcribe" });
    await flush(); // the strip content is Solid-rendered (batched writes)
    expect(strip()?.textContent).toContain("saved for this site");
  });

  it("R resets both layers back to the file (Vite) config", async () => {
    localStorage.setItem(INTENT_CONFIG_STORAGE_KEY, JSON.stringify({ talkMode: "toggle" }));
    const { sent } = mountMultimodal(MOCK);
    key("keydown", "`");
    key("keydown", "k");
    key("keydown", "2"); // GPT-4o Transcribe, session layer (auto-dismisses)
    key("keydown", "k"); // reopen for the reset
    key("keydown", "r"); // reset everything
    expect(loadIntentOverrides()).toEqual({});

    key("keydown", " ");
    await wait(50);
    const hello = helloIntents(sent)[0];
    expect(hello?.tier).toBeUndefined(); // the session tier did not survive
    expect(hello).toMatchObject({ talkMode: "hold", transcriber: "mock" });
  });

  it("Esc closes the strip without stepping out; disarming closes it too", () => {
    mountMultimodal(MOCK);
    key("keydown", "`");
    key("keydown", "k");
    expect(stripOpen()).toBe(true);
    key("keydown", "Escape");
    expect(stripOpen()).toBe(false);
    expect(document.body.classList.contains("mm-armed")).toBe(true); // still armed

    key("keydown", "k");
    expect(stripOpen()).toBe(true);
    key("keydown", "`"); // disarm
    expect(stripOpen()).toBe(false);
    expect(document.body.classList.contains("mm-armed")).toBe(false);
  });
});

describe("multimodalModality: selections on the wire", () => {
  /** Make `el`'s text the live document selection and fire selectionchange. */
  function selectText(el: HTMLElement): void {
    const range = document.createRange();
    range.selectNodeContents(el.firstChild ?? el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }

  it("opens the turn with the pre-arm page selection as an app-selection event, no context chunk", async () => {
    const para = document.createElement("p");
    para.setAttribute("data-cell", "flowCell");
    para.setAttribute("data-source-loc", "src/App.tsx:10:2");
    para.textContent = "the interesting selected words";
    document.body.append(para);
    const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });

    selectText(para); // BEFORE arming — the reported lost case
    await wait(200); // past the watcher's 150 ms debounce

    key("keydown", "`"); // arm
    key("keydown", " "); // talk-start → thread-open
    await wait(50);
    key("keyup", " ");
    await wait(50);
    key("keydown", "Enter"); // send → fin
    await wait(150);

    const events = streamedEvents(sent);
    const types = events.map((e) => e.type);
    // The selection opens the transcript, right after thread-open — a marked
    // positional event (the engine assigns `sel_N`, house style like shot_N).
    expect(types.indexOf("app-selection")).toBe(types.indexOf("thread-open") + 1);
    expect(events.find((e) => e.type === "app-selection")).toMatchObject({
      marker: "sel_1",
      text: "the interesting selected words",
      sourceLoc: "src/App.tsx:10:2",
      cell: "flowCell",
    });
    // The legacy send-time context frame is gone — the stream is the carrier.
    const kinds = frames(sent).map(
      (f) => (f.envelope as { chunk?: { kind?: string } }).chunk?.kind,
    );
    expect(kinds).not.toContain("context");
    para.remove();
  });

  it("streams an app-selection-drop when the chip is dismissed mid-turn", async () => {
    const para = document.createElement("p");
    para.textContent = "context to retract";
    document.body.append(para);
    const { handle, sent } = mountMultimodal({
      transcriber: "mock",
      mockWordMs: 0,
      mockTypoRate: 0,
    });

    selectText(para);
    await wait(200);
    key("keydown", "`");
    key("keydown", " "); // thread opens with the app-selection
    await wait(50);
    key("keyup", " ");
    await wait(50);

    // The panel chip's ✕ clears the watcher; with the thread open that must
    // retract the turn's selection on the stream too — by ITS marker, exactly
    // one (the shot-drop shape).
    const dismiss = handle.shadowRoot?.querySelector(".chip-dismiss") as HTMLButtonElement;
    dismiss.click();
    key("keydown", "Enter");
    await wait(150);

    const events = streamedEvents(sent);
    expect(events.find((e) => e.type === "app-selection")).toMatchObject({ marker: "sel_1" });
    expect(events.find((e) => e.type === "app-selection-drop")).toMatchObject({
      marker: "sel_1",
    });
    para.remove();
  });

  it("a new selection after content is its own event; a refinement supersedes its marker", async () => {
    const first = document.createElement("p");
    first.textContent = "the first selected words";
    const second = document.createElement("p");
    second.setAttribute("data-source-loc", "src/App.tsx:21:4");
    second.textContent = "a second, different selection";
    const refined = document.createElement("p");
    refined.textContent = "the second selection, refined by widening the drag";
    document.body.append(first, second, refined);
    const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });

    selectText(first);
    await wait(200); // past the watcher's 150 ms debounce
    key("keydown", "`");
    key("keydown", " "); // thread opens, seeded with the first selection
    await wait(50);
    key("keyup", " "); // the mock transcript-final lands — contentful
    await wait(50);

    // Re-selecting AFTER content landed: a NEW positional event, fresh marker.
    selectText(second);
    await wait(250);
    // Refining it with nothing contentful in between: SAME marker (one chip
    // tracking the drag — no spam).
    selectText(refined);
    await wait(250);
    key("keydown", "Enter");
    await wait(150);

    const selections = streamedEvents(sent).filter((e) => e.type === "app-selection");
    expect(selections.map((e) => (e as { marker?: string }).marker)).toEqual([
      "sel_1",
      "sel_2",
      "sel_2",
    ]);
    expect(selections.at(-1)).toMatchObject({
      text: "the second selection, refined by widening the drag",
    });
    first.remove();
    second.remove();
    refined.remove();
  });

  it("ingests a bus selection contribution as a structured code-selection event", async () => {
    // A minimal fake session bus: enough for the modality to subscribe and for
    // the test to inject the reader's publish.
    const contribHandlers: Array<(payload: unknown, from: string) => void> = [];
    const slots = new Map<string, unknown>();
    window.__AIUI__ = {
      v: 1,
      frames: [],
      session: {
        set: (slot: string, value: unknown) => void slots.set(slot, value),
        get: (slot: string) => slots.get(slot),
        on: () => () => {},
        publish: () => {},
        onPublish: (topic: string, handler: (payload: unknown, from: string) => void) => {
          if (topic === "contribution") {
            contribHandlers.push(handler);
          }
          return () => {};
        },
        peers: () => [],
        onPeers: () => () => {},
        ready: () => true,
        onReady: (handler: () => void) => {
          handler();
          return () => {};
        },
        clientId: () => "test",
      },
    } as unknown as typeof window.__AIUI__;

    const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });
    contribHandlers[0]?.(
      {
        kind: "selection",
        text: "export function curb() {}",
        sourceLoc: "src/c.ts:12:1",
        url: "http://localhost/code",
        lines: 1,
      },
      "peer",
    );
    await wait(120); // socket connect + events flush

    const events = streamedEvents(sent);
    // Structured on the wire — not a pre-rendered transcript-final.
    expect(events.find((e) => e.type === "code-selection")).toMatchObject({
      text: "export function curb() {}",
      sourceLoc: "src/c.ts:12:1",
      lines: 1,
    });
    expect(
      events.some(
        (e) =>
          e.type === "transcript-final" && (e as { text?: string }).text?.includes("Regarding"),
      ),
    ).toBe(false);
    // The reader's mirror travels structured (defer-rendering: the panel
    // renders its own chips from `items`); `text` stays as the legacy flat
    // rendering with the compact marker.
    expect(slots.get("preview")).toMatchObject({
      text: "[code: src/c.ts:12:1 “export function curb() {}”]",
      items: [
        {
          kind: "code-selection",
          sourceLoc: "src/c.ts:12:1",
          excerpt: "export function curb() {}",
          lines: 1,
          marker: "code_1",
        },
      ],
    });
  });

  it("mirrors app selections to the session bus as structured items", async () => {
    const slots = new Map<string, unknown>();
    window.__AIUI__ = {
      v: 1,
      frames: [],
      session: {
        set: (slot: string, value: unknown) => void slots.set(slot, value),
        get: (slot: string) => slots.get(slot),
        on: () => () => {},
        publish: () => {},
        onPublish: () => () => {},
        peers: () => [],
        onPeers: () => () => {},
        ready: () => true,
        onReady: (handler: () => void) => {
          handler();
          return () => {};
        },
        clientId: () => "test",
      },
    } as unknown as typeof window.__AIUI__;

    const para = document.createElement("p");
    para.setAttribute("data-source-loc", "src/App.tsx:10:2");
    para.textContent = "the interesting selected words";
    document.body.append(para);
    mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });

    selectText(para);
    await wait(200);
    key("keydown", "`");
    key("keydown", " "); // thread opens, seeded with the selection
    await wait(50);
    key("keyup", " ");
    await wait(50);

    // The mirror carries the selection as a structured item — locator +
    // clipped excerpt + marker; the full text stays on the stream event.
    const snapshot = slots.get("preview") as { items?: Array<Record<string, unknown>> };
    const item = snapshot.items?.find((i) => i.kind === "app-selection");
    expect(item).toMatchObject({
      marker: "sel_1",
      sourceLoc: "src/App.tsx:10:2",
      excerpt: "the interesting selected words",
    });
    para.remove();
  });
});

describe("multimodalModality: tweak mode (the §B.5 handover)", () => {
  const MOCK = { transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 } as const;

  /** The overlay's own agent report — the one answer to "what mode am I in". */
  const report = () => {
    const r = window.__aiui_overlay?.report();
    if (!r) {
      throw new Error("overlay tools not installed");
    }
    return r;
  };

  /** Arm + speak one mock segment, leaving an open, composing thread. */
  async function composeTurn(): Promise<void> {
    key("keydown", "`");
    key("keydown", " ");
    await wait(50); // socket connect + hello
    key("keyup", " ");
    await wait(50); // mock transcript-final lands
  }

  it("T releases pointer + keyboard mid-thread: the page keeps a Space, untouched", async () => {
    const { handle } = mountMultimodal(MOCK);
    await composeTurn();
    expect(report().threadOpen).toBe(true);
    const inkCanvas = document.querySelector<HTMLElement>(".mm-ink");
    expect(inkCanvas?.style.pointerEvents).toBe("auto"); // composing owns the pointer

    key("keydown", "t"); // the handover
    expect(report().mode).toBe("tweak");
    expect(report().uiMode).toBe("tweaking");
    expect(q(handle, ".mm-state")?.textContent).toContain("tweak");
    // The pointer went back to the app (ink-routing) and the crosshair
    // dropped with it (no cursor in tweaking's mode-table row).
    expect(inkCanvas?.style.pointerEvents).toBe("none");
    expect(document.body.classList.contains("mm-armed")).toBe(false);

    // A Space aimed at the app's own UI: unclaimed (no preventDefault), no talk.
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    document.dispatchEvent(space);
    await wait(20);
    expect(space.defaultPrevented).toBe(false); // the page got it
    expect(report().talking).toBe(false);

    // Enter passes too — nothing must be able to send from inside tweak.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.dispatchEvent(enter);
    await wait(20);
    expect(enter.defaultPrevented).toBe(false);
    expect(report().threadOpen).toBe(true); // nothing sent, nothing closed
  });

  it("entering tweak mid-D-hold cancels the veil — nothing is stranded", async () => {
    mountMultimodal(MOCK);
    await composeTurn();
    const veil = document.querySelector<HTMLElement>(".mm-shot-veil");
    key("keydown", "d"); // arm the region veil
    expect(veil?.style.display).toBe("block");

    key("keydown", "t"); // handover — the shot-veil guard must clear the hold
    expect(report().uiMode).toBe("tweaking");
    expect(veil?.style.display).toBe("none");

    // D's keyup arrives during tweak and falls through to the page, harmlessly.
    key("keyup", "d");
    expect(veil?.style.display).toBe("none");
  });

  it("T again resumes the SAME turn: Space talks, and the thread never closed", async () => {
    const { sent } = mountMultimodal(MOCK);
    await composeTurn();
    key("keydown", "t"); // out…
    await wait(20);
    key("keydown", "t"); // …and back
    expect(report().mode).toBe("ink");
    expect(report().uiMode).toBe("composing");

    key("keydown", " "); // Space talks again (mock: synchronous)
    expect(report().talking).toBe(true);
    key("keyup", " ");
    await wait(50);
    key("keydown", "Enter"); // send
    await wait(120);

    const events = streamedEvents(sent);
    const types = events.map((e) => e.type);
    // One thread for the whole excursion: opened once, closed once (the send).
    expect(types.filter((t) => t === "thread-open")).toHaveLength(1);
    expect(types.filter((t) => t === "thread-close")).toHaveLength(1);
    // Both segments — one either side of the excursion — rode the same stream,
    // and the excursion itself is IN it (the mode events, so the trace shows it).
    expect(types.filter((t) => t === "transcript-final")).toHaveLength(2);
    const modes = events.filter((e) => e.type === "mode").map((e) => (e as { mode?: string }).mode);
    expect(modes).toEqual(["tweak", "ink"]);
  });

  it("Esc steps out of tweak back to composing — one rung, never a cancel", async () => {
    mountMultimodal(MOCK);
    await composeTurn();
    key("keydown", "t");
    expect(report().uiMode).toBe("tweaking");
    key("keydown", "Escape");
    expect(report().uiMode).toBe("composing");
    expect(report().threadOpen).toBe(true);
  });

  it("a selection made during tweak appends to the open turn — the point of the mode", async () => {
    const para = document.createElement("p");
    para.setAttribute("data-source-loc", "src/App.tsx:7:3");
    para.textContent = "select different text mid-tweak";
    document.body.append(para);
    const { sent } = mountMultimodal(MOCK);
    await composeTurn();
    key("keydown", "t"); // handover — the pointer is the app's again

    // The user re-selects on the page; the watcher stays live (§B.5: selection
    // events are not gated on mode — they ride the open thread).
    const range = document.createRange();
    range.selectNodeContents(para.firstChild ?? para);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await wait(250); // the watcher's 150 ms debounce + the events flush

    const selections = streamedEvents(sent).filter((e) => e.type === "app-selection");
    expect(selections.at(-1)).toMatchObject({
      text: "select different text mid-tweak",
      sourceLoc: "src/App.tsx:7:3",
    });
    expect(report().threadOpen).toBe(true); // …and the turn is still open for more
    para.remove();
  });
});

describe("multimodalModality: shift-click jump picker (no jump mode needed)", () => {
  const pickerEl = (): Element | null => document.querySelector(".mm-jump-picker");
  const inkEl = (): HTMLCanvasElement =>
    document.querySelector<HTMLCanvasElement>(".mm-ink") as HTMLCanvasElement;
  const shiftClick = (el: Element): void => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
  };
  /**
   * jsdom does no hit-testing and has no `elementsFromPoint`, so a test can
   * dispatch a click on ANY element — including targets a browser could never
   * produce. Stand in for the browser's z-ordered stack under the cursor.
   */
  const stubStack = (...stack: Element[]): void => {
    (
      document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }
    ).elementsFromPoint = () => stack;
  };
  afterEach(() => {
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("opens the picker THROUGH the armed ink canvas; Esc dismisses without leaving ink", async () => {
    window.__AIUI__ = { ...(window.__AIUI__ ?? {}), sourceRoot: "/repo" } as never;
    const stamped = document.createElement("div");
    stamped.dataset.sourceLoc = "src/App.tsx:5:3";
    document.body.append(stamped);
    mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    key("keydown", "`"); // armed, ink mode — NOT jump mode
    // The premise this test exists for: the pen layer owns the pointer, so the
    // canvas — never `stamped` — is what a real browser hands the click to.
    const inkCanvas = inkEl();
    expect(inkCanvas.style.pointerEvents).toBe("auto");
    stubStack(inkCanvas, stamped, document.body);
    shiftClick(inkCanvas);
    await flush();
    expect(pickerEl()?.classList.contains("visible")).toBe(true);
    expect(pickerEl()?.textContent).toContain("App.tsx:5:3"); // it saw *through* to the app
    key("keydown", "Escape"); // the picker layer claims Esc wherever it is open
    expect(pickerEl()?.classList.contains("visible")).toBe(false);
    stamped.remove();
  });

  it("opens the picker in jump mode, where the pen layer is inactive", async () => {
    window.__AIUI__ = { ...(window.__AIUI__ ?? {}), sourceRoot: "/repo" } as never;
    const stamped = document.createElement("div");
    stamped.dataset.sourceLoc = "src/App.tsx:7:3";
    document.body.append(stamped);
    mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    key("keydown", "`");
    key("keydown", "j"); // jump mode releases the pointer: the app IS the target
    expect(inkEl().style.pointerEvents).toBe("none");
    shiftClick(stamped);
    await flush();
    expect(pickerEl()?.classList.contains("visible")).toBe(true);
    stamped.remove();
  });

  it("stays inert in tweak mode (the page owns the pointer there)", async () => {
    const stamped = document.createElement("div");
    stamped.dataset.sourceLoc = "src/App.tsx:9:3";
    document.body.append(stamped);
    mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    key("keydown", "`");
    key("keydown", "t"); // tweak handover
    shiftClick(stamped);
    await flush();
    expect(pickerEl()?.classList.contains("visible") ?? false).toBe(false);
    stamped.remove();
  });

  it("leaves our own chrome opaque — a shift-click on the widget is not the app", async () => {
    const stamped = document.createElement("div");
    stamped.dataset.sourceLoc = "src/App.tsx:11:3";
    document.body.append(stamped);
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    key("keydown", "`");
    // The widget stacks ABOVE the ink canvas, so it — not the pen layer — is
    // the target. Nothing may be seen through it, even with the app beneath.
    stubStack(stamped, document.body);
    const widgetHost = handle.shadowRoot?.host as Element;
    shiftClick(widgetHost);
    await flush();
    expect(pickerEl()?.classList.contains("visible") ?? false).toBe(false);
    stamped.remove();
  });
});
