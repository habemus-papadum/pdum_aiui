import { writeFile } from "node:fs/promises";
import { mintScribeToken, scribeSocketUrl } from "@habemus-papadum/cf-creds-elevenlabs";
import { expect, test } from "@playwright/test";
import { fixtures, openHarness, transcribe } from "./helpers";

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

test("ElevenLabs transcribes fixtures, survives parking, and recovers after cancellation", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const key = process.env.ELEVEN_LABS_API_KEY ?? process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("Opt-in live test requires ELEVEN_LABS_API_KEY (incurs vendor usage)");
  let mints = 0;
  await page.exposeFunction("mintScribeUrl", async () => {
    mints++;
    // Only the fresh single-use URL crosses into the browser. Never log credentials.
    const { token } = await mintScribeToken(key);
    return scribeSocketUrl(token);
  });
  const results: Awaited<ReturnType<typeof transcribe>>[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await openHarness(page);
    await page.evaluate(() => window.sttTest.stt.connect());
    for (const fixture of fixtures) {
      const result = await transcribe(page, fixture.name);
      results.push(result);
      expect(normalize(result.text)).toBe(normalize(fixture.text));
      // Loose regression ceilings, not an SLA or a statistical latency benchmark.
      expect(result.firstPartialMs).toBeLessThan(10_000);
      expect(result.finalAfterCommitMs).toBeLessThan(10_000);
      if (fixture.name === "garden") {
        await page.evaluate(() => window.sttTest.hub.parkInput());
        // Real elapsed time beyond the observed idle timeout; no fake clock in live tests.
        await page.waitForTimeout(16_000);
        expect(await page.evaluate(() => window.sttTest.stt.status())).toBe("ready");
        await page.evaluate(() => window.sttTest.hub.resumeInput());
      }
    }
    expect(mints).toBe(1);
    expect(
      await page.evaluate(() => window.sttTest.events.filter((e) => e.event.type === "error")),
    ).toEqual([]);
    const cancelled = await page.evaluate(async () => {
      const id = window.sttTest.stt.beginSegment();
      await window.sttTest.play("garden", true);
      return id;
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              window.sttTest.events.some(
                ({ event }) => event.type === "delta" && event.segment === id && !!event.text,
              ),
            cancelled,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.evaluate(async () => {
      window.sttTest.stt.cancelSegment();
      await window.sttTest.hub.stopMicrophone();
      await window.sttTest.stt.connect();
    });
    const resumed = await transcribe(page, "harbor");
    results.push(resumed);
    expect(normalize(resumed.text)).toBe(normalize(fixtures[1].text));
    expect(resumed.firstPartialMs).toBeLessThan(10_000);
    expect(resumed.finalAfterCommitMs).toBeLessThan(10_000);
    expect(mints).toBe(2);
    expect(
      await page.evaluate(
        (id) =>
          window.sttTest.events.some(({ event }) => event.type === "final" && event.segment === id),
        cancelled,
      ),
    ).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    const report = JSON.stringify({ results, mints }, null, 2);
    const path = info.outputPath("transcripts-and-latency.json");
    await writeFile(path, report);
    await info.attach("transcripts-and-latency", {
      path,
      contentType: "application/json",
    });
    console.log(JSON.stringify({ results, mints }));
    await page.evaluate(() => window.sttTest?.dispose());
  }
});
