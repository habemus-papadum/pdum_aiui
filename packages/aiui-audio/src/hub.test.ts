import { describe, expect, it, vi } from "vitest";
import { createAudioHub } from "./hub";
import type { AudioDriver, InputSource } from "./types";

function fakeDriver() {
  let emit: Parameters<AudioDriver["onPcm"]>[0] = () => {};
  let route: string | undefined;
  let pending: (() => void) | undefined;
  const releases = vi.fn();
  const driver: AudioDriver = {
    capture: vi.fn(async (_source: InputSource, signal: AbortSignal) => {
      await Promise.resolve();
      if (signal.aborted) throw new Error("cancelled");
      return releases;
    }),
    route: vi.fn(async (id) => {
      pending?.();
      pending = undefined;
      route = id;
    }),
    flush: vi.fn(async () => {
      pending?.();
      pending = undefined;
    }),
    stream: vi.fn(() => ({ getAudioTracks: () => [] }) as unknown as MediaStream),
    removeStream: vi.fn(),
    level: () => 0.5,
    settings: () => undefined,
    applyConstraints: vi.fn(async () => {}),
    onPcm(cb) {
      emit = cb;
    },
    dispose: vi.fn(),
  };
  return {
    driver,
    releases,
    send: () => {
      if (route) emit(route, new Float32Array([0.5]), 24000);
    },
    buffer: () => {
      const id = route;
      pending = () => {
        if (id) emit(id, new Float32Array([0.5]), 24000);
      };
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("audio hub", () => {
  it("owns one capture while routing exclusively, parking, and restoring", async () => {
    const fake = fakeDriver();
    const hub = createAudioHub({ driver: fake.driver });
    const a = hub.pcmInput({ id: "dictation", label: "Dictation" });
    const b = hub.pcmInput({ id: "oracle", label: "Oracle" });
    const first = vi.fn(),
      second = vi.fn();
    await a.start(first);
    await b.start(second);
    await hub.selectInput(a.id);
    await hub.startMicrophone();
    await tick();
    fake.send();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    const editing = hub.temporarilyRouteInput(b.id);
    await tick();
    fake.send();
    expect(second).toHaveBeenCalledTimes(1);
    await hub.parkInput();
    fake.send();
    expect(hub.level()).toBe(0.5);
    expect(hub.snapshot().activeInput).toBeUndefined();
    await editing.release();
    fake.send();
    expect(first).toHaveBeenCalledTimes(1);
    await hub.resumeInput();
    fake.send();
    expect(first).toHaveBeenCalledTimes(2);
    expect(fake.driver.capture).toHaveBeenCalledTimes(1);
    b.stop();
    expect(fake.releases).not.toHaveBeenCalled();
    await hub.dispose();
    expect(fake.releases).toHaveBeenCalledTimes(1);
  });
  it("manual selection wins over a stale temporary release", async () => {
    const fake = fakeDriver();
    const hub = createAudioHub({ driver: fake.driver });
    for (const id of ["a", "b", "c"]) hub.pcmInput({ id, label: id });
    await hub.selectInput("a");
    const temporary = hub.temporarilyRouteInput("b");
    await hub.selectInput("c");
    await temporary.release();
    expect(hub.snapshot().selectedInput).toBe("c");
    await hub.dispose();
  });
  it("finishes buffered samples on the original route, never replays parking", async () => {
    const fake = fakeDriver();
    const hub = createAudioHub({ driver: fake.driver });
    const a = hub.pcmInput({ id: "a", label: "A" }),
      b = hub.pcmInput({ id: "b", label: "B" });
    const first = vi.fn(),
      second = vi.fn();
    await a.start(first);
    await b.start(second);
    await hub.selectInput("a");
    await hub.startMicrophone();
    await tick();
    fake.buffer();
    await hub.selectInput("b");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await hub.parkInput();
    fake.buffer();
    await hub.resumeInput();
    expect(second).not.toHaveBeenCalled();
    await hub.dispose();
  });
  it("unready consumers never seize the microphone or close another connection", async () => {
    const fake = fakeDriver();
    const hub = createAudioHub({ driver: fake.driver });
    const a = hub.streamInput({ id: "a", label: "A" });
    const b = hub.streamInput({ id: "b", label: "B" });
    await hub.selectInput("a");
    await hub.startMicrophone();
    await tick();
    expect(hub.snapshot().activeInput).toBeUndefined();
    b.setEnabled(true);
    await tick();
    expect(hub.snapshot().activeInput).toBeUndefined();
    a.setEnabled(true);
    await tick();
    expect(hub.snapshot().activeInput).toBe("a");
    b.dispose();
    expect(fake.releases).not.toHaveBeenCalled();
    await hub.dispose();
  });
  it("stopping during permission acquisition disposes the late capture", async () => {
    const fake = fakeDriver();
    let resolve!: (close: () => void) => void;
    fake.driver.capture = () =>
      new Promise((r) => {
        resolve = r;
      });
    const hub = createAudioHub({ driver: fake.driver });
    const started = hub.startMicrophone();
    const rejected = expect(started).rejects.toThrow("cancelled");
    await tick();
    hub.stopMicrophone();
    resolve(fake.releases);
    await rejected;
    await tick();
    expect(hub.snapshot().capture).toBe("off");
    expect(fake.releases).toHaveBeenCalled();
    await hub.dispose();
  });
  it("a superseded acquire's signal is aborted at once, not at the 60 s ceiling", async () => {
    const fake = fakeDriver();
    const signals: AbortSignal[] = [];
    // A permission prompt nobody answers; the driver honours the abort the way
    // browser.ts does (its release listens on the signal).
    fake.driver.capture = (_source: InputSource, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const hub = createAudioHub({ driver: fake.driver });
    const microphone = hub.startMicrophone();
    const superseded = expect(microphone).rejects.toThrow("superseded");
    await tick();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    const recording = hub.startRecording(new Float32Array([1]), 24000); // a new source supersedes
    const cancelled = expect(recording).rejects.toThrow("cancelled");
    await tick();
    expect(signals[0].aborted).toBe(true); // pulled immediately — no timer advanced
    expect(signals).toHaveLength(2); // and the chain moved on to the new source at once
    expect(hub.snapshot().capture).toBe("starting");
    expect(hub.snapshot().error).toBeUndefined(); // the abort we asked for is not a fault
    await superseded;
    await hub.dispose();
    await cancelled;
  });
  it("switches capture source without replacing consumer endpoints", async () => {
    const fake = fakeDriver();
    const hub = createAudioHub({ driver: fake.driver });
    const a = hub.streamInput({ id: "a", label: "A" });
    await hub.startMicrophone();
    await tick();
    await hub.startRecording(new Float32Array([1]), 24000, { loop: true });
    await tick();
    expect(hub.snapshot().source).toBe("recording");
    expect(fake.releases).toHaveBeenCalledTimes(1);
    expect(hub.snapshot().inputs[0].id).toBe(a.id);
    await hub.dispose();
  });
});

it("playback selection and mute are independent of input parking", async () => {
  const fake = fakeDriver();
  const hub = createAudioHub({ driver: fake.driver });
  const a = hub.output({ id: "a", label: "A" });
  const b = hub.output({ id: "b", label: "B" });
  const element = () =>
    ({
      autoplay: false,
      srcObject: null,
      volume: 1,
      muted: false,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    }) as unknown as HTMLAudioElement;
  const first = element(),
    second = element();
  a.attach({} as MediaStream, first);
  b.attach({} as MediaStream, second);
  hub.selectOutput("a");
  expect(first.muted).toBe(false);
  expect(second.muted).toBe(true);
  await hub.parkInput();
  expect(first.muted).toBe(false);
  hub.muteOutput(true);
  expect(first.muted).toBe(true);
  hub.selectOutput("b");
  hub.muteOutput(false);
  hub.setVolume(0.4);
  expect(first.muted).toBe(true);
  expect(second.muted).toBe(false);
  expect(second.volume).toBe(0.4);
  a.dispose();
  expect(first.srcObject).toBeNull();
  expect(second.srcObject).not.toBeNull();
  await hub.dispose();
  expect(second.srcObject).toBeNull();
});
