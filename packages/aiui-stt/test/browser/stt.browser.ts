import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { fixtures, openHarness, transcribe } from "./helpers";

// Only the vendor is scripted: capture, worklet, resampling, browser WebSocket,
// Scribe framing and STT segment handling all run their production code.
async function fakeScribe(page: Page) {
  const sockets: Array<{
    ws: WebSocketRoute;
    token: string | null;
    bytes: number;
    nonzero: number;
    keepalives: number;
    commits: number;
    closed: boolean;
    reply: boolean;
  }> = [];
  let mints = 0;
  let final = 0;
  await page.exposeFunction(
    "mintScribeUrl",
    () => `wss://scribe.test/realtime?model_id=scribe_v2_realtime&token=fixture-${++mints}`,
  );
  // Offline tests may reach only the local harness; vendor requests cannot escape.
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
  );
  await page.routeWebSocket(/.*/, (ws) => {
    const url = new URL(ws.url());
    if (url.hostname === "127.0.0.1") {
      ws.connectToServer(); // Vite's local HMR connection.
      return;
    }
    if (url.hostname !== "scribe.test") {
      ws.close();
      throw new Error("Unexpected WebSocket in offline test");
    }
    const socket = {
      ws,
      token: url.searchParams.get("token"),
      bytes: 0,
      nonzero: 0,
      keepalives: 0,
      commits: 0,
      closed: false,
      reply: true,
    };
    sockets.push(socket);
    ws.onClose(() => {
      socket.closed = true;
    });
    let partial = false;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      expect(message.message_type).toBe("input_audio_chunk");
      expect(message.sample_rate).toBe(24000);
      const bytes = Buffer.from(message.audio_base_64, "base64");
      socket.bytes += bytes.length;
      socket.nonzero += bytes.filter((x) => x !== 0).length;
      if (!bytes.length && !message.commit) socket.keepalives++;
      if (!partial && socket.bytes >= 48_000) {
        partial = true;
        ws.send(JSON.stringify({ message_type: "partial_transcript", text: "streaming words" }));
      }
      if (message.commit) {
        socket.commits++;
        partial = false;
        if (socket.reply) {
          ws.send(
            JSON.stringify({
              message_type: "committed_transcript_with_timestamps",
              text: fixtures[final++ % fixtures.length].text,
              words: [],
            }),
          );
        }
      }
    });
    ws.send(
      JSON.stringify({
        message_type: "session_started",
        config: { model_id: "scribe_v2_realtime", include_timestamps: true, no_verbatim: true },
      }),
    );
  });
  await openHarness(page);
  return sockets;
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.sttTest?.dispose());
});

test("recorded speech crosses the worklet and commits exactly once per segment", async ({
  page,
}) => {
  const sockets = await fakeScribe(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let durationMs = 0;
  for (const fixture of fixtures) {
    const result = await transcribe(page, fixture.name);
    expect(result.text).toBe(fixture.text); // Scripted protocol result, not an accuracy test.
    durationMs += result.durationMs;
  }
  expect(sockets).toHaveLength(1);
  expect(sockets[0].commits).toBe(2);
  // 24kHz PCM16: account for every recording, including each final short worklet block.
  expect(sockets[0].bytes).toBeGreaterThan((durationMs - 100) * 48);
  expect(sockets[0].bytes).toBeLessThan((durationMs + 500) * 48);
  expect(sockets[0].nonzero).toBeGreaterThan(10_000);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => window.sttTest.events.filter((e) => e.event.type === "error")),
  ).toEqual([]);
});

test("parking stops speech frames and keeps the same Scribe connection alive", async ({ page }) => {
  await page.clock.install();
  const sockets = await fakeScribe(page);
  await page.evaluate(async () => {
    window.sttTest.stt.beginSegment();
    await window.sttTest.play("harbor", true);
  });
  await expect.poll(() => sockets[0]?.bytes ?? 0).toBeGreaterThan(5000);
  await page.evaluate(() => window.sttTest.hub.parkInput());
  // A WebSocket round trip fences any final pre-park frame already in flight.
  sockets[0].ws.send(JSON.stringify({ message_type: "partial_transcript", text: "park fence" }));
  await expect
    .poll(() => page.evaluate(() => window.sttTest.events.at(-1)?.event))
    .toMatchObject({ type: "delta", text: "park fence" });
  const bytes = sockets[0].bytes;
  await page.clock.fastForward(11_000);
  await expect.poll(() => sockets[0].keepalives).toBeGreaterThan(0);
  expect(sockets[0].bytes).toBe(bytes);
  expect(sockets[0].closed).toBe(false);
  expect(await page.evaluate(() => window.sttTest.hub.snapshot().capture)).toBe("active");
  await page.evaluate(() => window.sttTest.hub.resumeInput());
  await expect.poll(() => sockets[0].bytes).toBeGreaterThan(bytes);
  expect(sockets).toHaveLength(1);
  expect(await page.evaluate(() => window.sttTest.finish())).toEqual([]);
});

test("cancel discards speech, closes its socket, and mints again for the next segment", async ({
  page,
}) => {
  const sockets = await fakeScribe(page);
  await page.evaluate(async () => {
    window.sttTest.stt.beginSegment();
    await window.sttTest.play("garden", true);
  });
  await expect.poll(() => sockets[0]?.bytes ?? 0).toBeGreaterThan(48_000);
  await page.evaluate(async () => {
    window.sttTest.stt.cancelSegment();
    await window.sttTest.hub.stopMicrophone();
  });
  await expect.poll(() => sockets[0].closed).toBe(true);
  expect(sockets[0].commits).toBe(0);
  const result = await transcribe(page, "harbor");
  expect(result.segment).toBe(1);
  expect(sockets.map((socket) => socket.token)).toEqual(["fixture-1", "fixture-2"]);
  const finals = await page.evaluate(() =>
    window.sttTest.events.filter((e) => e.event.type === "final"),
  );
  expect(finals).toHaveLength(1);
  expect(finals[0].event).toMatchObject({ segment: 1 });
});

test("remote close settles a pending commit and permits a fresh connection", async ({ page }) => {
  const sockets = await fakeScribe(page);
  await page.evaluate(async () => {
    await window.sttTest.stt.connect();
    window.sttTest.stt.beginSegment();
    await window.sttTest.play("harbor", true);
  });
  sockets[0].reply = false;
  await expect.poll(() => sockets[0].bytes).toBeGreaterThan(30_000);
  await page.evaluate(() => window.sttTest.stt.endSegment());
  await expect.poll(() => sockets[0].commits).toBe(1);
  sockets[0].ws.close({ code: 1011, reason: "fixture connection lost" });
  await expect.poll(() => page.evaluate(() => window.sttTest.stt.status())).toBe("error");
  expect(await page.evaluate(() => window.sttTest.stt.drain(100))).toEqual([]);
  expect(
    await page.evaluate(() =>
      window.sttTest.events.some(
        ({ event }) =>
          event.type === "error" &&
          event.segment === 0 &&
          event.message.includes("fixture connection lost"),
      ),
    ),
  ).toBe(true);
  await page.evaluate(async () => {
    await window.sttTest.hub.stopMicrophone();
    await window.sttTest.stt.connect();
  });
  expect((await transcribe(page, "harbor")).segment).toBe(1);
  expect(sockets.map((socket) => socket.token)).toEqual(["fixture-1", "fixture-2"]);
});
