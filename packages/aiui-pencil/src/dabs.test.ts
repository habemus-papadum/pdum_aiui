import { describe, expect, it } from "vitest";
import { dabAt, effectivePressure, planStroke, ramp, speedsOf } from "./dabs";
import { type PencilParams, SKETCH, WRITE } from "./pencil";
import type { PenSample } from "./telemetry";

const HALF_PI = Math.PI / 2;

function sample(x: number, y: number, extra: Partial<PenSample> = {}): PenSample {
  return {
    x,
    y,
    t: 0,
    pressure: 0.5,
    altitude: HALF_PI, // upright
    azimuth: 0,
    twist: 0,
    kind: "pen",
    width: 1,
    height: 1,
    ...extra,
  };
}

/** A straight pen stroke, sampled at 120Hz, moving `speed` px/ms. */
function stroke(n: number, speed = 0.5, extra: Partial<PenSample> = {}): PenSample[] {
  return Array.from({ length: n }, (_, i) => sample(i * speed * 8, 0, { t: i * 8, ...extra }));
}

describe("ramp", () => {
  it("maps 0..1 across the pair and clamps outside it", () => {
    expect(ramp([2, 6], 0)).toBe(2);
    expect(ramp([2, 6], 0.5)).toBe(4);
    expect(ramp([2, 6], 1)).toBe(6);
    expect(ramp([2, 6], -3)).toBe(2);
    expect(ramp([2, 6], 9)).toBe(6);
  });
});

describe("speedsOf", () => {
  it("is distance over time", () => {
    const speeds = speedsOf([sample(0, 0, { t: 0 }), sample(10, 0, { t: 10 })]);
    expect(speeds[1]).toBeCloseTo(1, 8);
  });

  it("borrows the second point's speed for the first", () => {
    // Otherwise a stroke opens with a spurious 'stationary' — and therefore
    // heavy — dab, which reads as a blob at the start of every mark.
    const speeds = speedsOf([sample(0, 0, { t: 0 }), sample(10, 0, { t: 10 })]);
    expect(speeds[0]).toBe(speeds[1]);
  });

  it("does not divide by a zero timestep", () => {
    const speeds = speedsOf([sample(0, 0, { t: 5 }), sample(10, 0, { t: 5 })]);
    expect(speeds.every(Number.isFinite)).toBe(true);
  });
});

describe("effectivePressure", () => {
  it("believes a pen that reports pressure", () => {
    expect(effectivePressure(sample(0, 0, { pressure: 0.7 }), 1, WRITE)).toBeCloseTo(0.7, 8);
  });

  it("simulates pressure from speed for a mouse — slow means heavy", () => {
    // Without this a mouse draws a dead constant-width line, which is exactly the
    // failure the old ink surface has.
    const mouse = sample(0, 0, { kind: "mouse", pressure: 0.5 });
    const slow = effectivePressure(mouse, 0, WRITE);
    const fast = effectivePressure(mouse, WRITE.velocityRef, WRITE);
    expect(slow).toBeGreaterThan(fast);
    expect(slow).toBeCloseTo(1, 8);
    expect(fast).toBeCloseTo(0, 8);
  });

  it("simulates for a pen whose browser reports no pressure at all", () => {
    const dead = sample(0, 0, { kind: "pen", pressure: 0 });
    expect(effectivePressure(dead, 0, WRITE)).toBeCloseTo(1, 8);
  });
});

