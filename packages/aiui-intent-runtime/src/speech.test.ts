import { describe, expect, it } from "vitest";
import { type SpeechAudioElement, SpeechPlayer } from "./speech";

/** A scriptable fake audio element: records src + play/pause, and lets the test
 * fire `ended`/`error` to advance the queue (jsdom can't actually play audio). */
function fakeAudio() {
  const created: Array<{
    src: string;
    play: () => void;
    pause: () => void;
    end: () => void;
    error: () => void;
    played: boolean;
    paused: boolean;
  }> = [];
  const factory = (src: string): SpeechAudioElement => {
    const listeners: Record<string, () => void> = {};
    const rec = {
      src,
      played: false,
      paused: false,
      play: () => {},
      pause: () => {},
      end: () => listeners.ended?.(),
      error: () => listeners.error?.(),
    };
    const element: SpeechAudioElement = {
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
    rec.play = () => element.play();
    rec.pause = () => element.pause();
    created.push(rec);
    return element;
  };
  return { factory, created };
}

const clip = (id: string, label?: string) => ({
  id,
  mime: "audio/wav",
  data: btoa(id),
  ...(label !== undefined ? { label } : {}),
});

describe("SpeechPlayer", () => {
  it("plays one clip and reports its label; clears on end", () => {
    const audio = fakeAudio();
    const labels: Array<string | undefined> = [];
    let idle = 0;
    const player = new SpeechPlayer({
      createAudio: audio.factory,
      onSpeak: (l) => labels.push(l),
      onIdle: () => idle++,
    });
    player.enqueue(clip("ack_0", "sent"));
    expect(audio.created).toHaveLength(1);
    expect(audio.created[0].src).toBe(`data:audio/wav;base64,${btoa("ack_0")}`);
    expect(audio.created[0].played).toBe(true);
    expect(labels).toEqual(["sent"]);
    expect(player.active).toBe(true);

    audio.created[0].end();
    expect(idle).toBe(1);
    expect(player.active).toBe(false);
  });

  it("serializes the queue: the next clip plays only after the previous ends", () => {
    const audio = fakeAudio();
    const player = new SpeechPlayer({ createAudio: audio.factory });
    player.enqueue(clip("a"));
    player.enqueue(clip("b"));
    // Only the first has started; the second waits.
    expect(audio.created).toHaveLength(1);
    audio.created[0].end();
    expect(audio.created).toHaveLength(2);
    expect(audio.created[1].src).toContain(btoa("b"));
  });

  it("barge-in stops the current clip, drops the queue, and ignores its late end", () => {
    const audio = fakeAudio();
    const player = new SpeechPlayer({ createAudio: audio.factory });
    player.enqueue(clip("a"));
    player.enqueue(clip("b"));
    player.bargeIn();
    expect(audio.created[0].paused).toBe(true);
    expect(player.active).toBe(false);
    // A late `ended` from the stopped clip must NOT resurrect the dropped queue.
    audio.created[0].end();
    expect(audio.created).toHaveLength(1);
  });

  it("advances past a clip whose play() throws (no wedged queue)", () => {
    const throwingFactory = (): SpeechAudioElement => ({
      play: () => {
        throw new Error("autoplay blocked");
      },
      pause: () => {},
      addEventListener: () => {},
    });
    const player = new SpeechPlayer({ createAudio: throwingFactory });
    // The first clip's play throws; the player must still drain (not stay active).
    player.enqueue(clip("a"));
    expect(player.active).toBe(false);
  });
});

// ── the streamed-PCM lane (gapless chunk scheduling; whole-clip retired) ─────

interface FakeSource {
  buffer: unknown;
  startedAt: number | undefined;
  stopped: boolean;
  onended: (() => void) | null;
  connect(dest: unknown): void;
  start(when?: number): void;
  stop(): void;
}

function fakeContext(initialState = "running") {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0,
    state: initialState,
    resumed: 0,
    resume() {
      ctx.resumed += 1;
      ctx.state = "running";
    },
    destination: {},
    createBuffer(_ch: number, frames: number, rate: number) {
      return {
        getChannelData: () => new Float32Array(frames),
        duration: frames / rate,
      };
    },
    createBufferSource(): FakeSource {
      const source: FakeSource = {
        buffer: undefined,
        startedAt: undefined,
        stopped: false,
        onended: null,
        connect: () => {},
        start: (when?: number) => {
          source.startedAt = when ?? 0;
        },
        stop: () => {
          source.stopped = true;
          source.onended?.();
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { ctx, sources };
}

/** 24k PCM16 chunk of `frames` samples, base64-encoded. */
const pcmChunk = (id: string, seq: number, frames: number) => ({
  id,
  seq,
  mime: "audio/pcm;rate=24000",
  data: btoa(String.fromCharCode(...new Uint8Array(frames * 2))),
});

describe("SpeechPlayer (streamed PCM)", () => {
  it("schedules chunks the moment they arrive, back-to-back (gapless)", () => {
    const { ctx, sources } = fakeContext();
    const player = new SpeechPlayer({ createContext: () => ctx });
    player.feedChunk(pcmChunk("lint_0", 0, 2400)); // 100 ms
    player.feedChunk(pcmChunk("lint_0", 1, 2400));
    expect(sources).toHaveLength(2);
    expect(sources[0].startedAt).toBe(0);
    expect(sources[1].startedAt).toBeCloseTo(0.1, 5); // right after the first
    expect(player.active).toBe(true);
  });

  it("a NEW stream id starts fresh scheduling (the previous reply ended upstream)", () => {
    const { ctx, sources } = fakeContext();
    const player = new SpeechPlayer({ createContext: () => ctx });
    player.feedChunk(pcmChunk("lint_0", 0, 2400));
    ctx.currentTime = 5; // time passed; the old stream played out
    player.feedChunk(pcmChunk("lint_1", 0, 2400));
    expect(sources[1].startedAt).toBe(5); // scheduled NOW, not after the old tail
  });

  it("cancelStream stops the CURRENT stream's scheduled sources (speech-cancel)", () => {
    const { ctx, sources } = fakeContext();
    const player = new SpeechPlayer({ createContext: () => ctx });
    player.feedChunk(pcmChunk("oracle_0", 0, 2400));
    player.feedChunk(pcmChunk("oracle_0", 1, 2400));
    player.cancelStream("oracle_0");
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(player.active).toBe(false);
    // A cancel for a stream that is no longer current is a no-op.
    player.feedChunk(pcmChunk("oracle_1", 0, 2400));
    player.cancelStream("oracle_0");
    expect(sources[2].stopped).toBe(false);
  });

  it("bargeIn silences streams too (talk-start over a streaming reply)", () => {
    const { ctx, sources } = fakeContext();
    const player = new SpeechPlayer({ createContext: () => ctx });
    player.feedChunk(pcmChunk("lint_0", 0, 2400));
    player.bargeIn();
    expect(sources[0].stopped).toBe(true);
    expect(player.active).toBe(false);
  });

  it("a suspended context (no gesture yet) requests resume and reports blocked once", () => {
    const { ctx } = fakeContext("suspended");
    let blocked = 0;
    const player = new SpeechPlayer({ createContext: () => ctx, onBlocked: () => blocked++ });
    player.feedChunk(pcmChunk("lint_0", 0, 2400));
    player.feedChunk(pcmChunk("lint_0", 1, 2400));
    expect(ctx.resumed).toBeGreaterThan(0);
    expect(blocked).toBe(1); // once per blocked stretch, not per chunk
  });
});
