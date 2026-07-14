import { describe, expect, it } from "vitest";
import {
  emptyTelemetry,
  type InputReport,
  inputReport,
  observe,
  type PointerLike,
  penSample,
  penSupport,
  sphericalFromTilt,
  type Telemetry,
  tiltFromSpherical,
  tiltVerdict,
  varied,
} from "./telemetry";

const HALF_PI = Math.PI / 2;

/** A pointer event with only the fields a test cares about. */
function event(overrides: Partial<PointerLike> = {}): PointerLike {
  return {
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    pressure: 0.5,
    pointerType: "pen",
    ...overrides,
  };
}

describe("tilt ↔ spherical", () => {
  it("an upright pen has no bearing", () => {
    const { altitude, azimuth } = sphericalFromTilt(0, 0);
    expect(altitude).toBeCloseTo(HALF_PI, 10);
    // Azimuth is genuinely undefined here; 0 is the answer we commit to, because
    // a round dab does not care which way it is turned.
    expect(azimuth).toBe(0);
  });

  it("leaning along +X reads as azimuth 0, and along +Y as π/2", () => {
    expect(sphericalFromTilt(45, 0).azimuth).toBeCloseTo(0, 10);
    expect(sphericalFromTilt(0, 45).azimuth).toBeCloseTo(HALF_PI, 10);
    expect(sphericalFromTilt(-45, 0).azimuth).toBeCloseTo(Math.PI, 10);
  });

  it("leaning further lowers the altitude", () => {
    const upright = sphericalFromTilt(10, 0).altitude;
    const leaning = sphericalFromTilt(60, 0).altitude;
    expect(leaning).toBeLessThan(upright);
    expect(leaning).toBeGreaterThan(0);
  });

  it("pins the flat case to exactly zero rather than 6e-17", () => {
    // tan(90°) is enormous-but-finite in floating point, so the general formula
    // would *almost* work — and "almost" here is the difference between a pencil
    // lying flat and one standing a hair off the page.
    expect(sphericalFromTilt(90, 0).altitude).toBe(0);
    expect(sphericalFromTilt(0, -90).altitude).toBe(0);
  });

  it("round-trips through both coordinate systems", () => {
    const cases: Array<[number, number]> = [
      [HALF_PI, 0],
      [1.2, 0.3],
      [0.9, 2.0],
      [0.4, 4.5],
      [0.2, Math.PI],
      [1.0, 6.0],
    ];
    for (const [altitude, azimuth] of cases) {
      const { tiltX, tiltY } = tiltFromSpherical(altitude, azimuth);
      const back = sphericalFromTilt(tiltX, tiltY);
      expect(back.altitude).toBeCloseTo(altitude, 6);
      // An upright pen's azimuth is not recoverable — there is no lean to read a
      // bearing from. Every other case must survive the round trip.
      if (altitude < HALF_PI - 1e-9) {
        expect(back.azimuth).toBeCloseTo(azimuth, 6);
      }
    }
  });
});

describe("penSample", () => {
  it("prefers the spherical pair when a browser offers both", () => {
    // Higher resolution: radians, not rounded integer degrees. There is nothing
    // to gain from the legacy pair and real precision to lose.
    const s = penSample(event({ altitudeAngle: 0.7, azimuthAngle: 1.1, tiltX: 12, tiltY: 34 }));
    expect(s.altitude).toBeCloseTo(0.7, 10);
    expect(s.azimuth).toBeCloseTo(1.1, 10);
  });

  it("derives the spherical pair when only tilt is offered", () => {
    const s = penSample(event({ tiltX: 45, tiltY: 0 }));
    expect(s.altitude).toBeCloseTo(HALF_PI - Math.PI / 4, 6);
    expect(s.azimuth).toBeCloseTo(0, 6);
  });

  it("treats a pen with no orientation data as upright — the tilt terms go quiet", () => {
    const s = penSample(event({ pointerType: "mouse", pressure: 0.5 }));
    expect(s.altitude).toBe(HALF_PI);
    expect(s.azimuth).toBe(0);
    expect(s.kind).toBe("mouse");
  });

  it("clamps pressure and normalizes azimuth", () => {
    const s = penSample(event({ pressure: 1.4, altitudeAngle: 0.5, azimuthAngle: -1 }));
    expect(s.pressure).toBe(1);
    expect(s.azimuth).toBeCloseTo(Math.PI * 2 - 1, 10);
  });
});

describe("penSupport", () => {
  it("reports which fields the event object actually carries", () => {
    expect(penSupport(event({ tiltX: 0, tiltY: 0 }))).toMatchObject({
      tilt: true,
      spherical: false,
      twist: false,
    });
    expect(penSupport(event({ altitudeAngle: 1, azimuthAngle: 1, twist: 0 }))).toMatchObject({
      tilt: false,
      spherical: true,
      twist: true,
    });
  });
});

