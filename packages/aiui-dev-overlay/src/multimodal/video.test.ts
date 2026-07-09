import { describe, expect, it, vi } from "vitest";
import { sampleDimensions, VIDEO_MAX_WIDTH, VideoSampler } from "./video";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("sampleDimensions", () => {
  it("downscales a wide source to the max width, keeping aspect", () => {
    expect(sampleDimensions(1920, 1080)).toEqual({ width: VIDEO_MAX_WIDTH, height: 576 });
    // 1024/1920 * 1080 = 576.
  });

  it("never upscales a source already narrower than the cap", () => {
    expect(sampleDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("honors an explicit maxWidth and rounds the height", () => {
    expect(sampleDimensions(1000, 333, 500)).toEqual({ width: 500, height: 167 }); // 500/1000*333 = 166.5 → 167
  });

  it("returns 0×0 for a not-yet-ready (zero-size) source", () => {
    expect(sampleDimensions(0, 0)).toEqual({ width: 0, height: 0 });
    expect(sampleDimensions(1024, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("VideoSampler", () => {
  it("samples immediately on start, then on the interval, with an increasing seq", async () => {
    const frames: Array<{ seq: number; byte: number }> = [];
    let n = 0;
    const sampler = new VideoSampler({
      captureFrame: async () => Uint8Array.of(++n),
      sendFrame: (frame, bytes) => frames.push({ seq: frame.seq, byte: bytes[0] }),
      intervalMs: 10,
    });

    sampler.start();
    expect(sampler.sharing).toBe(true);
    await wait(35);
    // The immediate frame plus ~3 interval frames; seqs count from 0, in order.
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));

    const count = frames.length;
    sampler.stop();
    expect(sampler.sharing).toBe(false);
    await wait(30);
    expect(frames.length).toBe(count); // no frames after stop
  });

  it("a fresh share resets the seq to 0", async () => {
    const seqs: number[] = [];
    const sampler = new VideoSampler({
      captureFrame: async () => Uint8Array.of(1),
      sendFrame: (frame) => seqs.push(frame.seq),
      intervalMs: 10,
    });
    sampler.start();
    await wait(25);
    sampler.stop();
    const firstRun = [...seqs];
    seqs.length = 0;
    sampler.start(); // a new share
    await wait(15);
    sampler.stop();
    expect(firstRun[0]).toBe(0);
    expect(seqs[0]).toBe(0); // reset, not continued
  });

  it("pause holds sampling and resume continues it (blur/focus)", async () => {
    const frames: number[] = [];
    const sampler = new VideoSampler({
      captureFrame: async () => Uint8Array.of(1),
      sendFrame: (frame) => frames.push(frame.seq),
      intervalMs: 10,
    });
    sampler.start();
    await wait(25);
    const atPause = frames.length;
    sampler.pause();
    expect(sampler.sharing).toBe(true); // still "sharing", just paused
    await wait(30);
    expect(frames.length).toBe(atPause); // nothing streamed while paused

    sampler.resume();
    await wait(25);
    expect(frames.length).toBeGreaterThan(atPause); // continued after refocus
    // The seq run continued (never reset by pause/resume).
    expect(frames).toEqual(frames.map((_, i) => i));
  });

  it("drops a frame whose capture resolves after stop() (no stale stream)", async () => {
    let release!: (bytes: Uint8Array) => void;
    const frames: number[] = [];
    const sampler = new VideoSampler({
      captureFrame: () => new Promise<Uint8Array>((resolve) => (release = resolve)),
      sendFrame: (frame) => frames.push(frame.seq),
      intervalMs: 1000,
    });
    sampler.start(); // fires the immediate tick, which awaits captureFrame
    await wait(5);
    sampler.stop(); // the share ends before the frame resolves
    release(Uint8Array.of(9)); // ...now it resolves
    await wait(5);
    expect(frames).toHaveLength(0);
  });
});

describe("frame timing", () => {
  it("stamps each frame's takenAt and its offset from the share's start", async () => {
    vi.useFakeTimers();
    try {
      let clock = 1000;
      const frames: Array<{ seq: number; takenAt: number; offsetMs: number }> = [];
      const sampler = new VideoSampler({
        captureFrame: () => Promise.resolve(new Uint8Array([1])),
        sendFrame: (frame) => frames.push(frame),
        intervalMs: 100,
        now: () => clock,
      });
      sampler.start(); // startedAt = 1000
      await vi.advanceTimersByTimeAsync(0);
      clock = 1100;
      await vi.advanceTimersByTimeAsync(100);
      clock = 1200;
      await vi.advanceTimersByTimeAsync(100);
      sampler.stop();
      expect(frames).toEqual([
        { seq: 0, takenAt: 1000, offsetMs: 0 },
        { seq: 1, takenAt: 1100, offsetMs: 100 },
        { seq: 2, takenAt: 1200, offsetMs: 200 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("smart mode's shouldCapture gate", () => {
  it("always fires the share's first frame, gate or no gate", async () => {
    vi.useFakeTimers();
    try {
      const frames: number[] = [];
      const sampler = new VideoSampler({
        captureFrame: () => Promise.resolve(new Uint8Array([1])),
        sendFrame: (frame) => frames.push(frame.seq),
        intervalMs: 100,
        shouldCapture: () => false, // nothing ever changed
      });
      sampler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(frames).toEqual([0]);
      await vi.advanceTimersByTimeAsync(500); // five ticks, all declined
      expect(frames).toEqual([0]);
      sampler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a declined tick costs nothing — no capture, and seq stays put", async () => {
    vi.useFakeTimers();
    try {
      let captures = 0;
      let dirty = false;
      const frames: number[] = [];
      const sampler = new VideoSampler({
        captureFrame: () => {
          captures += 1;
          return Promise.resolve(new Uint8Array([1]));
        },
        sendFrame: (frame) => frames.push(frame.seq),
        intervalMs: 100,
        shouldCapture: () => {
          const was = dirty;
          dirty = false;
          return was;
        },
      });
      sampler.start();
      await vi.advanceTimersByTimeAsync(0); // forced first frame
      await vi.advanceTimersByTimeAsync(300); // three quiet ticks
      expect(frames).toEqual([0]);
      expect(captures).toBe(1);

      dirty = true; // the user clicked something
      await vi.advanceTimersByTimeAsync(100);
      expect(frames).toEqual([0, 1]); // seq 1, not seq 4
      await vi.advanceTimersByTimeAsync(200);
      expect(frames).toEqual([0, 1]); // and it went quiet again
      sampler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes the gate on the forced first frame too — a pre-arm click doesn't linger", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      let dirty = true; // clicked V's key, say
      const sampler = new VideoSampler({
        captureFrame: () => Promise.resolve(new Uint8Array([1])),
        sendFrame: (frame) => calls.push(frame.seq),
        intervalMs: 100,
        shouldCapture: () => {
          const was = dirty;
          dirty = false;
          return was;
        },
      });
      sampler.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual([0]); // the second tick found a cleared flag
      sampler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not consume the gate on a tick it can't service (in-flight capture)", async () => {
    vi.useFakeTimers();
    try {
      let release!: (bytes: Uint8Array) => void;
      let gateReads = 0;
      const sampler = new VideoSampler({
        captureFrame: () => new Promise<Uint8Array>((resolve) => (release = resolve)),
        sendFrame: () => {},
        intervalMs: 100,
        shouldCapture: () => {
          gateReads += 1;
          return true;
        },
      });
      sampler.start(); // tick 0 blocks in captureFrame
      await vi.advanceTimersByTimeAsync(0);
      expect(gateReads).toBe(1);
      await vi.advanceTimersByTimeAsync(300); // three ticks arrive while in flight
      expect(gateReads).toBe(1); // ...and none of them touched the gate
      release(new Uint8Array([1]));
      sampler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dynamic cadence (the fps slider's thunk)", () => {
  it("re-reads the interval thunk before every gap — a change lands on the next frame", async () => {
    vi.useFakeTimers();
    try {
      let interval = 100;
      const sent: number[] = [];
      const sampler = new VideoSampler({
        captureFrame: () => Promise.resolve(new Uint8Array([1])),
        sendFrame: (frame) => sent.push(frame.seq),
        intervalMs: () => interval,
      });
      sampler.start();
      await vi.advanceTimersByTimeAsync(0); // the immediate first frame
      expect(sent).toEqual([0]);
      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toEqual([0, 1]);

      interval = 1000; // the slider moved — no restart needed
      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toEqual([0, 1, 2]); // this gap was already armed at 100
      await vi.advanceTimersByTimeAsync(999);
      expect(sent).toEqual([0, 1, 2]); // the new 1000 ms gap holds…
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([0, 1, 2, 3]); // …and fires on schedule
      sampler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
