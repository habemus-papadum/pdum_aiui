// @vitest-environment jsdom
import { decodeFrame, jsonCodec } from "@habemus-papadum/aiui-claude-channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountIntentTool, unmountIntentTool } from "../intent";
import type { IntentEvent, IntentPipelineConfig } from "../intent-pipeline";
import { fakeSocketFactory } from "../test-support/fake-socket";
import { installLocalStorage } from "../test-support/local-storage";
import { INTENT_CONFIG_STORAGE_KEY, loadIntentOverrides } from "./advanced-config";
import type { PcmSource } from "./audio";
import { multimodalModality } from "./modality";
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

/** Mount the multimodal modality alone (no text tab), wired to a fake socket. */
function mountMultimodal(config: Parameters<typeof multimodalModality>[0], ackOk = true) {
  const { factory, sent, push } = fakeSocketFactory(() => ({ ok: ackOk }));
  const handle = mountIntentTool({
    force: true,
    port: 4321,
    webSocketFactory: factory,
    modalities: [multimodalModality(config)],
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
      const { sent } = mountMultimodal({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0 });

      key("keydown", "`"); // arm
      key("keydown", " "); // talk-start — the mock path has no mic await, so this
      //                      runs to completion synchronously in the dispatch.

      // Talking is live already, without the getUserMedia promise ever settling —
      // the mock path has no await, so renderHud() ran synchronously in dispatch.
      expect(document.querySelector(".mm-state")?.textContent).toContain("REC");
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
          model: "gpt-4o-mini-transcribe",
        },
      ],
    });
    await flush();
    expect(body.textContent).toContain("reaction diffusion on the GPU");
  });

  it("applies a correction echo's patch and does not re-stream the resolution", async () => {
    const { sent, push } = mountMultimodal({
      transcriber: "mock",
      corrector: "openai",
      mockWordMs: 0,
      mockTypoRate: 0,
      diffFlashMs: 0,
    });
    const CANNED = "make the baseline curve a bit thicker and color it amber";

    key("keydown", "`"); // arm
    key("keydown", " ");
    await wait(30);
    key("keyup", " "); // mock transcription → CANNED lands in the preview
    await wait(60);
    key("keydown", "e"); // correct mode → the document opens in the top editor
    await wait(20);

    // Mark the whole document in the top editor (send-time selection).
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    editArea.setSelectionRange(0, editArea.value.length);

    // Type the fix + Enter → a patchless correction REQUEST goes to the server.
    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    input.value = "corrected";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(30);

    const requestCorrections = streamedEvents(sent).filter((e) => e.type === "correction");
    expect(requestCorrections).toHaveLength(1);
    expect((requestCorrections[0] as { patch?: string }).patch).toBeUndefined();

    // Server echoes the completed correction with a patch; the client applies it.
    push({
      kind: "lowered",
      events: [
        {
          at: Date.now(),
          type: "correction",
          from: 0,
          to: CANNED.length,
          original: CANNED,
          instruction: "corrected",
          via: "typed",
          patch: `*** Begin Patch\n*** Update File: transcript\n@@\n-${CANNED}\n+the corrected line\n*** End Patch`,
          model: "gpt-4o-mini",
          latencyMs: 1200,
        },
      ],
    });
    await wait(20);

    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.textContent).toContain("the corrected line");
    // The resolution must NOT have been re-streamed (server already merged it).
    const streamedPatched = streamedEvents(sent).filter(
      (e) => e.type === "correction" && (e as { patch?: string }).patch !== undefined,
    );
    expect(streamedPatched).toHaveLength(0);
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
          model: "gpt-4o-mini-transcribe",
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

  it("says why a correction fell back to plain replacement (channel corrector, no patch echo)", async () => {
    const { handle, sent, push } = mountMultimodal({
      transcriber: "mock",
      corrector: "openai",
      mockWordMs: 0,
      mockTypoRate: 0,
      diffFlashMs: 0,
    });
    const CANNED = "make the baseline curve a bit thicker and color it amber";

    key("keydown", "`"); // arm
    key("keydown", " ");
    await wait(30);
    key("keyup", " "); // mock transcription → CANNED lands in the preview
    await wait(60);
    key("keydown", "e"); // correct mode

    // Mark the whole document in the TOP editor (the span a fix targets now
    // lives in the edit area's native selection, read at send time).
    const editArea = document.querySelector(".mm-edit-area") as HTMLTextAreaElement;
    editArea.setSelectionRange(0, editArea.value.length);

    const input = document.querySelector(".mm-correction-bar textarea") as HTMLTextAreaElement;
    input.value = "corrected";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(30);

    // Confirm the patchless request was sent, then have the server echo a
    // completed correction WITHOUT a patch (its diff-failure fallback).
    expect(streamedEvents(sent).filter((e) => e.type === "correction")).toHaveLength(1);
    push({
      kind: "lowered",
      events: [
        {
          at: Date.now(),
          type: "correction",
          from: 0,
          to: CANNED.length,
          original: CANNED,
          instruction: "corrected",
          via: "typed",
          // no patch → the client applies a plain replacement and must say why
        },
      ],
    });
    await wait(20);

    const status = handle.shadowRoot?.querySelector(".status")?.textContent ?? "";
    expect(status).toMatch(/plain replacement/i);
    // The correction still landed (never silently vanishes).
    const body = document.querySelector(".mm-preview-body") as HTMLElement;
    expect(body.textContent).toContain("corrected");
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
    const { push } = mountWithSpeech({}, audio.factory);
    await openThread();

    push({ kind: "speech", id: "ack_0", mime: "audio/mpeg", data: btoa("clip"), label: "sent" });
    await flush();

    expect(audio.created).toHaveLength(1);
    expect(audio.created[0].src).toBe(`data:audio/mpeg;base64,${btoa("clip")}`);
    expect(audio.created[0].played).toBe(true);
    const speaker = document.querySelector(".mm-speaker") as HTMLElement;
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
    expect(rapid.config.transcriber).toBe("openai-realtime");

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

  const q = <T extends Element>(handle: { shadowRoot?: ShadowRoot | null }, sel: string): T =>
    handle.shadowRoot?.querySelector(sel) as T;

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

  it("gear opens the editor over the full effective config", () => {
    // Explicit mock for both seams (the shipped defaults are the real `openai`
    // backends) so the assertion below tests a subset present, not the default.
    const { handle } = mountMultimodal({ transcriber: "mock", corrector: "mock", mockWordMs: 0 });
    const panel = q<HTMLElement>(handle, ".mm-config");
    expect(panel.hidden).toBe(true);
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    expect(panel.hidden).toBe(false);
    const editor = q<HTMLTextAreaElement>(handle, ".mm-config-editor");
    const shown = JSON.parse(editor.value);
    // Every known key is present — it's the whole effective config, not a subset.
    expect(shown).toMatchObject({ talkMode: "hold", transcriber: "mock", corrector: "mock" });
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

    expect(q<HTMLElement>(handle, ".mm-config-msg").textContent).toContain(
      'unknown config key "talkMdoe"',
    );
    expect(loadIntentOverrides()).toEqual({}); // nothing persisted

    await openThreadForHello();
    expect(helloIntent(sent)).toMatchObject({ talkMode: "hold" }); // unchanged
  });

  it("rejects a type mismatch loudly, naming the expected type", () => {
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
    q<HTMLButtonElement>(handle, ".mm-gear").click();
    const editor = q<HTMLTextAreaElement>(handle, ".mm-config-editor");
    editor.value = JSON.stringify({ inkFadeSec: "wide" });
    q<HTMLButtonElement>(handle, ".mm-config-apply").click();

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
      corrector: "openai", // DEFAULT (the shipped real backend)
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
    key("keydown", "3"); // rapid
    expect(activeChip()).toContain("rapid");

    // Session-scoped: NOTHING persisted — a reload would return to the file config.
    expect(loadIntentOverrides()).toEqual({});

    // The next thread's hello carries the session tier; the Vite fine field
    // (transcriber: mock) still wins over the preset.
    key("keydown", " ");
    await wait(50);
    expect(helloIntents(sent)[0]).toMatchObject({ tier: "rapid", transcriber: "mock" });
  });

  it("clicking a tier chip (or an action) works like its key — the strip is mouse-operable", () => {
    mountMultimodal(MOCK);
    key("keydown", "`"); // arm
    key("keydown", "k"); // open the strip
    expect(stripOpen()).toBe(true);

    // Click the rapid chip: same dispatch as pressing 3. (Regression: chips
    // used to be display-only spans — under the armed crosshair cursor they
    // read as broken buttons, and the mouse path silently did nothing.)
    const rapid = strip()?.querySelector<HTMLElement>('[data-tier="rapid"]');
    rapid?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(activeChip()).toContain("rapid");
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
    key("keydown", "5"); // flagship — but a thread is open
    expect(strip()?.querySelector(".mm-strip-pending")?.textContent).toContain("flagship");
    expect(helloIntents(sent)[0]?.tier).toBeUndefined(); // this thread keeps its config

    key("keydown", "Escape"); // close the strip (not the thread)
    expect(stripOpen()).toBe(false);
    key("keydown", "Enter"); // send → thread closes (and disarms) → the pending tier lands
    await wait(120);

    key("keydown", "`"); // re-arm — send disarmed
    key("keydown", " "); // next thread
    await wait(50);
    const hellos = helloIntents(sent);
    expect(hellos).toHaveLength(2);
    expect(hellos[1]).toMatchObject({ tier: "flagship" });
    expect(loadIntentOverrides()).toEqual({}); // still session-only
  });

  it("S persists the session layer for the site as a minimal delta", () => {
    mountMultimodal(MOCK);
    key("keydown", "`");
    key("keydown", "k");
    key("keydown", "3"); // rapid, session layer
    expect(loadIntentOverrides()).toEqual({});
    key("keydown", "s"); // save
    expect(loadIntentOverrides()).toEqual({ tier: "rapid" });
    expect(strip()?.textContent).toContain("saved for this site");
  });

  it("R resets both layers back to the file (Vite) config", async () => {
    localStorage.setItem(INTENT_CONFIG_STORAGE_KEY, JSON.stringify({ talkMode: "toggle" }));
    const { sent } = mountMultimodal(MOCK);
    key("keydown", "`");
    key("keydown", "k");
    key("keydown", "5"); // flagship, session layer
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
