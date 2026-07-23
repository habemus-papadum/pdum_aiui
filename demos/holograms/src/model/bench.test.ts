/**
 * bench.test.ts — layer-1 checks for the holograms bench: the record→develop→
 * playback pipeline produces a film whose playback carries the image, the
 * ghosts land where the wave engine puts the light, and the design readouts
 * (path matching, finest fringe, beam split) behave as the page claims.
 */
import { retinaImage } from "@habemus-papadum/aiui-optics";
import { describe, expect, it } from "vitest";
import {
  beamSplit,
  cutFilm,
  developBench,
  EYE_APERTURE,
  EYE_STANDOFF,
  exposeBench,
  finestFringe,
  ghostPredictions,
  meanObjectPath,
  playbackExitField,
  playbackMapRequest,
  recordMapRequest,
  referenceArm,
} from "./bench";
import type { ScenePoint } from "./store";

const REF = { lambda: 8, angleDeg: 22, curved: false, dist: 900, pathTrim: 0 };
const POINTS: ScenePoint[] = [
  { x: -70, z: -560 },
  { x: 15, z: -760 },
  { x: 80, z: -1000 },
];
const EXP = {
  lambda: 8,
  ref: REF,
  points: POINTS,
  objGain: 4,
  coherenceLen: 3000,
  vibration: 0,
};

describe("the darkroom pipeline", () => {
  it("matched arms record fringes; a trim beyond the coherence length erases them", () => {
    const good = exposeBench(EXP);
    expect(good.worstContrast).toBeGreaterThan(0.8);
    const bad = exposeBench({ ...EXP, ref: { ...REF, pathTrim: -6000 }, coherenceLen: 800 });
    expect(bad.worstContrast).toBeLessThan(0.05);
  });

  it("referenceArm's default path offset IS the mean object path (trim 0 = matched)", () => {
    const arm = referenceArm(REF, POINTS);
    expect(arm.pathOffset).toBeCloseTo(meanObjectPath(POINTS), 6);
  });

  it("the played-back film sends light into image, zero order, and twin — more image when bleached", () => {
    const e = exposeBench(EXP);
    const amp = developBench(e.exposure, e.mean, { gamma: 1, bleach: false, filmRes: 4 });
    const phs = developBench(e.exposure, e.mean, { gamma: 1, bleach: true, filmRes: 4 });
    const sAmp = beamSplit(amp, 8, 22, POINTS);
    const sPhs = beamSplit(phs, 8, 22, POINTS);
    expect(sAmp.image).toBeGreaterThan(0.005);
    expect(sAmp.zero).toBeGreaterThan(0.2);
    // shares are of INCIDENT power, so the bleach's advantage shows honestly
    expect(sPhs.image).toBeGreaterThan(sAmp.image * 2.5);
  });

  it("coarse emulsion strips the image", () => {
    const e = exposeBench(EXP);
    const fine = developBench(e.exposure, e.mean, { gamma: 1, bleach: true, filmRes: 4 });
    const coarse = developBench(e.exposure, e.mean, { gamma: 1, bleach: true, filmRes: 100 });
    expect(beamSplit(coarse, 8, 22, POINTS).image).toBeLessThan(
      beamSplit(fine, 8, 22, POINTS).image * 0.15,
    );
  });

  it("finestFringe: steeper reference → finer fringes (the object's own edge angles set the floor)", () => {
    const f22 = finestFringe(POINTS, 22, 8);
    const f10 = finestFringe(POINTS, 10, 8);
    expect(f22).toBeLessThan(f10);
    expect(f22).toBeGreaterThan(4); // the default emulsion (4 µm) still holds it
    expect(f22).toBeLessThan(30);
  });
});

