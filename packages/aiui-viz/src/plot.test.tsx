// @vitest-environment jsdom
/**
 * plot.test.tsx — PlotFigure on the resize seam: the figure's width follows
 * its host's content width unless the author set one; an unmeasured host
 * leaves Plot's default.
 */
import * as Plot from "@observablehq/plot";
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeDurable } from "./durable";
import { PlotFigure } from "./plot";

class FakeResizeObserver {
  static last: FakeResizeObserver | undefined;
  readonly observed = new Set<Element>();
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.last = this;
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  report(el: Element, width: number, height: number): void {
    const entry = { target: el, contentRect: { width, height } } as unknown as ResizeObserverEntry;
    this.cb([entry], this as unknown as ResizeObserver);
  }
}

/** jsdom lays nothing out: every .plot-host measures `width` once created. */
function hostsMeasure(width: number): void {
  const proto = HTMLDivElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const original = proto.getBoundingClientRect;
  vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLDivElement,
  ) {
    if (this.classList.contains("plot-host")) {
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 } as DOMRect;
    }
    return original.call(this);
  });
}

const svgWidth = (root: HTMLElement): string | null =>
  root.querySelector("svg.plot-d6a7b5")?.getAttribute("width") ??
  root.querySelector("svg")?.getAttribute("width") ??
  null;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  disposeDurable("aiui:viewport", (b) => (b as { dispose(): void }).dispose());
  disposeDurable("aiui:resize-observer", (b) =>
    (b as { observer?: ResizeObserver }).observer?.disconnect(),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const marks = [Plot.dot([{ x: 1, y: 2 }], { x: "x", y: "y" })];

describe("PlotFigure", () => {
  it("renders at the host's content width and follows the observer", async () => {
    hostsMeasure(500);
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(() => <PlotFigure options={() => ({ height: 120, marks })} />, root);
    flush();
    expect(svgWidth(root)).toBe("500");

    const host = root.querySelector(".plot-host") as HTMLDivElement;
    FakeResizeObserver.last?.report(host, 720, 120);
    flush();
    expect(svgWidth(root)).toBe("720");
    dispose();
    root.remove();
  });

  it("keeps an author's width and does not observe the host", () => {
    hostsMeasure(500);
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(
      () => <PlotFigure options={() => ({ width: 320, height: 120, marks })} />,
      root,
    );
    flush();
    expect(svgWidth(root)).toBe("320");
    const host = root.querySelector(".plot-host") as HTMLDivElement;
    expect(FakeResizeObserver.last?.observed.has(host) ?? false).toBe(false);
    dispose();
    root.remove();
  });

  it("leaves Plot's default for an unmeasured host, and rebuilds on an options change", () => {
    hostsMeasure(0);
    const root = document.createElement("div");
    document.body.append(root);
    const [height, setHeight] = createSignal(120);
    const dispose = render(
      () => <PlotFigure options={() => ({ height: height(), marks })} />,
      root,
    );
    flush();
    expect(svgWidth(root)).toBe("640");
    expect(root.querySelector("svg")?.getAttribute("height")).toBe("120");
    setHeight(200);
    flush();
    expect(root.querySelector("svg")?.getAttribute("height")).toBe("200");
    dispose();
    root.remove();
  });
});
