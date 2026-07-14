/**
 * telemetry.ts — what the pen actually tells us, normalized. Playbook layer 1:
 * pure, realm-free, no DOM.
 *
 * This module exists because the whole tilt half of the pencil — the eccentric
 * dab, the charcoal broadening, the reason there is one instrument instead of
 * ten — rests on an *unverified fact about Safari*: does an Apple Pencil report
 * its orientation, and in which of the two coordinate systems the Pointer
 * Events spec offers?
 *
 *  - `tiltX` / `tiltY` — the classic pair. Angles (degrees, -90..90) from
 *    vertical, measured in the X-Z and Y-Z planes.
 *  - `altitudeAngle` / `azimuthAngle` — the newer pair. Elevation from the
 *    *surface* (radians, 0 = flat on the page, π/2 = straight up) and a compass
 *    bearing in the plane of the page (radians, 0..2π, from +X toward +Y).
 *
 * Browsers do not agree on which to provide, so we take whatever is offered and
 * derive the other. The two are equivalent up to a coordinate change — the pen's
 * axis is one direction vector either way:
 *
 *     axis = (cos(alt)·cos(az),  cos(alt)·sin(az),  sin(alt))
 *     tan(tiltX) = axis.x / axis.z = cos(az) / tan(alt)
 *     tan(tiltY) = axis.y / axis.z = sin(az) / tan(alt)
 *
 * from which the inverse follows by dividing (azimuth) and by summing squares
 * (altitude). The degenerate cases — a pen exactly upright, where azimuth is
 * undefined, and a pen exactly flat, where the tangents blow up — are the reason
 * this is a tested pure function and not three lines inlined into a pointer
 * handler.
 *
 * Nothing here decides whether the numbers are any GOOD. A browser can carry an
 * `altitudeAngle` property and hard-code it to π/2 forever, and no amount of
 * feature detection can tell that from a user holding the pen upright. Only
 * moving the pen can. That is what {@link observe} is for, and why the Lab's
 * first page is a readout rather than a brush.
 */

/**
 * The structural shape we need from a `PointerEvent`. Declared structurally, not
 * as `PointerEvent`, so layer 1 stays free of the DOM and tests can hand us a
 * plain object — which matters more than usual here, because jsdom's
 * `PointerEvent` does not carry these fields at all.
 */
export interface PointerLike {
  clientX: number;
  clientY: number;
  timeStamp: number;
  pressure: number;
  pointerType: string;
  tiltX?: number;
  tiltY?: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  twist?: number;
  width?: number;
  height?: number;
  /**
   * The two Pointer Events extensions, probed for EXISTENCE (never called here).
   * Whether the API is present is a different question from whether it returned
   * anything, and conflating them is how you misread a coalescing ratio of 1.00:
   * it means "we saw one sample per event", which is a catastrophe if the API is
   * missing and a non-event if the API is there and simply had nothing to batch.
   */
  getCoalescedEvents?: () => unknown[];
  getPredictedEvents?: () => unknown[];
}

/** The pointing device, narrowed to the three the surface treats differently. */
export type PenKind = "pen" | "touch" | "mouse";

/**
 * One normalized sample. This is the currency of the whole pipeline: filtering,
 * cusp detection, splining, resampling, and dab generation all speak it.
 *
 * `altitude`/`azimuth` are always populated (derived if not reported), so
 * downstream code never branches on which coordinate system a browser chose.
 * Whether they are *meaningful* is what {@link PenSupport} and {@link observe}
 * are for.
 */
export interface PenSample {
  x: number;
  y: number;
  /** Event timestamp, ms. The velocity signal — the only width cue a mouse has. */
  t: number;
  /** 0..1. A mouse reports 0 (up) or 0.5 (down); a pen reports a real range. */
  pressure: number;
  /** Radians, 0 (flat on the page) .. π/2 (upright). */
  altitude: number;
  /** Radians, 0..2π, from +X toward +Y. Undefined-in-principle when upright; 0 there. */
  azimuth: number;
  /** Barrel rotation, degrees 0..359. Almost nothing reports it. */
  twist: number;
  kind: PenKind;
  /** Contact geometry, px — how palm rejection tells a palm from a fingertip. */
  width: number;
  height: number;
}

