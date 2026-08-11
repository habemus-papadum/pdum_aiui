/**
 * mic.test.ts — the capture path's PURE math (the WebAudio graph itself
 * needs a real browser): Float32 → PCM16 conversion with clamping and
 * little-endian bytes, and the linear resampler's identity + ratio.
 */
import { describe, expect, it } from "vitest";
import { floatToPcm16, resampleLinear } from "./mic/index";

describe("floatToPcm16", () => {
  it("converts, clamps, and emits little-endian bytes", () => {
    const bytes = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
    expect(view.getInt16(6, true)).toBe(Math.floor(0.5 * 0x7fff));
    expect(view.getInt16(8, true)).toBe(0x7fff); // clamped
    expect(view.getInt16(10, true)).toBe(-0x8000); // clamped
  });
});

describe("resampleLinear", () => {
  it("is identity at equal rates", () => {
    const block = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(block, 24000, 24000)).toBe(block);
  });

  it("halves the sample count from 48k to 24k", () => {
    const block = new Float32Array(480).fill(0.25);
    const out = resampleLinear(block, 48000, 24000);
    expect(out.length).toBe(240);
    expect(out[100]).toBeCloseTo(0.25);
  });

  it("interpolates between neighbours when upsampling", () => {
    const out = resampleLinear(new Float32Array([0, 1]), 12000, 24000);
    expect(out.length).toBe(4);
    expect(out[1]).toBeCloseTo(0.5);
  });
});
