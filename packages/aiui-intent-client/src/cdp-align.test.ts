/**
 * deriveCdpAlignment — the pure verdict over the two evidence sources (the
 * liveness-filtered driver ROSTER; the bound channel's /intent/cdp/info).
 * One test per distinguishable state, the shared (co-driving) rows the
 * multi-agent workflow depends on, and the evidence-precedence rows the
 * module doc promises.
 */

import { describe, expect, it } from "vitest";
import {
  type CdpAlignment,
  deriveCdpAlignment,
  describeCdpAlignment,
  describeDrivers,
  isSharedAlignment,
} from "./cdp-align";

describe("deriveCdpAlignment", () => {
  it("aligned, sole driver: the roster names the bound channel alone", () => {
    expect(
      deriveCdpAlignment({
        boundPort: 4100,
        drivers: [{ port: 4100 }],
        channelInfo: { available: true, browserUrl: "http://127.0.0.1:9222", tagged: true },
      }),
    ).toEqual({
      state: "aligned",
      boundPort: 4100,
      drivers: [{ port: 4100 }],
      channelBrowserUrl: "http://127.0.0.1:9222",
    });
  });

  it("aligned, SHARED: co-drivers are the others in the roster (the purple case)", () => {
    const verdict = deriveCdpAlignment({
      boundPort: 4100,
      drivers: [
        { port: 4100 },
        { port: 4200, label: "pdum_aiui :4200" },
        { port: 4300, label: "test app :4300" },
      ],
      channelInfo: { available: true, tagged: true },
    });
    expect(verdict.state).toBe("aligned");
    expect(verdict.coDrivers).toEqual([
      { port: 4200, label: "pdum_aiui :4200" },
      { port: 4300, label: "test app :4300" },
    ]);
    expect(isSharedAlignment(verdict)).toBe(true);
  });

  it("driven-by-other: a nonempty roster WITHOUT the bound channel (coDrivers = all of them)", () => {
    const verdict = deriveCdpAlignment({
      boundPort: 4100,
      drivers: [{ port: 4200 }],
      channelInfo: { available: true, tagged: true },
    });
    expect(verdict).toEqual({
      state: "driven-by-other",
      boundPort: 4100,
      drivers: [{ port: 4200 }],
      coDrivers: [{ port: 4200 }],
    });
    expect(isSharedAlignment(verdict)).toBe(false);
  });

  it("channel-drives-other: empty roster here, but the bound channel has an endpoint", () => {
    expect(
      deriveCdpAlignment({
        boundPort: 4100,
        drivers: [],
        channelInfo: { available: true, browserUrl: "http://127.0.0.1:9222", tagged: true },
      }),
    ).toEqual({
      state: "channel-drives-other",
      boundPort: 4100,
      channelBrowserUrl: "http://127.0.0.1:9222",
    });
  });

  it("channel-drives-other also covers tagged:false — the tagger may just not have landed yet", () => {
    expect(
      deriveCdpAlignment({
        boundPort: 4100,
        drivers: [],
        channelInfo: { available: true, tagged: false },
      }).state,
    ).toBe("channel-drives-other");
  });

  it("channel-no-cdp: the bound channel reports no endpoint (agent has no browser)", () => {
    expect(
      deriveCdpAlignment({ boundPort: 4100, drivers: [], channelInfo: { available: false } }),
    ).toEqual({ state: "channel-no-cdp", boundPort: 4100 });
  });

  it("unknown: no bound channel, whatever else is known", () => {
    expect(
      deriveCdpAlignment({
        boundPort: undefined,
        drivers: [{ port: 4200 }],
        channelInfo: { available: true },
      }),
    ).toEqual({ state: "unknown" });
  });

  it("unknown (with the port): bound, empty roster, and the channel's info probe failed", () => {
    expect(deriveCdpAlignment({ boundPort: 4100, drivers: [], channelInfo: undefined })).toEqual({
      state: "unknown",
      boundPort: 4100,
    });
  });

  it("a bound roster entry needs no channel info to say aligned (an entry is proof by itself)", () => {
    expect(
      deriveCdpAlignment({ boundPort: 4100, drivers: [{ port: 4100 }], channelInfo: undefined })
        .state,
    ).toBe("aligned");
  });
});

describe("describeCdpAlignment / describeDrivers", () => {
  it("labels fall back to :port", () => {
    expect(describeDrivers([{ port: 4200 }, { port: 4300, label: "app :4300" }])).toBe(
      ":4200, app :4300",
    );
  });

  const rows: Array<[CdpAlignment | undefined, string]> = [
    [{ state: "aligned", boundPort: 4100 }, "aligned"],
    [
      {
        state: "aligned",
        boundPort: 4100,
        coDrivers: [{ port: 4200, label: "pdum_aiui :4200" }],
      },
      "SHARED",
    ],
    [{ state: "driven-by-other", boundPort: 4100, drivers: [{ port: 4200 }] }, ":4200"],
    [{ state: "channel-drives-other", boundPort: 4100 }, "different browser"],
    [{ state: "channel-no-cdp", boundPort: 4100 }, "no CDP"],
    [{ state: "unknown" }, "unknown"],
    [undefined, "unknown"],
  ];
  it("names every state (the pill tooltip + console line)", () => {
    for (const [alignment, expected] of rows) {
      expect(describeCdpAlignment(alignment)).toContain(expected);
    }
  });
});
