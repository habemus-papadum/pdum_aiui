import { expect, type Page } from "@playwright/test";
import type { SttEvent } from "../../src/index";

export const fixtures = [
  {
    name: "garden",
    text: "The red balloon floats above the quiet garden. We are testing speech recognition in the browser with a recorded voice.",
  },
  { name: "harbor", text: "Seven blue boats are waiting in the harbor." },
] as const;

export async function openHarness(page: Page) {
  await page.goto("/test/browser/");
  await page.waitForFunction(() => !!window.sttTest);
}

export async function transcribe(page: Page, name: string) {
  const segment = await page.evaluate(() => window.sttTest.stt.beginSegment());
  const timing = await page.evaluate((name) => window.sttTest.play(name), name);
  await expect
    .poll(() => page.evaluate(() => window.sttTest.hub.snapshot().capture), { timeout: 15_000 })
    .toBe("off");
  const commitAt = await page.evaluate(() => performance.now());
  expect(await page.evaluate(() => window.sttTest.finish())).toEqual([]);
  const events = await page.evaluate(() => window.sttTest.events);
  const finals = events.filter(
    (entry): entry is { at: number; event: Extract<SttEvent, { type: "final" }> } =>
      entry.event.type === "final" && entry.event.segment === segment,
  );
  expect(finals).toHaveLength(1);
  const firstPartial = events.find(
    ({ event, at }) =>
      event.type === "delta" && event.segment === segment && !!event.text && at >= timing.startedAt,
  );
  expect(firstPartial, "Expected a nonempty streaming transcript before commit").toBeDefined();
  expect(firstPartial?.at).toBeLessThan(commitAt);
  return {
    fixture: name,
    segment,
    text: finals[0].event.result.text,
    durationMs: Math.round(timing.durationMs),
    firstPartialMs: Math.round((firstPartial?.at ?? 0) - timing.startedAt),
    finalAfterCommitMs: finals[0].event.result.latencyMs,
  };
}