/** Which fields and APIs the browser actually put on the event. */
export interface PenSupport {
  kind: PenKind;
  /** `tiltX`/`tiltY` were present on the event object. */
  tilt: boolean;
  /** `altitudeAngle`/`azimuthAngle` were present on the event object. */
  spherical: boolean;
  twist: boolean;
  /** `getCoalescedEvents()` EXISTS. Says nothing about whether it returned more than one. */
  coalescedApi: boolean;
  /** `getPredictedEvents()` EXISTS — the latency-hiding lever (phase 3). */
  predictedApi: boolean;
}

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Narrow a `pointerType` string to the three kinds we act on. Unknown → touch. */
export function penKind(pointerType: string): PenKind {
  return pointerType === "pen" ? "pen" : pointerType === "mouse" ? "mouse" : "touch";
}

/**
 * (altitude, azimuth) → (tiltX, tiltY), in degrees. The forward direction of the
 * identity in the module header.
 *
 * A pen lying flat (`altitude === 0`) has no well-defined tilt in this
 * coordinate system — the axis is in the page plane, so the "angle from
 * vertical" saturates at ±90° and which of tiltX/tiltY carries it depends
 * entirely on the azimuth. We resolve it by projecting the flat axis onto each
 * plane, which gives the spec's own answers at the four cardinal azimuths and a
 * continuous interpolation between them.
 */
export function tiltFromSpherical(
  altitude: number,
  azimuth: number,
): {
  tiltX: number;
  tiltY: number;
} {
  const alt = clamp(altitude, 0, HALF_PI);
  const az = normalizeAngle(azimuth);
  if (alt === 0) {
    // Flat: the axis lies in the page. Saturate to the ±90° the spec uses.
    return { tiltX: Math.round(Math.cos(az) * 90), tiltY: Math.round(Math.sin(az) * 90) };
  }
  const tanAlt = Math.tan(alt);
  return {
    tiltX: Math.atan(Math.cos(az) / tanAlt) * DEG,
    tiltY: Math.atan(Math.sin(az) / tanAlt) * DEG,
  };
}

/**
 * (tiltX, tiltY) in degrees → (altitude, azimuth) in radians. The inverse.
 *
 * Upright (both tilts 0) leaves azimuth genuinely undefined — the pen has no
 * lean, so it has no bearing. We return 0 rather than NaN, because every
 * consumer of azimuth multiplies it into a dab's rotation, and a dab of zero
 * eccentricity does not care which way it is turned.
 */
export function sphericalFromTilt(
  tiltX: number,
  tiltY: number,
): {
  altitude: number;
  azimuth: number;
} {
  const x = clamp(tiltX, -90, 90);
  const y = clamp(tiltY, -90, 90);
  if (x === 0 && y === 0) {
    return { altitude: HALF_PI, azimuth: 0 }; // upright; bearing undefined
  }
  // tan(±90°) is infinite in exact arithmetic and merely enormous in floating
  // point, which would *almost* work — but "almost" here means an altitude of
  // 6e-17 instead of 0, so pin the flat case explicitly.
  const flat = Math.abs(x) === 90 || Math.abs(y) === 90;
  if (flat) {
    return { altitude: 0, azimuth: normalizeAngle(Math.atan2(y, x)) };
  }
  const tanX = Math.tan(x * RAD);
  const tanY = Math.tan(y * RAD);
  return {
    altitude: Math.atan(1 / Math.hypot(tanX, tanY)),
    azimuth: normalizeAngle(Math.atan2(tanY, tanX)),
  };
}

/** What orientation data this event object carries (not whether it is any good). */
export function penSupport(event: PointerLike): PenSupport {
  return {
    kind: penKind(event.pointerType),
    tilt: event.tiltX !== undefined && event.tiltY !== undefined,
    spherical: event.altitudeAngle !== undefined && event.azimuthAngle !== undefined,
    twist: event.twist !== undefined,
    coalescedApi: typeof event.getCoalescedEvents === "function",
    predictedApi: typeof event.getPredictedEvents === "function",
  };
}

