/**
 * gear.ts — Layer 1: pure involute-gear geometry (no framework, no time).
 *
 * Standard spur gears use an **involute** tooth flank. The one fact that makes
 * the whole app kinematic rather than dynamic:
 *
 *   Two involute gears transmit a constant velocity ratio, and their point of
 *   contact always lies on a single straight line — the **line of action**,
 *   tangent to both base circles and inclined at the pressure angle. The common
 *   normal to the two tooth surfaces at the contact point IS that line. So the
 *   "normal to the contact surface" never rotates: the contact point merely
 *   slides along the fixed line of action, like a bead on a crossed belt
 *   unwinding from one base circle onto the other.
 *
 * Everything here is deterministic and unit-tested (gear.test.ts). Cells
 * (graph.ts) wrap these with the control surface; components draw them.
 */

export interface Pt {
  x: number;
  y: number;
}

/** The independent parameters of one gear. */
export interface GearParams {
  /** Number of teeth (z). */
  teeth: number;
  /** Module m (tooth-size unit): pitch diameter = m·z. */
  module: number;
  /** Pressure angle φ in DEGREES (20° is the modern standard). */
  pressureAngle: number;
  /** Addendum height as a multiple of module (tip above pitch circle; std 1.0). */
  addendum: number;
  /** Dedendum depth as a multiple of module (root below pitch circle; std 1.25). */
  dedendum: number;
}

/** Fully resolved geometry of one gear, in its own local frame (a tooth centred on +x, angle 0). */
export interface GearGeometry {
  params: GearParams;
  /** Pitch radius r = m·z/2 — the rolling radius. */
  pitchRadius: number;
  /** Base radius r_b = r·cos φ — the circle the involute unwinds from. */
  baseRadius: number;
  /** Addendum (tip) radius. */
  addendumRadius: number;
  /** Root radius. */
  rootRadius: number;
  /** Angular pitch = 2π/z (angle from one tooth to the next). */
  angularPitch: number;
  /** True when the root circle sits below the base circle (a radial fillet joins them). */
  rootBelowBase: boolean;
  /** One repeating unit: a tooth centred at angle 0 followed by its trailing space. */
  toothProfile: Pt[];
  /** The closed outline of the whole gear (all teeth), local frame. */
  outline: Pt[];
}

const TAU = Math.PI * 2;

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** The involute function inv(α) = tan α − α. */
export const involuteFn = (a: number): number => Math.tan(a) - a;

/** Point on the involute of a circle of radius `rb` at roll angle `t` (radians). */
export function involutePoint(rb: number, t: number): Pt {
  return {
    x: rb * (Math.cos(t) + t * Math.sin(t)),
    y: rb * (Math.sin(t) - t * Math.cos(t)),
  };
}

/** Pressure angle of an involute (base radius `rb`) at radius `r ≥ rb`. */
export function pressureAngleAt(rb: number, r: number): number {
  return Math.acos(clamp(rb / r, -1, 1));
}

const polar = (r: number, ang: number): Pt => ({ x: r * Math.cos(ang), y: r * Math.sin(ang) });

export function rotatePt(p: Pt, ang: number): Pt {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export const translatePt = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy });

// --- radii ------------------------------------------------------------------

export function pitchRadius(p: GearParams): number {
  return (p.module * p.teeth) / 2;
}
export function baseRadius(p: GearParams): number {
  return pitchRadius(p) * Math.cos(deg2rad(p.pressureAngle));
}
export function addendumRadius(p: GearParams): number {
  return pitchRadius(p) + p.addendum * p.module;
}
export function rootRadius(p: GearParams): number {
  return pitchRadius(p) - p.dedendum * p.module;
}

// --- one flank / one tooth --------------------------------------------------

const FLANK_SAMPLES = 20;
const TIP_SAMPLES = 4;
const GAP_SAMPLES = 6;

/**
 * Sample the two flanks of a tooth centred at angle 0, from the usable start
 * radius up to the tip. Returns polar angle so callers can mirror/rotate.
 */
function flankPoints(g: { baseR: number; rootR: number; addR: number; halfBaseAngle: number }): {
  left: Pt[];
  right: Pt[];
  tipHalfAngle: number;
} {
  const { baseR, rootR, addR, halfBaseAngle } = g;
  // The involute only exists at r ≥ base radius; start there (or at the root if
  // the root is above the base circle, which happens for high tooth counts).
  const rStart = Math.max(baseR, rootR);
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= FLANK_SAMPLES; i++) {
    const r = rStart + (addR - rStart) * (i / FLANK_SAMPLES);
    const a = halfBaseAngle - involuteFn(pressureAngleAt(baseR, r));
    left.push(polar(r, a));
    right.push(polar(r, -a));
  }
  const tipHalfAngle = halfBaseAngle - involuteFn(pressureAngleAt(baseR, addR));
  return { left, right, tipHalfAngle };
}

