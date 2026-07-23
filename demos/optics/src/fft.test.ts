import { describe, expect, it } from "vitest";
import { fft, fft2d, fftfreq, ifft, isPow2, nextPow2 } from "./fft";

/** Naive O(N²) DFT for cross-checking. */
function dft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      outRe[k] += re[t] * c - im[t] * s;
      outIm[k] += re[t] * s + im[t] * c;
    }
  }
  return { re: outRe, im: outIm };
}

function randomSignal(n: number, seed = 1234): { re: Float64Array; im: Float64Array } {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296 - 0.5;
  };
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = rand();
    im[i] = rand();
  }
  return { re, im };
}

describe("fft", () => {
  it("pow2 helpers", () => {
    expect(isPow2(1)).toBe(true);
    expect(isPow2(256)).toBe(true);
    expect(isPow2(255)).toBe(false);
    expect(nextPow2(300)).toBe(512);
    expect(nextPow2(512)).toBe(512);
  });

  it("matches the naive DFT", () => {
    const { re, im } = randomSignal(64);
    const want = dft(re, im);
    fft(re, im);
    for (let i = 0; i < 64; i++) {
      expect(re[i]).toBeCloseTo(want.re[i], 8);
      expect(im[i]).toBeCloseTo(want.im[i], 8);
    }
  });

  it("ifft inverts fft", () => {
    const { re, im } = randomSignal(512, 77);
    const origRe = re.slice();
    const origIm = im.slice();
    fft(re, im);
    ifft(re, im);
    for (let i = 0; i < 512; i++) {
      expect(re[i]).toBeCloseTo(origRe[i], 10);
      expect(im[i]).toBeCloseTo(origIm[i], 10);
    }
  });

  it("satisfies Parseval", () => {
    const { re, im } = randomSignal(256, 9);
    let time = 0;
    for (let i = 0; i < 256; i++) time += re[i] * re[i] + im[i] * im[i];
    fft(re, im);
    let freq = 0;
    for (let i = 0; i < 256; i++) freq += re[i] * re[i] + im[i] * im[i];
    expect(freq / 256).toBeCloseTo(time, 8);
  });

  it("fftfreq matches numpy layout", () => {
    const f = fftfreq(8, 0.5);
    expect(Array.from(f)).toEqual([0, 0.25, 0.5, 0.75, -1, -0.75, -0.5, -0.25]);
  });

  it("rejects non-pow2 lengths", () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });
});

describe("fft2d", () => {
  it("a tilted plane wave concentrates into a single bin", () => {
    const w = 16;
    const h = 16;
    const re = new Float64Array(w * h);
    const im = new Float64Array(w * h);
    // e^{2πi(3x/w + 5y/h)} → bin (3, 5)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ph = 2 * Math.PI * ((3 * x) / w + (5 * y) / h);
        re[y * w + x] = Math.cos(ph);
        im[y * w + x] = Math.sin(ph);
      }
    }
    fft2d(re, im, w, h);
    let best = 0;
    let bx = -1;
    let by = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = re[y * w + x] ** 2 + im[y * w + x] ** 2;
        if (p > best) {
          best = p;
          bx = x;
          by = y;
        }
      }
    }
    expect(bx).toBe(3);
    expect(by).toBe(5);
    expect(best).toBeCloseTo((w * h) ** 2, 4);
  });

  it("satisfies Parseval in 2-D", () => {
    const w = 8;
    const h = 8;
    const { re, im } = randomSignal(w * h, 3);
    let time = 0;
    for (let i = 0; i < re.length; i++) time += re[i] * re[i] + im[i] * im[i];
    fft2d(re, im, w, h);
    let freq = 0;
    for (let i = 0; i < re.length; i++) freq += re[i] * re[i] + im[i] * im[i];
    expect(freq / (w * h)).toBeCloseTo(time, 8);
  });
});
