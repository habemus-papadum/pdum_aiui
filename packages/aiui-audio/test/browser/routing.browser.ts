import { expect, test } from "@playwright/test";
import type { AudioHub } from "../../src/hub";

declare global {
  interface Window {
    audioTest: {
      hub: AudioHub;
      counts: { a: number; b: number };
      start(): Promise<void>;
      temporary(): void;
      restore(): Promise<void> | undefined;
      streamLevel(): number;
      trackState(): string;
      stop(): Promise<void>;
    };
  }
}
test("real worklet routes recorded audio, meters while parked, and preserves stream tracks", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/test/browser/");
  await page.evaluate(() => window.audioTest.start());
  await expect.poll(() => page.evaluate(() => window.audioTest.counts.a)).toBeGreaterThan(1000);
  await expect
    .poll(() => page.evaluate(() => window.audioTest.hub.snapshot().activeInput))
    .toBe("a");
  await page.evaluate(() => window.audioTest.temporary());
  await expect.poll(() => page.evaluate(() => window.audioTest.counts.b)).toBeGreaterThan(1000);
  await page.evaluate(() => window.audioTest.hub.parkInput());
  const parked = await page.evaluate(() => ({ ...window.audioTest.counts }));
  await expect.poll(() => page.evaluate(() => window.audioTest.hub.level())).toBeGreaterThan(0.1);
  await page.evaluate(() => window.audioTest.restore());
  expect(await page.evaluate(() => window.audioTest.counts)).toEqual(parked);
  expect(await page.evaluate(() => window.audioTest.hub.snapshot().activeInput)).toBeUndefined();
  await page.evaluate(() => window.audioTest.hub.resumeInput());
  await expect.poll(() => page.evaluate(() => window.audioTest.counts.a)).toBeGreaterThan(parked.a);
  await page.evaluate(() => window.audioTest.hub.selectInput("stream"));
  await expect.poll(() => page.evaluate(() => window.audioTest.streamLevel())).toBeGreaterThan(0.1);
  await page.evaluate(() => window.audioTest.hub.parkInput());
  await expect.poll(() => page.evaluate(() => window.audioTest.streamLevel())).toBe(0);
  expect(await page.evaluate(() => window.audioTest.trackState())).toBe("live");
  await page.evaluate(() => window.audioTest.hub.stopMicrophone());
  await expect.poll(() => page.evaluate(() => window.audioTest.hub.snapshot().capture)).toBe("off");
  expect(await page.evaluate(() => window.audioTest.trackState())).toBe("live");
  await page.evaluate(() => window.audioTest.stop());
  expect(errors).toEqual([]);
});
test("fake browser microphone can be enabled and released through the widget", async ({ page }) => {
  await page.goto("/test/browser/");
  await page.getByRole("button", { name: "Enable microphone", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.audioTest.hub.snapshot().capture))
    .toBe("active");
  await page.getByRole("button", { name: "Microphone off", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.audioTest.hub.snapshot().capture)).toBe("off");
  await page.evaluate(() => window.audioTest.hub.dispose());
});

test("worklet setup failure releases a granted microphone and exposes the error", async ({
  page,
}) => {
  await page.goto("/test/browser/");
  const result = await page.evaluate(async () => {
    const { createAudioHub } = await import("../../src/index");
    let track: MediaStreamTrack | undefined;
    let requested: MediaStreamConstraints | undefined;
    const hub = createAudioHub({
      workletUrl: "/missing-audio-worklet.js",
      getUserMedia: async (constraints) => {
        requested = constraints;
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        track = stream.getAudioTracks()[0];
        return stream;
      },
    });
    let rejected = false;
    try {
      await hub.startMicrophone();
    } catch {
      rejected = true;
    }
    const state = hub.snapshot();
    await hub.dispose();
    return {
      rejected,
      state: state.capture,
      error: !!state.error,
      track: track?.readyState,
      constraints: requested?.audio,
    };
  });
  expect(result).toMatchObject({
    rejected: true,
    state: "error",
    error: true,
    track: "ended",
    constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
});

test("recording completion flushes the last partial worklet block before going off", async ({
  page,
}) => {
  await page.goto("/test/browser/");
  await page.evaluate(() => window.audioTest.start());
  const before = await page.evaluate(() => window.audioTest.counts.a);
  await page.evaluate(() =>
    window.audioTest.hub.startRecording(new Float32Array(13000).fill(0.2), 24000),
  );
  await expect.poll(() => page.evaluate(() => window.audioTest.hub.snapshot().capture)).toBe("off");
  const delivered = await page.evaluate(() => window.audioTest.counts.a);
  // 26,000 bytes includes a tail shorter than the worklet's 100ms block.
  expect(delivered - before).toBeGreaterThanOrEqual(25_000);
  await page.evaluate(() => window.audioTest.stop());
});