/** Build the full geometry of one gear from its parameters. */
export function gearGeometry(p: GearParams): GearGeometry {
  const phi = deg2rad(p.pressureAngle);
  const pitchR = pitchRadius(p);
  const baseR = baseRadius(p);
  const addR = addendumRadius(p);
  const rootR = Math.max(rootRadius(p), 0.01);
  const angularPitch = TAU / p.teeth;

  // Half the tooth's angular width at the base circle: the pitch-circle half
  // width is π/(2z); unwinding the involute from base to pitch adds inv(φ).
  const halfBaseAngle = Math.PI / (2 * p.teeth) + involuteFn(phi);

  const { left, right, tipHalfAngle } = flankPoints({
    baseR,
    rootR,
    addR,
    halfBaseAngle,
  });
  const rStart = Math.max(baseR, rootR);
  const rootBelowBase = rootR < baseR;

  // One repeating unit (tooth centred at 0, then the gap to the next tooth).
  const unit: Pt[] = [];
  const pushUnit = (rot: number, sink: Pt[]) => {
    const add = (pt: Pt) => sink.push(rotatePt(pt, rot));
    // right root → up the right flank
    if (rootR < rStart) add(polar(rootR, -halfBaseAngle));
    for (const q of right) add(q);
    // across the tip land
    for (let i = 1; i < TIP_SAMPLES; i++) {
      const a = -tipHalfAngle + 2 * tipHalfAngle * (i / TIP_SAMPLES);
      add(polar(addR, a));
    }
    // down the left flank → left root
    for (let i = left.length - 1; i >= 0; i--) add(left[i]);
    if (rootR < rStart) add(polar(rootR, halfBaseAngle));
    // root land sweeping across the gap to the next tooth's right root
    const gapStart = halfBaseAngle;
    const gapEnd = angularPitch - halfBaseAngle;
    for (let i = 1; i <= GAP_SAMPLES; i++) {
      add(polar(rootR, gapStart + (gapEnd - gapStart) * (i / GAP_SAMPLES)));
    }
  };
  pushUnit(0, unit);

  const outline: Pt[] = [];
  for (let k = 0; k < p.teeth; k++) pushUnit(k * angularPitch, outline);

  return {
    params: p,
    pitchRadius: pitchR,
    baseRadius: baseR,
    addendumRadius: addR,
    rootRadius: rootR,
    angularPitch,
    rootBelowBase,
    toothProfile: unit,
    outline,
  };
}

// --- meshing / line of action ----------------------------------------------

export interface MeshGeometry {
  /** Standard centre distance C = r1 + r2 (gear A at origin, gear B at (C,0)). */
  center: number;
  /** Gear ratio z2/z1 = ω1/ω2 (speed multiplication of A onto B). */
  ratio: number;
  /** The pitch point on the line of centres. */
  pitchPoint: Pt;
  /** Base pitch = π·m·cos φ — equal for both gears (the meshing condition). */
  basePitch: number;
  /** Path-of-contact length ÷ base pitch (avg number of teeth in contact). */
  contactRatio: number;
  /** Unit vector along the line of action (also the contact-normal direction). */
  loaDir: Pt;
  /** Where the path of contact begins (approach: driven gear's addendum). */
  loaStart: Pt;
  /** Where the path of contact ends (recess: driver gear's addendum). */
  loaEnd: Pt;
  /** Tangent points on the two base circles (the interference limits). */
  tangentA: Pt;
  tangentB: Pt;
  /** Phase (radians) to add to gear B so a tooth space faces gear A at θ=0. */
  phaseB: number;
}

/** Foot of the perpendicular from `o` onto the line through `p` with unit dir `d`. */
function footOnLine(o: Pt, p: Pt, d: Pt): Pt {
  const wx = o.x - p.x;
  const wy = o.y - p.y;
  const proj = wx * d.x + wy * d.y;
  return { x: p.x + proj * d.x, y: p.y + proj * d.y };
}

/** Signed distance of a point along the line (positive in dir `d`) from `p`. */
export function signedAlong(pt: Pt, p: Pt, d: Pt): number {
  return (pt.x - p.x) * d.x + (pt.y - p.y) * d.y;
}

/** Intersections of a line (point `p`, unit dir `d`) with a circle (centre `c`, radius `r`). */
function lineCircle(p: Pt, d: Pt, c: Pt, r: number): number[] {
  const fx = p.x - c.x;
  const fy = p.y - c.y;
  const b = 2 * (fx * d.x + fy * d.y);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b - s) / 2, (-b + s) / 2];
}