/**
 * Normalize a pointer event into a {@link PenSample}, deriving whichever
 * orientation pair the browser withheld.
 *
 * Preference order when both are present: **spherical wins**. It is the newer,
 * higher-resolution pair (radians, not rounded integer degrees), and a tilt pair
 * derived from it loses precision that a tilt pair reported natively would also
 * have lost — so there is nothing to gain by preferring the legacy field and
 * real resolution to lose.
 *
 * With neither, the pen is treated as upright: `altitude = π/2`, `azimuth = 0`.
 * That is exactly right for a mouse, and it is the graceful degradation for a
 * stylus whose browser tells us nothing — the tilt dynamics simply go quiet and
 * pressure and velocity carry the stroke alone.
 */
export function penSample(event: PointerLike): PenSample {
  const support = penSupport(event);
  let altitude = HALF_PI;
  let azimuth = 0;
  if (support.spherical) {
    altitude = clamp(event.altitudeAngle as number, 0, HALF_PI);
    azimuth = normalizeAngle(event.azimuthAngle as number);
  } else if (support.tilt) {
    const derived = sphericalFromTilt(event.tiltX as number, event.tiltY as number);
    altitude = derived.altitude;
    azimuth = derived.azimuth;
  }
  return {
    x: event.clientX,
    y: event.clientY,
    t: event.timeStamp,
    pressure: clamp(event.pressure, 0, 1),
    altitude,
    azimuth,
    twist: event.twist ?? 0,
    kind: support.kind,
    width: event.width ?? 0,
    height: event.height ?? 0,
  };
}

// ── the measurement: what varied, over the whole session ──────────────────────

/** The observed range of one scalar. `count` is how many samples moved through it. */
export interface Range {
  min: number;
  max: number;
  count: number;
}

/**
 * The running answer to "is this telemetry real?". A property that is *present*
 * but never *varies* across a session of deliberate tilting is a stub, and the
 * span is the only thing that can tell you so. This is the number the Lab exists
 * to put in front of a human on day one.
 */
export interface Telemetry {
  support: PenSupport | undefined;
  samples: number;
  /** `pointermove` events, as distinct from the samples coalesced inside them. */
  events: number;
  coalesced: number;
  predicted: number;
  pressure: Range;
  altitude: Range;
  azimuth: Range;
  twist: Range;
  /**
   * The **median** interval between consecutive samples, ms — the honest sample
   * rate, and the reason this is not simply `samples / elapsed`.
   *
   * A session-span average is a trap, and it caught us: it divides by all the
   * time the pen was in the AIR — between strokes, while you looked at the panel,
   * while you thought about what to draw next. Draw for a second, pause for two,
   * draw for a second, and a 120Hz pen reports 40Hz. The bug is invisible because
   * the number it produces is plausible.
   *
   * So: intervals are collected per sample, gaps longer than {@link IDLE_GAP_MS}
   * are discarded as "the pen was not down", and the median (not the mean — one
   * hitch on a garbage-collection pause would drag a mean) is what gets reported.
   */
  medianIntervalMs: number;
  /** The shortest interval ever seen, ms — what the pen can do at its best. */
  minIntervalMs: number;
  /** Median rate, Hz. The number to trust. 0 until two samples land. */
  rateHz: number;
  /** Peak rate, Hz, from the shortest interval. */
  peakRateHz: number;
  /**
   * Samples per pointer event. **1.0 means the browser is not coalescing** — we
   * are seeing one sample per event, and the pen's real high-frequency signal (an
   * Apple Pencil samples far faster than the display refreshes) is being thrown
   * away before it reaches us.
   */
  coalescingRatio: number;
  /** The recent inter-sample intervals the median is taken over (idle gaps excluded). */
  intervals: readonly number[];
  firstT: number;
  lastT: number;
}

/**
 * Longer than this between two samples and the pen was not drawing — it was
 * lifted, or you were thinking. 100ms is ~6 frames at 60Hz: far longer than any
 * genuine inter-sample gap, far shorter than any real pause.
 */
export const IDLE_GAP_MS = 100;

/** How many recent intervals to keep for the median. Enough to be stable, small enough to be live. */
const INTERVAL_WINDOW = 512;

const EMPTY_RANGE: Range = { min: Number.NaN, max: Number.NaN, count: 0 };