describe("dabAt — the instrument's physics", () => {
  it("an upright pen makes a ROUND dab", () => {
    const dab = dabAt(sample(0, 0, { altitude: HALF_PI }), 0, SKETCH);
    expect(dab.rx).toBeCloseTo(dab.ry, 8);
  });

  it("a laid-over pen makes an ELLIPSE, angled along the lean", () => {
    // The charcoal effect, falling out of the geometry rather than being a mode.
    const flat = dabAt(sample(0, 0, { altitude: 0.15, azimuth: 1.3 }), 0, SKETCH);
    expect(flat.rx).toBeGreaterThan(flat.ry * 2);
    expect(flat.angle).toBeCloseTo(1.3, 8);
  });

  it("a laid-over pen covers MORE paper, more THINLY", () => {
    const upright = dabAt(sample(0, 0, { altitude: HALF_PI }), 0, SKETCH);
    const flat = dabAt(sample(0, 0, { altitude: 0.1 }), 0, SKETCH);
    expect(flat.ry).toBeGreaterThan(upright.ry); // broader
    expect(flat.alpha).toBeLessThan(upright.alpha); // lighter
  });

  it("pressing harder broadens and darkens", () => {
    const light = dabAt(sample(0, 0, { pressure: 0.1 }), 0, WRITE);
    const heavy = dabAt(sample(0, 0, { pressure: 1.0 }), 0, WRITE);
    expect(heavy.ry).toBeGreaterThan(light.ry);
    expect(heavy.alpha).toBeGreaterThan(light.alpha);
  });

  it("moving faster lays down less graphite", () => {
    const slow = dabAt(sample(0, 0, { pressure: 0.6 }), 0, WRITE);
    const fast = dabAt(sample(0, 0, { pressure: 0.6 }), WRITE.velocityRef * 2, WRITE);
    expect(fast.alpha).toBeLessThan(slow.alpha);
  });

  it("degrades to pressure-and-velocity when the browser reports no tilt — no branch", () => {
    // telemetry.ts hands us an upright pen when orientation is absent, so every
    // tilt term multiplies by its identity and quietly vanishes. This test pins
    // that: a tilt-less pen must draw exactly as an upright one does.
    const noTilt = dabAt(sample(0, 0, { altitude: HALF_PI, azimuth: 0 }), 1, SKETCH);
    const upright = dabAt(sample(0, 0, { altitude: HALF_PI, azimuth: 0 }), 1, SKETCH);
    expect(noTilt).toEqual(upright);
    expect(noTilt.rx).toBeCloseTo(noTilt.ry, 8);
  });

  it("keeps alpha inside 0..1 no matter how the knobs are set", () => {
    const absurd: PencilParams = {
      ...WRITE,
      flow: 5,
      pressureToAlpha: [10, 20],
      tiltToAlpha: [8, 8],
    };
    expect(dabAt(sample(0, 0, { pressure: 1 }), 0, absurd).alpha).toBe(1);
  });
});

describe("planStroke — the whole pipeline, every stage kept", () => {
  it("spaces dabs by ARC LENGTH, so a fast stroke is not dotted", () => {
    // The single most important property of the dab engine: a pencil lays
    // graphite at a constant rate along the PAPER, not along the CLOCK.
    const slow = planStroke(stroke(40, 0.2), WRITE);
    const fast = planStroke(stroke(40, 2.0), WRITE);
    const gaps = (plan: typeof slow): number[] =>
      plan.dabs.slice(1).map((d, i) => Math.hypot(d.x - plan.dabs[i].x, d.y - plan.dabs[i].y));

    const target = WRITE.size * WRITE.spacing;
    for (const gap of [...gaps(slow), ...gaps(fast)]) {
      expect(gap).toBeCloseTo(target, 4);
    }
  });

  it("produces more dabs for a longer stroke", () => {
    const short = planStroke(stroke(10), WRITE);
    const long = planStroke(stroke(40), WRITE);
    expect(long.dabs.length).toBeGreaterThan(short.dabs.length);
  });

  it("keeps every intermediate stage — the lab draws these", () => {
    const plan = planStroke(stroke(20), WRITE);
    expect(plan.raw.length).toBe(20);
    expect(plan.filtered.length).toBe(20);
    expect(plan.cusps.length).toBe(20);
    expect(plan.densified.length).toBeGreaterThanOrEqual(20);
    expect(plan.spaced.length).toBe(plan.dabs.length);
    expect(plan.speeds.length).toBe(plan.dabs.length);
  });

  it("finds the corner in a hand-drawn L and keeps it", () => {
    const across: PenSample[] = Array.from({ length: 20 }, (_, i) =>
      sample(i * 2, 0, { t: i * 8 }),
    );
    const down: PenSample[] = Array.from({ length: 20 }, (_, i) =>
      sample(38, i * 2 + 2, { t: (20 + i) * 8 }),
    );
    const plan = planStroke([...across, ...down], WRITE);
    expect(plan.cusps.filter(Boolean).length).toBe(1);
    // And nothing bulges past the elbow.
    for (const dab of plan.dabs) {
      expect(dab.x).toBeLessThan(40);
    }
  });

  it("handles a single tap — a dot is a legitimate stroke", () => {
    const plan = planStroke([sample(5, 5)], WRITE);
    expect(plan.dabs.length).toBe(1);
    expect(plan.dabs[0].x).toBe(5);
  });

  it("handles an empty stroke", () => {
    const plan = planStroke([], WRITE);
    expect(plan.dabs).toEqual([]);
  });

  it("sketch mode lays coarser, broader dabs than write mode", () => {
    const written = planStroke(stroke(40), WRITE);
    const sketched = planStroke(stroke(40), SKETCH);
    expect(sketched.dabs.length).toBeLessThan(written.dabs.length);
    expect(sketched.dabs[5].ry).toBeGreaterThan(written.dabs[5].ry);
  });
});