describe("observe — the measurement that answers 'is this telemetry real?'", () => {
  const support = {
    kind: "pen" as const,
    tilt: false,
    spherical: true,
    twist: false,
    coalescedApi: true,
    predictedApi: true,
  };

  it("calls a present-but-never-moving orientation what it is: flat", () => {
    // The failure mode we are actually guarding against: a browser that carries
    // `altitudeAngle` and hard-codes it. No feature detection can see this —
    // only moving the pen can.
    let t = emptyTelemetry();
    for (let i = 0; i < 10; i++) {
      const s = penSample(event({ altitudeAngle: HALF_PI, azimuthAngle: 0, timeStamp: i * 8 }));
      t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
    }
    expect(varied(t.altitude)).toBe(false);
    expect(tiltVerdict(t)).toBe("flat");
  });

  it("calls a moving, natively-reported orientation native", () => {
    let t = emptyTelemetry();
    for (let i = 0; i < 10; i++) {
      const s = penSample(
        event({ altitudeAngle: 0.4 + i * 0.1, azimuthAngle: i * 0.2, timeStamp: i * 8 }),
      );
      t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
    }
    expect(varied(t.altitude)).toBe(true);
    expect(tiltVerdict(t)).toBe("native");
  });

  it("calls a moving, derived orientation derived", () => {
    const tiltOnly = {
      kind: "pen" as const,
      tilt: true,
      spherical: false,
      twist: false,
      coalescedApi: true,
      predictedApi: true,
    };
    let t = emptyTelemetry();
    for (let i = 0; i < 10; i++) {
      const s = penSample(event({ tiltX: i * 5, tiltY: 10, timeStamp: i * 8 }));
      t = observe(t, [s], { support: tiltOnly, coalesced: 1, predicted: 0 });
    }
    expect(tiltVerdict(t)).toBe("derived");
  });

  it("calls a mouse absent — which is not a failure", () => {
    const mouse = {
      kind: "mouse" as const,
      tilt: false,
      spherical: false,
      twist: false,
      coalescedApi: true,
      predictedApi: false,
    };
    let t = emptyTelemetry();
    for (let i = 0; i < 4; i++) {
      const s = penSample(event({ pointerType: "mouse", timeStamp: i * 8 }));
      t = observe(t, [s], { support: mouse, coalesced: 1, predicted: 0 });
    }
    expect(tiltVerdict(t)).toBe("absent");
  });

  it("says unknown until the pen has actually moved", () => {
    expect(tiltVerdict(emptyTelemetry())).toBe("unknown");
  });

  it("computes a sample rate from the timestamps", () => {
    let t = emptyTelemetry();
    for (let i = 0; i < 11; i++) {
      const s = penSample(event({ timeStamp: i * 10, altitudeAngle: 1, azimuthAngle: 0 }));
      t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
    }
    // 11 samples, 10ms apart ⇒ 100Hz.
    expect(t.rateHz).toBeCloseTo(100, 6);
    expect(t.samples).toBe(11);
    expect(t.events).toBe(11);
  });

  it("does NOT let the pen being in the air drag the rate down", () => {
    // The bug this exists to prevent, and it was a real one: measuring
    // samples ÷ session-span divides by all the time the pen was LIFTED. Two
    // bursts of 120Hz drawing with a two-second think between them reported
    // ~38Hz on a real iPad, and the number was plausible enough to be believed.
    let t = emptyTelemetry();
    let clock = 0;
    for (let burst = 0; burst < 2; burst++) {
      for (let i = 0; i < 60; i++) {
        const s = penSample(event({ timeStamp: clock, altitudeAngle: 1, azimuthAngle: 0 }));
        t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
        clock += 8.333; // 120Hz
      }
      clock += 2000; // the pen goes up; you think; you draw again
    }
    // The honest answer is 120Hz. A session-span average would have said ~29.
    expect(t.rateHz).toBeCloseTo(120, 0);
    expect(t.intervals.every((dt) => dt <= 100)).toBe(true);
  });

  it("reports the coalescing ratio — 1.0 means the browser is not coalescing", () => {
    // The number that says whether a pen's real high-frequency signal is
    // reaching us at all, or being decimated to one sample per frame.
    let uncoalesced = emptyTelemetry();
    for (let i = 0; i < 5; i++) {
      const s = penSample(event({ timeStamp: i * 8, altitudeAngle: 1, azimuthAngle: 0 }));
      uncoalesced = observe(uncoalesced, [s], { support, coalesced: 1, predicted: 0 });
    }
    expect(uncoalesced.coalescingRatio).toBeCloseTo(1, 6);

    let coalescedT = emptyTelemetry();
    for (let e = 0; e < 5; e++) {
      const batch = [0, 1, 2, 3].map((i) =>
        penSample(event({ timeStamp: e * 16 + i * 4, altitudeAngle: 1, azimuthAngle: 0 })),
      );
      coalescedT = observe(coalescedT, batch, { support, coalesced: 4, predicted: 0 });
    }
    expect(coalescedT.coalescingRatio).toBeCloseTo(4, 6);
  });

  it("reads the SAME coalescing ratio of 1.00 two opposite ways", () => {
    // The trap this closes. "One sample per event" is:
    //   - a catastrophe if getCoalescedEvents() does not exist — the browser
    //     batched the pen's samples and we had no way to ask for them;
    //   - a non-event if it DOES exist and returned one anyway — there was
    //     nothing to batch, so we are seeing everything there is.
    // Same number. Opposite meanings. Only the API probe separates them.
    const drawAt = (rateHz: number, api: boolean): Telemetry => {
      const support = {
        kind: "pen" as const,
        tilt: false,
        spherical: true,
        twist: false,
        coalescedApi: api,
        predictedApi: api,
      };
      let t = emptyTelemetry();
      const dt = 1000 / rateHz;
      for (let i = 0; i < 40; i++) {
        const s = penSample(event({ timeStamp: i * dt, altitudeAngle: 1, azimuthAngle: 0 }));
        t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
      }
      return t;
    };

    const withApi = drawAt(120, true);
    expect(withApi.coalescingRatio).toBeCloseTo(1, 6);
    expect(inputReport(withApi).canCoalesce).toBe(true); // nothing to batch — fine
    expect(inputReport(withApi).level).toBe("good");

    const withoutApi = drawAt(120, false);
    expect(withoutApi.coalescingRatio).toBeCloseTo(1, 6); // the SAME number…
    expect(inputReport(withoutApi).canCoalesce).toBe(false); // …and a different reading
  });

  it("does not cry wolf: no coalescing API at full display rate is FINE", () => {
    // Measured on a real iPad: 125Hz, and `getCoalescedEvents` absent (WebKit only
    // shipped it in Safari TP 202, Aug 2024, and it is still not Baseline). The
    // first wording called this "SAMPLES LOST", which is technically true and
    // practically a lie: at the display's refresh there is nothing beneath the
    // event rate worth having, and the spline was built to bridge exactly this.
    const iPad = {
      kind: "pen" as const,
      tilt: true,
      spherical: true,
      twist: false,
      coalescedApi: false,
      predictedApi: false,
    };
    let t = emptyTelemetry();
    for (let i = 0; i < 60; i++) {
      const s = penSample(
        event({ timeStamp: i * 8, altitudeAngle: 0.5 + i * 0.01, azimuthAngle: 1 }),
      );
      t = observe(t, [s], { support: iPad, coalesced: 1, predicted: 0 });
    }
    const report = inputReport(t);
    expect(report.level).toBe("good"); // 125Hz is the ceiling, not a shortfall
    expect(report.canCoalesce).toBe(false);
    expect(report.headline).toContain("ceiling");
    expect(report.says).toContain("Nothing recoverable is being missed");
  });

  it("DOES cry wolf when there is no API and we are below display rate too", () => {
    const bad = {
      kind: "pen" as const,
      tilt: true,
      spherical: true,
      twist: false,
      coalescedApi: false,
      predictedApi: false,
    };
    let t = emptyTelemetry();
    for (let i = 0; i < 60; i++) {
      const s = penSample(event({ timeStamp: i * 33, altitudeAngle: 1, azimuthAngle: 1 }));
      t = observe(t, [s], { support: bad, coalesced: 1, predicted: 0 });
    }
    const report = inputReport(t);
    expect(report.level).toBe("poor");
    expect(report.says).toContain("throttling");
  });

  it("judges the rate against what a pen actually needs", () => {
    const at = (rateHz: number): InputReport => {
      const support = {
        kind: "pen" as const,
        tilt: false,
        spherical: true,
        twist: false,
        coalescedApi: true,
        predictedApi: true,
      };
      let t = emptyTelemetry();
      for (let i = 0; i < 40; i++) {
        const s = penSample(
          event({ timeStamp: (i * 1000) / rateHz, altitudeAngle: 1, azimuthAngle: 0 }),
        );
        t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
      }
      return inputReport(t);
    };
    expect(at(120).level).toBe("good"); // ProMotion, one event per pen sample
    expect(at(60).level).toBe("workable"); // a 60Hz display; sparse but usable
    expect(at(30).level).toBe("poor"); // something is throttling us
  });

  it("reports a peak rate from the shortest interval seen", () => {
    let t = emptyTelemetry();
    const times = [0, 10, 20, 24, 34]; // one 4ms gap among 10ms ones
    for (const time of times) {
      const s = penSample(event({ timeStamp: time, altitudeAngle: 1, azimuthAngle: 0 }));
      t = observe(t, [s], { support, coalesced: 1, predicted: 0 });
    }
    expect(t.minIntervalMs).toBeCloseTo(4, 6);
    expect(t.peakRateHz).toBeCloseTo(250, 6);
  });

  it("counts coalesced samples separately from the events that carried them", () => {
    const support2 = {
      kind: "pen" as const,
      tilt: false,
      spherical: true,
      twist: false,
      coalescedApi: true,
      predictedApi: true,
    };
    let t = emptyTelemetry();
    const batch = [0, 1, 2].map((i) =>
      penSample(event({ timeStamp: i * 4, altitudeAngle: 1, azimuthAngle: 0 })),
    );
    t = observe(t, batch, { support: support2, coalesced: 3, predicted: 2 });
    expect(t.events).toBe(1);
    expect(t.samples).toBe(3);
    expect(t.coalesced).toBe(3);
    expect(t.predicted).toBe(2);
  });
});