/**
 * Geometry of two meshing gears. Gear A sits at the origin driving CCW; gear B
 * sits at (C, 0) driven CW. The line of action is tangent to both base circles
 * through the pitch point, inclined at the pressure angle.
 */
export function meshGeometry(a: GearGeometry, b: GearGeometry): MeshGeometry {
  const phi = deg2rad(a.params.pressureAngle);
  const center = a.pitchRadius + b.pitchRadius;
  const pitchPoint: Pt = { x: a.pitchRadius, y: 0 };
  const oA: Pt = { x: 0, y: 0 };
  const oB: Pt = { x: center, y: 0 };

  // Gear A drives CCW; the driving flank pushes ahead, so the line of action
  // tilts up-and-to-the-right from the pitch point: rotate the +y tangent
  // (perpendicular to the line of centres) by +φ toward +x.
  const loaDir: Pt = { x: Math.sin(phi), y: Math.cos(phi) };

  const tangentA = footOnLine(oA, pitchPoint, loaDir);
  const tangentB = footOnLine(oB, pitchPoint, loaDir);

  // Path of contact = portion of the line inside BOTH addendum circles, also
  // clipped to the tangent points (interference limits).
  const uTanA = signedAlong(tangentA, pitchPoint, loaDir); // < 0
  const uTanB = signedAlong(tangentB, pitchPoint, loaDir); // > 0
  // Approach end: line enters gear B's addendum circle (most-negative side).
  const uB = lineCircle(pitchPoint, loaDir, oB, b.addendumRadius);
  const uA = lineCircle(pitchPoint, loaDir, oA, a.addendumRadius);
  const uStart = Math.max(uTanA, uB.length ? Math.min(...uB) : uTanA);
  const uEnd = Math.min(uTanB, uA.length ? Math.max(...uA) : uTanB);

  const along = (u: number): Pt => ({
    x: pitchPoint.x + u * loaDir.x,
    y: pitchPoint.y + u * loaDir.y,
  });
  const loaStart = along(uStart);
  const loaEnd = along(uEnd);

  const basePitch = Math.PI * a.params.module * Math.cos(phi);
  const contactRatio = Math.max(0, uEnd - uStart) / basePitch;

  // Phase gear B so a tooth SPACE points back at gear A (angle π) when θ = 0,
  // meshing gear A's tooth (centred on +x) into it.
  const phaseB = (Math.PI * (b.params.teeth - 1)) / b.params.teeth;

  return {
    center,
    ratio: b.params.teeth / a.params.teeth,
    pitchPoint,
    basePitch,
    contactRatio,
    loaDir,
    loaStart,
    loaEnd,
    tangentA,
    tangentB,
    phaseB,
  };
}

/**
 * The contact point(s) at gear-A rotation `thetaA` (radians, CCW). Contact
 * slides along the line of action at the base-circle "belt" speed r_bA·θ; a
 * fresh tooth pair enters every base pitch, so several may be engaged at once
 * (that count is the contact ratio). Each returned point's contact normal is
 * simply `mesh.loaDir`.
 */
export function contactPoints(a: GearGeometry, mesh: MeshGeometry, thetaA: number): Pt[] {
  const { pitchPoint, loaDir, loaStart, loaEnd, basePitch } = mesh;
  const uStart = signedAlong(loaStart, pitchPoint, loaDir);
  const uEnd = signedAlong(loaEnd, pitchPoint, loaDir);
  if (!(uEnd > uStart) || !(basePitch > 0)) return [];
  const travel = a.baseRadius * thetaA; // belt distance unwound
  // The leading engaged tooth's position within [uStart, uEnd].
  const span = uEnd - uStart;
  const lead = uStart + ((((travel - uStart) % basePitch) + basePitch) % basePitch);
  const pts: Pt[] = [];
  // Walk backward by base pitches to collect every simultaneously-engaged pair.
  for (let u = lead; u <= uEnd + 1e-9; u += basePitch) {
    if (u >= uStart - 1e-9 && u <= uEnd + 1e-9) {
      pts.push({ x: pitchPoint.x + u * loaDir.x, y: pitchPoint.y + u * loaDir.y });
    }
  }
  for (let u = lead - basePitch; u >= uStart - 1e-9; u -= basePitch) {
    pts.push({ x: pitchPoint.x + u * loaDir.x, y: pitchPoint.y + u * loaDir.y });
  }
  void span;
  return pts;
}

// --- SVG helper (pure) ------------------------------------------------------

/** Turn a point list into an SVG path `d` string. */
export function toPathD(points: Pt[], close = true): string {
  if (points.length === 0) return "";
  let d = `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(3)} ${points[i].y.toFixed(3)}`;
  }
  if (close) d += " Z";
  return d;
}
