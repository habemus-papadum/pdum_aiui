/**
 * bench.test.ts — layer-1 checks for the design formulas the page quotes and
 * the map-request builders the worker consumes.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveSlits,
  gratingOrders,
  lensImage,
  resolvingPower,
  slitBenchRequest,
  spectrometerRequest,
  twoSourceRequest,
  zoneFocalAt,
  zoneLocalPitch,
  zoneMask,
} from "./bench";

describe("design formulas", () => {
  it("gratingOrders follows sinθ = sinθin + mλ/Λ, sorted and clipped", () => {
    const orders = gratingOrders(8, 40, 0);
    const m1 = orders.find((o) => o.m === 1);
    expect(m1?.sin).toBeCloseTo(0.2, 6);
    expect(m1?.deg).toBeCloseTo(11.537, 2);
    // symmetric about zero at normal incidence
    expect(orders.find((o) => o.m === -1)?.sin).toBeCloseTo(-0.2, 6);
    // sorted by direction
    const sins = orders.map((o) => o.sin);
    expect([...sins].sort((a, b) => a - b)).toEqual(sins);
    // steep orders clipped
    expect(orders.every((o) => Math.abs(o.sin) <= 0.95)).toBe(true);
  });

  it("oblique incidence shifts the whole fan", () => {
    const orders = gratingOrders(8, 40, 6);
    const sIn = Math.sin((6 * Math.PI) / 180);
    expect(orders.find((o) => o.m === 0)?.sin).toBeCloseTo(sIn, 6);
    expect(orders.find((o) => o.m === 1)?.sin).toBeCloseTo(sIn + 0.2, 6);
  });

  it("effectiveSlits clips the mask at the film edge; R = m·N_eff", () => {
    expect(effectiveSlits(40, 24)).toBe(24);
    expect(effectiveSlits(110, 40)).toBe(Math.floor(1536 / 110));
    expect(resolvingPower(110, 40)).toBe(Math.floor(1536 / 110)); // m = 1
  });

  it("lensImage follows the lens law with M = −zi/zo", () => {
    const img = lensImage(600, 380);
    expect(img.kind).toBe("real");
    expect(1 / img.imageDist + 1 / 600).toBeCloseTo(1 / 380, 9);
    expect(img.magnification).toBeCloseTo(-img.imageDist / 600, 9);
    // inside f → virtual
    expect(lensImage(300, 380).kind).toBe("virtual");
  });

  it("zoneFocalAt: f ∝ 1/λ", () => {
    expect(zoneFocalAt(380, 8, 16)).toBeCloseTo(190, 9);
  });

  it("zoneLocalPitch shrinks outward (harder kicks at the edge)", () => {
    const inner = zoneLocalPitch(380, 8, 60);
    const outer = zoneLocalPitch(380, 8, 240);
    expect(outer).toBeLessThan(inner);
    // λ/Λ(x) = sinθ(x) aims at the focus
    expect(8 / outer).toBeCloseTo(240 / Math.hypot(240, 380), 6);
  });
});

describe("map requests", () => {
  it("slit bench: coherent, element at z=0, plane source at the incident angle", () => {
    const req = slitBenchRequest(8, 40, 24, 5);
    expect(req.kind).toBe("coherent");
    if (req.kind !== "coherent") return;
    expect(req.job.element?.z).toBe(0);
    expect(req.job.sources[0]).toMatchObject({ kind: "plane", angleDeg: 5 });
    expect(req.job.z0).toBeLessThan(0);
    expect(req.job.z1).toBeGreaterThan(0);
  });

  it("two-source: a symmetric pair, no element", () => {
    const req = twoSourceRequest(8, 90);
    if (req.kind !== "coherent") throw new Error("expected coherent");
    expect(req.job.element).toBeUndefined();
    expect(req.job.sources).toHaveLength(2);
    expect(req.job.sources[0]).toMatchObject({ kind: "point", x: -45 });
    expect(req.job.sources[1]).toMatchObject({ kind: "point", x: 45 });
  });

  it("spectrometer: one mask instance shared by every λ layer", () => {
    const req = spectrometerRequest(40, 24);
    if (req.kind !== "rgb") throw new Error("expected rgb");
    expect(req.layers.length).toBeGreaterThanOrEqual(5);
    const t0 = req.layers[0].job.element?.t;
    for (const layer of req.layers) expect(layer.job.element?.t).toBe(t0);
    // λ ascending, colors distinct
    const ls = req.layers.map((l) => l.job.lambda);
    expect([...ls].sort((a, b) => a - b)).toEqual(ls);
  });

  it("zoneMask is apertured to ±240 µm", () => {
    const t = zoneMask(380, 8);
    const at = (x: number): number => {
      const i = Math.round((x - -768) / 0.75);
      return Math.hypot(t.re[i], t.im[i]);
    };
    expect(at(0)).toBeGreaterThan(0.9);
    expect(at(300)).toBe(0);
    expect(at(-300)).toBe(0);
  });
});
