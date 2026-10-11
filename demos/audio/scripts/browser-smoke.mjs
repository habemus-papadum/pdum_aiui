/** Real browser + real vendor, using a spoken WAV instead of a microphone.
 * Start the Audio demo dev server first. Keys are passed only to the ephemeral page.
 * Usage: node --env-file=../../.env scripts/browser-smoke.mjs /path/to/speech.wav
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const filename = process.argv[2];
if (!filename) throw new Error("Pass a spoken WAV fixture as the first argument");
const elevenlabs = process.env.ELEVEN_LABS_API_KEY ?? process.env.ELEVENLABS_API_KEY;
if (!elevenlabs) throw new Error("Set ELEVEN_LABS_API_KEY");
const openai = process.env.OPENAI_API_KEY;
const recording = [...(await readFile(filename))];
const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
try {
  const page = await browser.newPage();
  await page.goto(process.env.AUDIO_DEMO_URL ?? "http://127.0.0.1:5193");
  await page
    .getByRole("heading", { name: "One microphone, different listeners" })
    .waitFor({ timeout: 15_000 });
  await page.evaluate(
    async ({ elevenlabs, openai, recording }) => {
      window.__AIUI__.devKeys = { elevenlabs, ...(openai ? { openai } : {}) };
      const { current } = await import("/src/model/store.ts");
      const model = current.get();
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(new Uint8Array(recording).buffer);
      const samples = new Float32Array(decoded.getChannelData(0));
      const rate = decoded.sampleRate;
      await context.close();
      // Warm source before dictation, then replace silence with the speech fixture.
      await model.hub.startRecording(new Float32Array(24000), 24000, { loop: true });
      await model.dictate();
      await model.hub.startRecording(samples, rate);
    },
    { elevenlabs, openai, recording },
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await import("/src/model/store.ts")).current.get().hub.snapshot().capture,
        ),
      { timeout: 30_000 },
    )
    .toBe("off");
  const transcript = await page.evaluate(async () => {
    const model = (await import("/src/model/store.ts")).current.get();
    await model.finish();
    return model.draft.get();
  });
  assert.ok(transcript.trim().length > 0, "Expected a final transcript from the spoken fixture");
  if (process.argv[3])
    assert.ok(
      transcript.toLowerCase().includes(process.argv[3].toLowerCase()),
      "Transcript did not contain the expected phrase",
    );
  console.log(JSON.stringify({ stage: "dictation", transcript }));
  if (openai) {
    await page.evaluate(async () => {
      const model = (await import("/src/model/store.ts")).current.get();
      await model.hub.parkInput();
      await model.edit();
      model.oracle.sendText(
        'Use replace_text now to append the exact words "Browser test complete." to the current draft. Preserve everything else.',
      );
    });
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await import("/src/model/store.ts")).current.get().draft.get(),
          ),
        { timeout: 30_000 },
      )
      .toContain("Browser test complete.");
    await expect(page.locator(".audio-demo-transcript")).toContainText("Browser test complete.");
    const restored = await page.evaluate(async () => {
      const model = (await import("/src/model/store.ts")).current.get();
      await model.returnToDictation();
      return {
        parked: model.hub.snapshot().parked,
        selected: model.hub.snapshot().selectedInput,
        stt: model.stt.status(),
        oracle: model.oracle.state().status,
      };
    });
    assert.deepEqual(restored, {
      parked: true,
      selected: "dictation",
      stt: "ready",
      oracle: "parked",
    });
    console.log(JSON.stringify({ stage: "edit-and-restore", ...restored }));
  }
  await page.evaluate(async () => {
    const model = (await import("/src/model/store.ts")).current.get();
    await model.close();
    await model.hub.dispose();
  });
} finally {
  await browser.close();
}
