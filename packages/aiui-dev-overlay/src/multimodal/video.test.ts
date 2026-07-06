import { describe, expect, it } from "vitest";
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
      sendFrame: (seq, bytes) => frames.push({ seq, byte: bytes[0] }),
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
      sendFrame: (seq) => seqs.push(seq),
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
      sendFrame: (seq) => frames.push(seq),
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
      sendFrame: (seq) => frames.push(seq),
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