export function emptyTelemetry(): Telemetry {
  return {
    support: undefined,
    samples: 0,
    events: 0,
    coalesced: 0,
    predicted: 0,
    pressure: { ...EMPTY_RANGE },
    altitude: { ...EMPTY_RANGE },
    azimuth: { ...EMPTY_RANGE },
    twist: { ...EMPTY_RANGE },
    medianIntervalMs: 0,
    minIntervalMs: 0,
    rateHz: 0,
    peakRateHz: 0,
    coalescingRatio: 0,
    intervals: [],
    firstT: Number.NaN,
    lastT: Number.NaN,
  };
}

/** The median of a list. Not the mean — one GC pause would drag a mean and lie. */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Widen a range by one value. A fresh range adopts the value as both bounds. */
export function widen(range: Range, value: number): Range {
  if (range.count === 0) {
    return { min: value, max: value, count: 1 };
  }
  return {
    min: Math.min(range.min, value),
    max: Math.max(range.max, value),
    count: range.count + 1,
  };
}

/** Did this scalar ever actually move? The stub test. */
export function varied(range: Range, epsilon = 1e-6): boolean {
  return range.count > 1 && range.max - range.min > epsilon;
}

/**
 * Fold one batch of samples (one pointer event's worth, after coalescing) into
 * the running telemetry. Pure — the Lab's cell calls it, the tests call it, and
 * neither needs a canvas.
 */
export function observe(
  prev: Telemetry,
  samples: readonly PenSample[],
  meta: { support: PenSupport; coalesced: number; predicted: number },
): Telemetry {
  if (samples.length === 0) {
    return prev;
  }
  const next: Telemetry = {
    ...prev,
    support: meta.support,
    samples: prev.samples + samples.length,
    events: prev.events + 1,
    coalesced: prev.coalesced + meta.coalesced,
    predicted: prev.predicted + meta.predicted,
  };

  const intervals = [...prev.intervals];
  let pressure = next.pressure;
  let altitude = next.altitude;
  let azimuth = next.azimuth;
  let twist = next.twist;
  let firstT = next.firstT;
  let lastT = next.lastT;

  for (const s of samples) {
    pressure = widen(pressure, s.pressure);
    altitude = widen(altitude, s.altitude);
    azimuth = widen(azimuth, s.azimuth);
    twist = widen(twist, s.twist);

    // The interval since the PREVIOUS sample — but only if the pen was still
    // down. A gap longer than IDLE_GAP_MS is the pen in the air, and folding it
    // into the rate is exactly the mistake that made a 120Hz pen read as 38Hz.
    if (!Number.isNaN(lastT)) {
      const dt = s.t - lastT;
      if (dt > 0 && dt <= IDLE_GAP_MS) {
        intervals.push(dt);
      }
    }
    firstT = Number.isNaN(firstT) ? s.t : firstT;
    lastT = s.t;
  }

  if (intervals.length > INTERVAL_WINDOW) {
    intervals.splice(0, intervals.length - INTERVAL_WINDOW);
  }

  const medianMs = median(intervals);
  const minMs = intervals.length > 0 ? Math.min(...intervals) : 0;

  return {
    ...next,
    pressure,
    altitude,
    azimuth,
    twist,
    firstT,
    lastT,
    intervals,
    medianIntervalMs: medianMs,
    minIntervalMs: minMs,
    rateHz: medianMs > 0 ? 1000 / medianMs : 0,
    peakRateHz: minMs > 0 ? 1000 / minMs : 0,
    coalescingRatio: next.events > 0 ? next.samples / next.events : 0,
  };
}

/**
 * The verdict, in the terms the design actually needs: is the tilt half of the
 * pencil alive on this device?
 *
 *  - `"native"` — the browser reported orientation and it moved.
 *  - `"derived"` — we computed it from the other pair, and it moved.
 *  - `"flat"` — the field is present but never varied. A stub. Tilt is dead.
 *  - `"absent"` — no orientation data at all (a mouse, or a browser that says
 *    nothing). Not a failure: pressure and velocity carry the stroke.
 *  - `"unknown"` — not enough samples yet. Move the pen.
 */
