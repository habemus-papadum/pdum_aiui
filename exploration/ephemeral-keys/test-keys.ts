/**
 * Standalone command B — test the cached ephemeral keys, and prove expiry.
 *
 *   npm run test-keys       (from exploration/ephemeral-keys/)
 *   npx tsx test-keys.ts
 *
 * Two parts:
 *   1. SMOKE  — connect each cached key (from `mint.ts`) to its REAL vendor
 *               endpoint and confirm a live session (no audio sent → no spend).
 *   2. EXPIRY — mint deliberately short-lived / invalid credentials and confirm
 *               they are REJECTED, capturing exactly how each vendor signals it.
 *
 * Not integrated into anything. The expiry part re-mints its own short-TTL keys,
 * so it does not depend on (or disturb) the 20-minute cached ones — except that
 * ElevenLabs tokens are single-use, so the SMOKE connect consumes the cached one.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  ELEVENLABS_TTL_SECONDS,
  mintElevenLabsScribe,
  mintGeminiLive,
  mintOpenAiRealtime,
} from "./mint-core.ts";
import type { MintedKey } from "./spec.ts";
import { buildConnection, classifySuccess, describeFailure, smokeTest } from "./test-core.ts";
import { color, fail, heading, info, loadKeysFile, ok, probeWs, warn } from "./util.ts";

let passed = 0;
let failedCount = 0;
function record(good: boolean): void {
  if (good) passed++;
  else failedCount++;
}

// ── Part 1: smoke test the cached keys ───────────────────────────────────────

async function smokeCached(): Promise<void> {
  heading("1 · SMOKE — do the cached 20-minute keys work?");
  const file = loadKeysFile();
  info(`loaded ${file.keys.length} cached keys (minted ${file.createdAt})`);

  for (const key of file.keys) {
    const label = `${key.vendor} · ${key.surface}`;
    const { verdict } = await smokeTest(key);
    if (verdict.ok) {
      ok(
        `${label} — ${verdict.reason}` +
          (key.singleUse ? color.dim("  (single-use: now consumed)") : ""),
      );
    } else {
      const consumed = key.singleUse ? "  (single-use — already consumed? re-run mint.ts)" : "";
      fail(`${label} — ${verdict.reason}${color.dim(consumed)}`);
    }
    record(verdict.ok);
  }

  if (file.unavailable.length) {
    for (const u of file.unavailable)
      info(`skipped (no ephemeral option): ${u.vendor} · ${u.surface}`);
  }
}

// ── Part 2: expiry / invalidation ────────────────────────────────────────────

/** Assert a connection is REJECTED; report how the vendor signalled it. */
function expectRejected(
  label: string,
  key: MintedKey,
  probe: Awaited<ReturnType<typeof probeWs>>,
): void {
  const verdict = classifySuccess(key, probe);
  if (!verdict.ok) {
    ok(`${label} — correctly rejected: ${describeFailure(probe)}`);
    record(true);
  } else {
    fail(`${label} — NOT rejected (unexpectedly live: ${verdict.reason})`);
    record(false);
  }
}

async function expiryOpenAi(): Promise<void> {
  const short = 10; // the vendor minimum
  info(`openai: minting a ${short}s ek_… then waiting for it to expire…`);
  const key = await mintOpenAiRealtime("linter", short);
  await sleep((short + 3) * 1000);
  const probe = await probeWs(buildConnection(key));
  expectRejected("openai · expired ek_", key, probe);
}

async function expiryGemini(): Promise<void> {
  const newSession = 5; // window to START a session
  info(`gemini: minting a token whose new-session window is ${newSession}s, then waiting past it…`);
  const key = await mintGeminiLive(1200, newSession);
  await sleep((newSession + 3) * 1000);
  const probe = await probeWs(buildConnection(key));
  expectRejected("gemini · past newSessionExpireTime", key, probe);
}

async function expiryElevenLabs(): Promise<void> {
  // The 15-min TTL is not shortenable, so we prove the two OTHER invalidation
  // paths (single-use consumption, malformed token) instead — same "credential
  // no longer accepted" property, no 15-minute wait.
  info(
    `elevenlabs: TTL is fixed at ${ELEVENLABS_TTL_SECONDS / 60}m (unshortenable); testing single-use + malformed instead`,
  );

  const key = await mintElevenLabsScribe();
  const first = await smokeTest(key);
  if (first.verdict.ok) ok(`elevenlabs · single-use first connect — ${first.verdict.reason}`);
  else warn(`elevenlabs · single-use first connect did not open cleanly: ${first.verdict.reason}`);
  record(first.verdict.ok);

  // Reuse the now-consumed token → must be rejected.
  const reuse = await probeWs(buildConnection(key));
  expectRejected("elevenlabs · reused single-use token", key, reuse);

  // A syntactically-plausible but bogus token → must be rejected.
  const bogus: MintedKey = { ...key, token: "sutkn_deadbeefdeadbeefdeadbeefdeadbeef" };
  const bad = await probeWs(buildConnection(bogus));
  expectRejected("elevenlabs · malformed token", bogus, bad);
}

async function expiryTests(): Promise<void> {
  heading("2 · EXPIRY — what happens when a key expires / is invalid?");
  for (const [label, fn] of [
    ["openai", expiryOpenAi],
    ["gemini", expiryGemini],
    ["elevenlabs", expiryElevenLabs],
  ] as const) {
    try {
      await fn();
    } catch (e) {
      fail(`${label} · expiry test threw — ${(e as Error).message}`);
      record(false);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await smokeCached();
  await expiryTests();

  heading("Summary");
  const total = passed + failedCount;
  if (failedCount === 0) ok(`all ${total} checks passed`);
  else fail(`${failedCount}/${total} checks failed`);
  console.log("");
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
