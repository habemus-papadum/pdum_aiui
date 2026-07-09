// @vitest-environment jsdom
/**
 * cell-attribution.test.tsx — the EXACT mechanism's proof harness.
 *
 * Covers the two regimes the module supports and the loud-fail boundary:
 *   - reactive CHILDREN/TEXT inserts (one insert effect per child) — exact;
 *   - reactive ATTRIBUTES batched into one component effect, paired to reads by
 *     position — exact when every dynamic attribute is a cell read, including
 *     several DISTINCT cells across attributes;
 *   - a non-cell dynamic attribute sharing an attribute effect — a loud
 *     console.error, never a wrong stamp;
 *   - non-cell writers (plain-signal reads) left untouched; stable on updates;
 *   - idempotent + reversible.
 */
import { render } from "@solidjs/web";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cell } from "./cell";
import { attributedRead, enableCellAttribution } from "./cell-attribution";

const tick = () => new Promise((r) => setTimeout(r, 0));
const dc = (host: HTMLElement, sel: string) =>
  host.querySelector(sel)?.getAttribute("data-cell") ?? null;
const loc = (host: HTMLElement, sel: string) =>
  host.querySelector(sel)?.getAttribute("data-cell-loc") ?? null;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe("enableCellAttribution (exact)", () => {
  it("attributes inserts and all-cell attributes exactly, and never mis-stamps", async () => {
    const [k, setK] = createSignal(1);
    const { curves, probability, moments, A, B } = createRoot(() => ({
      curves: cell(
        () => k(),
        (n) => ({ mix: `M${n}`, band: `B${n}`, c1: `C${n}` }),
        {
          name: "curves",
          loc: "s:1",
        },
      ),
      probability: cell(
        () => k(),
        (n) => n * 0.5,
        { name: "probability", loc: "s:2" },
      ),
      moments: cell(
        () => k(),
        (n) => ({ mean: n, sd: n * 2 }),
        { name: "moments", loc: "s:3" },
      ),
      A: cell(
        () => k(),
        (n) => `a${n}`,
        { name: "A", loc: "s:4" },
      ),
      B: cell(
        () => k(),
        (n) => `b${n}`,
        { name: "B", loc: "s:5" },
      ),
    }));

    dispose = enableCellAttribution();
    const host = document.createElement("div");
    document.body.append(host);

    render(
      () => (
        <div>
          {/* attribute effect: three paths, all cells (curves ×3), position-paired */}
          <svg aria-label="plot">
            <path class="p-mix" d={attributedRead(curves)?.mix ?? ""} />
            <path class="p-band" d={attributedRead(curves)?.band ?? ""} />
            <path class="p-c1" d={attributedRead(curves)?.c1 ?? ""} />
            {/* two DISTINCT cells across attributes — position pairing must split them */}
            <rect class="r-a" width={attributedRead(A) ?? ""} />
            <rect class="r-b" width={attributedRead(B) ?? ""} />
          </svg>
          {/* inserts (children), one cell each */}
          <span class="prob">{String(attributedRead(probability) ?? "…")}</span>
          <span class="mean">{attributedRead(moments)?.mean ?? 0}</span>
          <span class="sd">{attributedRead(moments)?.sd ?? 0}</span>
          {/* non-cell writer: reads a plain signal */}
          <span class="pill">{k()}</span>
        </div>
      ),
      host,
    );

    const check = () => {
      expect(dc(host, ".p-mix")).toBe("curves");
      expect(dc(host, ".p-band")).toBe("curves");
      expect(dc(host, ".p-c1")).toBe("curves");
      expect(dc(host, ".r-a")).toBe("A"); // distinct cells split correctly
      expect(dc(host, ".r-b")).toBe("B");
      expect(dc(host, ".prob")).toBe("probability");
      expect(dc(host, ".mean")).toBe("moments");
      expect(dc(host, ".sd")).toBe("moments");
      expect(dc(host, ".pill")).toBe(null); // reads no cell
    };

    check();
    expect(loc(host, ".p-mix")).toBe("s:1");
    expect(loc(host, ".r-b")).toBe("s:5");
    expect(loc(host, ".prob")).toBe("s:2");

    await tick();
    check();
    for (const v of [2, 3, 4]) {
      setK(v);
      await tick();
      check(); // frozen at the exact construction pairing
    }
  });

  it("loud-fails (console.error) instead of mis-stamping a non-cell dynamic attribute", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const [k] = createSignal(5);
    const c = createRoot(() =>
      cell(
        () => k(),
        (n) => `d${n}`,
        { name: "solo", loc: "x:1" },
      ),
    );
    dispose = enableCellAttribution();
    const host = document.createElement("div");
    document.body.append(host);

    render(
      () => (
        // a non-cell dynamic attribute (x1={k()}) shares the component's ONE
        // attribute effect with a cell attribute — unrecoverable, must loud-fail
        <svg aria-label="mixed">
          <line class="axis" x1={k()} />
          <path class="pth" d={attributedRead(c) ?? ""} />
        </svg>
      ),
      host,
    );

    expect(dc(host, ".pth")).toBe(null); // refused, not mis-stamped
    expect(dc(host, ".axis")).toBe(null);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("[cell-attribution]"));
  });

  it("is idempotent and fully reversible", async () => {
    const [n, setN] = createSignal(1);
    const c = createRoot(() =>
      cell(
        () => n(),
        (v) => v,
        { name: "rev", loc: "r:1" },
      ),
    );
    const off1 = enableCellAttribution();
    const off2 = enableCellAttribution();
    expect(off1).toBe(off2);

    const host = document.createElement("div");
    document.body.append(host);
    render(() => <b class="v">{attributedRead(c) ?? 0}</b>, host);
    expect(dc(host, ".v")).toBe("rev");
    off1();

    const host2 = document.createElement("div");
    document.body.append(host2);
    render(() => <b class="v">{attributedRead(c) ?? 0}</b>, host2);
    await tick();
    setN(2);
    await tick();
    expect(dc(host2, ".v")).toBe(null); // instrumentation removed
  });
});