export type TiltVerdict = "native" | "derived" | "flat" | "absent" | "unknown";

export function tiltVerdict(t: Telemetry): TiltVerdict {
  if (t.support === undefined || t.samples < 2) {
    return "unknown";
  }
  if (!t.support.tilt && !t.support.spherical) {
    return "absent";
  }
  if (!varied(t.altitude) && !varied(t.azimuth)) {
    return "flat";
  }
  return t.support.spherical ? "native" : "derived";
}

/**
 * The OTHER phase-1 question: are we getting every sample the browser has, and
 * is that enough?
 *
 * A coalescing ratio of 1.00 is meaningless on its own, and reading it as bad
 * news is the trap this function exists to close. It means "one sample per
 * event", which is:
 *
 *  - a **catastrophe** if `getCoalescedEvents()` does not exist — the browser
 *    batched the pen's high-frequency samples and we had no way to ask for them;
 *  - a **non-event** if it does exist and returned one anyway — the browser had
 *    nothing to batch, because it was already delivering one event per sample.
 *    We are seeing everything there is. The rate is simply the rate.
 *
 * Same number, opposite meanings. Only `coalescedApi` separates them.
 */
export interface InputReport {
  /** Can we reach PAST the browser's event rate to the pen's raw samples? */
  canCoalesce: boolean;
  /** How much signal we are actually getting, judged against what a pen needs. */
  level: "unknown" | "good" | "workable" | "poor";
  rateHz: number;
  /** The one-line banner. */
  headline: string;
  says: string;
}

/**
 * The rate at or above which we are getting everything a *browser* can give: the
 * display's refresh. A ProMotion iPad runs 120Hz; anything else runs 60. Above
 * ~90 we are certainly at the ProMotion ceiling.
 */
const DISPLAY_CEILING_HZ = 90;

export function inputReport(t: Telemetry): InputReport {
  const rateHz = t.rateHz;
  if (t.support === undefined || t.samples < 20) {
    return {
      canCoalesce: false,
      level: "unknown",
      rateHz,
      headline: "measuring…",
      says: "Draw a while longer.",
    };
  }

  const level = rateHz >= DISPLAY_CEILING_HZ ? "good" : rateHz >= 45 ? "workable" : "poor";
  const hz = rateHz.toFixed(0);

  if (!t.support.coalescedApi) {
    // NOT the alarm it looks like. `getCoalescedEvents` only reached WebKit in
    // Safari TP 202 (Aug 2024) and is still not Baseline, so its absence is the
    // platform, not a fault. What it costs us is the ability to reach BENEATH the
    // browser's event rate to the Pencil's raw ~240Hz — and if the event rate is
    // already the display's refresh, there is nothing beneath it worth having.
    return {
      canCoalesce: false,
      level,
      rateHz,
      headline:
        level === "good" ? `${hz} Hz — the browser's ceiling` : `${hz} Hz — below display rate`,
      says:
        level === "good"
          ? "No getCoalescedEvents() here, so we cannot reach past the browser to the Pencil's raw " +
            "~240Hz. But we are already getting the display's full refresh, which is the ceiling for " +
            "any drawing app on the web on this device. The pipeline is built for exactly this: the " +
            "spline reconstructs the path between samples, and dabs are placed by DISTANCE, not by " +
            "sample. Nothing recoverable is being missed."
          : "No getCoalescedEvents(), AND the event rate is below the display's refresh — so " +
            "something is throttling us on top of the missing API. Worth investigating.",
    };
  }

  if (t.coalescingRatio <= 1.05) {
    return {
      canCoalesce: true,
      level,
      rateHz,
      headline: `${hz} Hz — nothing to coalesce`,
      says:
        "getCoalescedEvents() is present and returns one sample per event — the browser had " +
        "nothing to batch. We are seeing every sample it produces.",
    };
  }

  return {
    canCoalesce: true,
    level,
    rateHz,
    headline: `${hz} Hz — coalescing ${t.coalescingRatio.toFixed(1)}×`,
    says: "The pen's high-frequency signal is reaching us past the frame rate.",
  };
}

// ── local helpers ────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function normalizeAngle(radians: number): number {
  return ((radians % TWO_PI) + TWO_PI) % TWO_PI;
}
