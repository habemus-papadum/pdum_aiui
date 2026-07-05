// @vitest-environment jsdom
import { decodeFrame, jsonCodec } from "@habemus-papadum/aiui-claude-channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountIntentTool, unmountIntentTool } from "../intent";
import type { IntentEvent } from "../intent-pipeline";
import { fakeSocketFactory } from "../test-support/fake-socket";
import { installLocalStorage } from "../test-support/local-storage";
import { INTENT_CONFIG_STORAGE_KEY, loadIntentOverrides } from "./advanced-config";
import { multimodalModality } from "./modality";

afterEach(() => {
  unmountIntentTool();
  delete window.__AIUI__;
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
      key("keydown", "s"); // S down: arm the shot
      key("keyup", "s"); // S tap (no drag): viewport shot → opens thread, uploads bytes
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
    key("keydown", "e"); // correct mode → the preview text becomes selectable
    await wait(20);

    // Select the whole segment's text node, then let the preview capture it.
    const seg = document.querySelector(".mm-preview-body .mm-seg") as HTMLElement;
    const textNode = seg.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.textContent?.length ?? 0);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document
      .querySelector(".mm-preview-body")
      ?.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await wait(20);

    // Type the fix + Enter → a patchless correction REQUEST goes to the server.
    const input = document.querySelector(".mm-correction-bar input") as HTMLInputElement;
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
    const { handle } = mountMultimodal({ transcriber: "mock", mockWordMs: 0 });
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
      corrector: "mock", // DEFAULT
    });
  });
});