describe("the eye sees the scene through the developed film", () => {
  function look(cutTo?: { center: number; width: number }, eyeXPos = 0) {
    const e = exposeBench(EXP);
    let t = developBench(e.exposure, e.mean, { gamma: 1, bleach: true, filmRes: 4 });
    if (cutTo) t = cutFilm(t, cutTo.center, cutTo.width);
    const exit = playbackExitField(t, 8, 22);
    return retinaImage(exit, 8, {
      x: eyeXPos,
      standoff: EYE_STANDOFF,
      aperture: EYE_APERTURE,
      focusDepth: EYE_STANDOFF + 760, // focus on the middle point
      viewHalfWidth: 300,
      nPupil: 192,
      nRetina: 200,
    });
  }

  /** Local peak: the brightest sample within ±half of `center`. */
  function localPeak(
    img: ReturnType<typeof retinaImage>,
    center: number,
    half: number,
  ): { x: number; v: number } {
    let v = 0;
    let x = center;
    for (let i = 0; i < img.intensity.length; i++) {
      if (Math.abs(img.xApparent[i] - center) <= half && img.intensity[i] > v) {
        v = img.intensity[i];
        x = img.xApparent[i];
      }
    }
    return { x, v };
  }

  it("the full film shows the in-focus point at its position (within speckle)", () => {
    const img = look();
    const p2 = localPeak(img, 15, 60);
    let globalMax = 0;
    for (const v of img.intensity) globalMax = Math.max(globalMax, v);
    // a real, prominent peak lands on the in-focus point (coherent crosstalk
    // between the three points' PSFs — speckle — allows tens of µm of wander)
    expect(p2.v).toBeGreaterThan(globalMax * 0.25);
    expect(Math.abs(p2.x - 15)).toBeLessThan(60);
  });

  it("cut the film: a fifth of the film still shows the in-focus point in place — image dimmer", () => {
    const full = look();
    const cut = look({ center: 150, width: 300 });
    const pf = localPeak(full, 15, 50);
    const pc = localPeak(cut, 15, 50);
    // same place…
    expect(Math.abs(pf.x - pc.x)).toBeLessThan(50);
    // …but dimmer through the small window. (The GLOBAL view can even get
    // brighter: a small aperture diffracts zero-order glare across the view —
    // true of real hologram shards too.)
    expect(pc.v).toBeLessThan(pf.v * 0.8);
    expect(pc.v).toBeGreaterThan(pf.v * 0.02); // …and emphatically not gone
  });

  it("parallax: the in-focus point holds still; the near point slides against the eye", () => {
    const a = look(undefined, -120);
    const b = look(undefined, 120);
    // P2 sits AT the focus depth: its apparent position is eye-invariant
    expect(Math.abs(localPeak(a, 15, 50).x - localPeak(b, 15, 50).x)).toBeLessThan(40);
    // P1 is nearer than the focus plane: as the eye moves right, its apparent
    // position (projected on the focus plane) moves left — motion parallax
    const p1a = localPeak(a, -60, 70).x;
    const p1b = localPeak(b, -95, 70).x;
    expect(p1a - p1b).toBeGreaterThan(20);
  });
});

describe("ghosts (the designer's equations on this bench)", () => {
  it("matched playback puts every virtual image exactly on its point", () => {
    const ghosts = ghostPredictions(POINTS, REF, 22, 1);
    for (let i = 0; i < POINTS.length; i++) {
      expect(ghosts[i].image.kind).toBe("virtual");
      expect(ghosts[i].image.x).toBeCloseTo(POINTS[i].x, 4);
      expect(ghosts[i].image.z).toBeCloseTo(POINTS[i].z, 4);
    }
  });

  it("µ > 1 pulls the virtual images toward the film (depth ∝ 1/µ)", () => {
    const ghosts = ghostPredictions(POINTS, REF, 22, 1.5);
    for (let i = 0; i < POINTS.length; i++) {
      expect(-(ghosts[i].image.z ?? 0)).toBeCloseTo(-POINTS[i].z / 1.5, 3);
    }
  });

  it("map requests cover their phases", () => {
    const rec = recordMapRequest(EXP);
    if (rec.kind !== "coherent") throw new Error("coherent expected");
    expect(rec.job.sources.length).toBe(1 + POINTS.length);
    expect(rec.job.z0).toBeLessThan(-1000);

    const e = exposeBench(EXP);
    const t = developBench(e.exposure, e.mean, { gamma: 1, bleach: true, filmRes: 4 });
    const pb = playbackMapRequest(t, 8, 22);
    if (pb.kind !== "coherent") throw new Error("coherent expected");
    expect(pb.job.element?.z).toBe(0);
    expect(pb.job.sources.length).toBe(1);
    expect(pb.job.z0).toBeLessThan(-1000); // the virtual-image region shows
  });
});
