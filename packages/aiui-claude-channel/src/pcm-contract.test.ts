/**
 * The 24 kHz PCM contract, channel side: the several independently hard-coded
 * 24 kHz constants scattered across the realtime engines all derive from the
 * same rate. The client's half of this contract (its capture rate and the
 * `audio/pcm;rate=24000` mime it stamps) is cross-checked against
 * `REALTIME_VOICE_RATE` in aiui-intent-runtime's protocol.test.ts; here we tie
 * the channel's own copies together so retuning the rate can't leave one behind.
 */
import { describe, expect, it } from "vitest";
import { ELEVENLABS_SAMPLE_RATE } from "./elevenlabs-realtime";
import { REALTIME_PCM_BYTES_PER_MS } from "./intent-stream-util";
import { REALTIME_VOICE_RATE } from "./pcm";

describe("the 24 kHz PCM contract (channel-side copies)", () => {
  it("derives the commit-floor bytes/ms from the realtime voice rate", () => {
    expect(REALTIME_PCM_BYTES_PER_MS).toBe((REALTIME_VOICE_RATE * 2) / 1000);
  });

  it("ties the ElevenLabs sample rate to the realtime voice rate", () => {
    expect(ELEVENLABS_SAMPLE_RATE).toBe(REALTIME_VOICE_RATE);
  });
});
