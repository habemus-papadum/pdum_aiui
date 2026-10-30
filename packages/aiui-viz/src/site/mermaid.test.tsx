// @vitest-environment jsdom
/**
 * mermaid.test.tsx — the pure helpers (frontmatter config, id recovery) and
 * the mounted component over a FAKE Mermaid: the real one needs a browser
 * (getBBox, layout); the fake writes the markup shape the real one does —
 * node ids, edge data attributes, a cluster — after a controllable delay, so
 * indexing, hit resolution, marks, latest-wins and error handling are
 * exercised without one. The markup facts themselves are pinned by the
 * Mermaid 12.2 probe recorded in docs/proposals/rich-mermaid.md.
 */
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { control } from "../control";
import { resetControlSurface, tick } from "../testing";

const fake = vi.hoisted(() => {
  const state = {
    auto: true,
    pending: [] as (() => void)[],
    containers: [] as HTMLElement[],
    measuredConnected: [] as boolean[],
    renders: 0,
  };
  const svgOf = (id: string, text: string): string => {
    const nodes: string[] = [];
    const edges: [string, string][] = [];
    for (const line of text.split("\n")) {
      const m = /^\s*([\w.-]+)(?:\[[^\]]*\])?\s*-->\s*([\w.-]+)/.exec(line);
      if (m === null) continue;
      for (const n of [m[1] as string, m[2] as string]) if (!nodes.includes(n)) nodes.push(n);
      edges.push([m[1] as string, m[2] as string]);
    }
    const nodeSvg = nodes
      .map(
        (n, i) =>
          `<g class="node default" id="${id}-flowchart-${n}-${i}"><rect class="basic label-container" width="100" height="40"></rect>` +
          `<g class="label"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>${n}</p></span></div></foreignObject></g></g>`,
      )
      .join("");
    const edgeSvg = edges
      .map(
        ([a, b]) =>
          `<path d="M0,0L10,10" id="${id}-L_${a}_${b}_0" class="flowchart-link" style="stroke-dasharray: 0 0 5 4;" data-edge="true" data-et="edge" data-id="L_${a}_${b}_0"></path>`,
      )
      .join("");
    const sub = /subgraph (\w+)/.exec(text);
    const clusters =
      sub === null ? "" : `<g class="cluster" id="${id}-${sub[1]}"><rect></rect></g>`;
    return (
      `<svg id="${id}" class="flowchart"><style>#${id} .node rect{fill:#eee}</style><g class="root">` +
      `<g class="clusters">${clusters}</g><g class="edges edgePaths">${edgeSvg}</g><g class="nodes">${nodeSvg}</g></g></svg>`
    );
  };
  const api = {
    initialize: () => {},
    render: (id: string, text: string, container: HTMLElement) =>
      new Promise<{ svg: string; diagramType: string }>((resolve, reject) => {
        state.renders++;
        state.containers.push(container);
        const go = () => {
          state.measuredConnected.push(container.isConnected);
          if (/bad/.test(text)) reject(new Error(`Parse error: ${text}`));
          else resolve({ svg: svgOf(id, text), diagramType: "flowchart-v2" });
        };
        if (state.auto) go();
        else state.pending.push(go);
      }),
  };
  return { state, api };
});
vi.mock("mermaid", () => ({ default: fake.api }));

import {
  initConfig,
  LABEL_DEFAULTS,
  MERMAID_ID_ATTR,
  Mermaid,
  type MermaidHit,
  recoverId,
  tameStyles,
  withConfig,
} from "./mermaid";

let dispose: (() => void) | undefined;
beforeEach(() => {
  fake.state.auto = true;
  fake.state.pending = [];
  fake.state.containers = [];
  fake.state.measuredConnected = [];
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  resetControlSurface();
});

function mount(el: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(el as never, host);
  return host;
}
/** Let the render promise chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await tick();
};
const el = (host: HTMLElement, id: string): Element =>
  host.querySelector(`[${MERMAID_ID_ATTR}="${id}"]`) as Element;

describe("withConfig", () => {
  it("leaves the text alone without config", () => {
    expect(withConfig("flowchart LR\n A --> B", undefined)).toBe("flowchart LR\n A --> B");
    expect(withConfig("flowchart LR\n A --> B", {})).toBe("flowchart LR\n A --> B");
  });
  it("prepends the config as frontmatter, JSON as YAML", () => {
    expect(withConfig("flowchart LR\n A --> B", { layout: "elk" })).toBe(
      '---\nconfig: {"layout":"elk"}\n---\nflowchart LR\n A --> B',
    );
  });
  it("does not touch a text that brings its own frontmatter", () => {
    const own = "---\ntitle: x\n---\nflowchart LR\n A --> B";
    expect(withConfig(own, { layout: "elk" })).toBe(own);
  });
});

describe("initConfig", () => {
  it("lays the label default under the site's flowchart settings, never over them", () => {
    expect(initConfig({}).flowchart).toEqual({ wrappingWidth: LABEL_DEFAULTS.wrappingWidth });
    expect(initConfig({ flowchart: { curve: "basis" } }).flowchart).toEqual({
      wrappingWidth: LABEL_DEFAULTS.wrappingWidth,
      curve: "basis",
    });
    expect(initConfig({ flowchart: { wrappingWidth: 120 } }).flowchart?.wrappingWidth).toBe(120);
    const c = initConfig({ theme: "base" });
    expect(c.theme).toBe("base");
    expect(c.securityLevel).toBe("strict");
    expect(c.suppressErrorRendering).toBe(true);
  });
});

describe("recoverId", () => {
  const g = (id: string, dataId?: string): Element => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", "g");
    e.id = id;
    if (dataId !== undefined) e.setAttribute("data-id", dataId);
    return e;
  };
  it("strips the svg id, the diagram word and the counter from a node", () => {
    expect(recoverId(g("p1-flowchart-A-0"), "p1", "node")).toBe("A");
    expect(recoverId(g("p1-flowchart-a-b-3"), "p1", "node")).toBe("a-b");
    expect(recoverId(g("p1-flowchart-step-2-4"), "p1", "node")).toBe("step-2");
    expect(recoverId(g("p1-state-Idle-1"), "p1", "node")).toBe("Idle");
    expect(recoverId(g("p1-classId-Animal-0"), "p1", "node")).toBe("Animal");
  });
  it("takes a cluster's id whole, and a data-id over anything", () => {
    expect(recoverId(g("p1-S"), "p1", "cluster")).toBe("S");
    expect(recoverId(g("p1-sub-a-1"), "p1", "cluster")).toBe("sub-a-1");
    expect(recoverId(g("p1-state-Running-3", "Running"), "p1", "cluster")).toBe("Running");
  });
  it("answers nothing for an element outside this svg", () => {
    expect(recoverId(g("other-flowchart-A-0"), "p1", "node")).toBeUndefined();
    expect(recoverId(g(""), "p1", "node")).toBeUndefined();
  });
});

describe("tameStyles", () => {
  it("wraps the svg id in :where() in every selector, and only the id", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "p1";
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent =
      "#p1{font-family:x;}#p1 .node rect,#p1 .node circle{fill:#eee;}#p10 .x{fill:#p1;}#p1 .hot>*{fill:red!important;}";
    svg.append(style);
    tameStyles(svg);
    expect(style.textContent).toBe(
      "@layer aiui-vendor{:where(#p1){font-family:x;}:where(#p1) .node rect,:where(#p1) .node circle{fill:#eee;}#p10 .x{fill:#p1;}:where(#p1) .hot>*{fill:red!important;}}",
    );
  });
});

describe("<Mermaid>", () => {
  it("renders, stamps the source and every addressable element, lays hit areas under edges", async () => {
    const text = "flowchart LR\n  A[Start] --> B\n  B --> C\n  subgraph S\n    C --> D\n  end";
    const host = mount(() => <Mermaid text={text} />);
    await settle();
    const root = host.querySelector(".aiui-mmd") as HTMLElement;
    expect(root.getAttribute("data-mermaid")).toBe(text);
    expect(host.querySelector("svg > style")?.textContent).toMatch(
      /^@layer aiui-vendor\{:where\(#aiui-mmd-\d+\) /,
    );
    const ids = Array.from(host.querySelectorAll(`[${MERMAID_ID_ATTR}]`)).map((e) => [
      e.getAttribute("data-aiui-kind"),
      e.getAttribute(MERMAID_ID_ATTR),
      e.getAttribute("class")?.includes("aiui-mmd-hit") ? "hit" : "",
    ]);
    expect(ids).toEqual([
      ["cluster", "S", ""],
      ["edge", "L_A_B_0", ""],
      ["edge", "L_A_B_0", "hit"],
      ["edge", "L_B_C_0", ""],
      ["edge", "L_B_C_0", "hit"],
      ["edge", "L_C_D_0", ""],
      ["edge", "L_C_D_0", "hit"],
      ["node", "A", ""],
      ["node", "B", ""],
      ["node", "C", ""],
      ["node", "D", ""],
    ]);
    expect(host.querySelector(".aiui-mmd-hit")?.getAttribute("stroke-width")).toBe("12");
  });

  it("resolves a click on a label, an edge's hit area, or a cluster to its id", async () => {
    const hits: MermaidHit[] = [];
    const host = mount(() => (
      <Mermaid
        text={"flowchart LR\n  A --> B\n  subgraph S\n    B --> C\n  end"}
        onClick={(h) => hits.push(h)}
      />
    ));
    await settle();
    el(host, "B")
      .querySelector("p")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    host.querySelector(".aiui-mmd-hit")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el(host, "S")
      .querySelector("rect")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(hits.map((h) => [h.kind, h.id])).toEqual([
      ["node", "B"],
      ["edge", "L_A_B_0"],
      ["cluster", "S"],
    ]);
    // The edge hit resolves to the edge path itself, not the clone.
    expect(hits[1]?.el.getAttribute("data-edge")).toBe("true");
    // Clickable: the root says so, nodes and clusters are focusable buttons,
    // and Enter / Space on one is its click. Edges stay as they are.
    expect(host.querySelector(".aiui-mmd")?.classList.contains("aiui-mmd-clickable")).toBe(true);
    expect(el(host, "A").getAttribute("tabindex")).toBe("0");
    expect(el(host, "A").getAttribute("role")).toBe("button");
    expect(el(host, "S").getAttribute("role")).toBe("button");
    expect(el(host, "L_A_B_0").hasAttribute("tabindex")).toBe(false);
    el(host, "A").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    el(host, "C").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    el(host, "C").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(hits.slice(3).map((h) => [h.kind, h.id])).toEqual([
      ["node", "A"],
      ["node", "C"],
    ]);
  });

  it("without onClick nothing is focusable and the root is not clickable", async () => {
    const host = mount(() => <Mermaid text={"flowchart LR\n  A --> B"} />);
    await settle();
    expect(host.querySelector(".aiui-mmd")?.classList.contains("aiui-mmd-clickable")).toBe(false);
    expect(el(host, "A").hasAttribute("tabindex")).toBe(false);
    expect(el(host, "A").hasAttribute("role")).toBe(false);
  });

  it("applies and clears marks in place — the svg is not re-rendered", async () => {
    const [marks, setMarks] = createSignal<
      Record<string, { color?: string; fill?: string; active?: boolean; class?: string }>
    >({});
    const host = mount(() => <Mermaid text={"flowchart LR\n  A --> B"} marks={marks()} />);
    await settle();
    const svg = host.querySelector("svg");
    const a = el(host, "A");
    const edge = el(host, "L_A_B_0") as HTMLElement;
    const before = fake.state.renders;
    setMarks({
      A: { color: "red", fill: "blue", active: true, class: "hot x" },
      L_A_B_0: { color: "green" },
    });
    await tick();
    expect(host.querySelector("svg")).toBe(svg);
    expect(fake.state.renders).toBe(before);
    expect(a.getAttribute("data-active")).toBe("true");
    expect(a.classList.contains("hot") && a.classList.contains("x")).toBe(true);
    const rect = a.querySelector("rect") as HTMLElement;
    expect(rect.style.stroke).toBe("red");
    expect(rect.style.fill).toBe("blue");
    expect(edge.style.stroke).toBe("green");
    expect(edge.style.strokeDasharray).toBe("0 0 5 4"); // Mermaid's own inline style kept
    setMarks({});
    await tick();
    expect(a.getAttribute("data-active")).toBeNull();
    expect(a.classList.contains("hot")).toBe(false);
    expect(rect.style.stroke).toBe("");
    expect(edge.style.stroke).toBe("");
    expect(edge.style.strokeDasharray).toBe("0 0 5 4");
  });

  it("re-renders on a text change and keeps marks by id", async () => {
    const [text, setText] = createSignal("flowchart LR\n  A --> B");
    const host = mount(() => <Mermaid text={text()} marks={{ B: { active: true } }} />);
    await settle();
    const first = host.querySelector("svg");
    setText("flowchart LR\n  A --> B\n  B --> C");
    await settle();
    expect(host.querySelector("svg")).not.toBe(first);
    expect(el(host, "C")).toBeTruthy();
    expect(el(host, "B").getAttribute("data-active")).toBe("true");
  });

  it("latest wins: a result for a superseded text is dropped", async () => {
    const [text, setText] = createSignal("flowchart LR\n  A --> B");
    const host = mount(() => <Mermaid text={text()} />);
    await settle();
    fake.state.auto = false;
    setText("flowchart LR\n  A --> X");
    await tick();
    setText("flowchart LR\n  A --> Y");
    await tick();
    expect(fake.state.pending).toHaveLength(2);
    // Resolve the newer first, then the stale one: the stale must not replace it.
    fake.state.pending[1]?.();
    await settle();
    expect(el(host, "Y")).toBeTruthy();
    fake.state.pending[0]?.();
    await settle();
    expect(el(host, "Y")).toBeTruthy();
    expect(host.querySelector(`[${MERMAID_ID_ATTR}="X"]`)).toBeNull();
  });

  it("does not submit a render after disposal while loading Mermaid", async () => {
    const before = fake.state.renders;
    mount(() => <Mermaid text="flowchart LR\n A --> B" />);
    dispose?.();
    dispose = undefined;
    await settle();
    expect(fake.state.renders).toBe(before);
    expect(document.querySelector(".aiui-mmd-stage")).toBeNull();
  });

  it("keeps an in-flight stage connected with its typography and width until it settles", async () => {
    fake.state.auto = false;
    const onRender = vi.fn();
    const styles = document.createElement("style");
    styles.textContent =
      ".aiui-mmd-stage { font-family: Georgia; font-size: 19px; line-height: 27px; letter-spacing: 2px; }";
    document.body.append(styles);
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 390,
      bottom: 0,
      width: 390,
      height: 0,
      toJSON: () => ({}),
    });
    const host = mount(() => <Mermaid text="flowchart LR\n A --> B" onRender={onRender} />);
    await settle();
    bounds.mockRestore();
    const stage = fake.state.containers[0] as HTMLElement;
    expect(host.contains(stage)).toBe(true);
    // Both cleanup orders occur in hosts: retain the captured layout even if
    // the page was detached before the component owner is disposed.
    host.remove();
    dispose?.();
    dispose = undefined;
    expect(stage.isConnected).toBe(true);
    expect(stage.style.width).toBe("390px");
    expect(stage.style.fontFamily).toBe("Georgia");
    expect(stage.style.fontSize).toBe("19px");
    expect(stage.style.lineHeight).toBe("27px");
    expect(stage.style.letterSpacing).toBe("2px");
    expect(stage.style.visibility).toBe("hidden");
    fake.state.pending[0]?.();
    await settle();
    expect(fake.state.measuredConnected).toEqual([true]);
    expect(onRender).not.toHaveBeenCalled();
    expect(document.querySelector(".aiui-mmd-stage")).toBeNull();
  });

  it("cleans up every disposed stage on success or rejection without publishing stale results", async () => {
    fake.state.auto = false;
    const onRender = vi.fn();
    const [text, setText] = createSignal("flowchart LR\n A --> B");
    const host = mount(() => <Mermaid text={text()} onRender={onRender} />);
    await settle();
    setText("flowchart LR\n A --> bad");
    await settle();
    expect(fake.state.containers).toHaveLength(2);
    dispose?.();
    dispose = undefined;
    host.remove();
    expect(fake.state.containers.every((stage) => stage.isConnected)).toBe(true);
    fake.state.pending[0]?.();
    await settle();
    expect(document.querySelectorAll(".aiui-mmd-stage")).toHaveLength(1);
    fake.state.pending[1]?.();
    await settle();
    expect(fake.state.measuredConnected).toEqual([true, true]);
    expect(onRender).not.toHaveBeenCalled();
    expect(document.querySelector(".aiui-mmd-stage")).toBeNull();
    expect(document.querySelector(".aiui-mmd-error")).toBeNull();
  });

  it("shows a parse error and keeps the last good drawing", async () => {
    const [text, setText] = createSignal("flowchart LR\n  A --> B");
    const host = mount(() => <Mermaid text={text()} />);
    await settle();
    setText("flowchart LR\n  A --> bad");
    await settle();
    expect(host.querySelector(".aiui-mmd-error")?.textContent).toContain("Parse error");
    expect(el(host, "B")).toBeTruthy();
    setText("flowchart LR\n  A --> C");
    await settle();
    expect(host.querySelector(".aiui-mmd-error")).toBeNull();
    expect(el(host, "C")).toBeTruthy();
  });

  it("renders a note for a marked element and a knob's aria state for a control", async () => {
    const epochs = control({ name: "epochs", value: 5, min: 1, max: 20, step: 1 });
    const host = mount(() => (
      <Mermaid
        text={"flowchart LR\n  A --> B"}
        marks={{ A: { note: <i class="n">hi</i>, place: "right" }, B: { control: epochs } }}
      />
    ));
    await settle();
    const note = host.querySelector(".aiui-note") as HTMLElement;
    expect(note.getAttribute("data-for")).toBe("A");
    expect(note.classList.contains("aiui-note-right")).toBe(true);
    expect(note.closest(".aiui-notes-overlay")).not.toBeNull(); // the shared layer, overlaid
    expect(note.querySelector("i.n")?.textContent).toBe("hi");
    const b = el(host, "B");
    expect(b.classList.contains("aiui-knob")).toBe(true);
    expect(b.getAttribute("data-control")).toBe("epochs");
    expect(b.getAttribute("role")).toBe("slider");
    expect(b.getAttribute("aria-valuenow")).toBe("5");
    b.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    expect(epochs.get()).toBe(6);
    expect(b.getAttribute("aria-valuenow")).toBe("6");
    // The knob has the readout every knob has: hover shows the value and the name.
    const PE = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    expect(host.querySelector(".aiui-knob-readout")).toBeNull();
    b.querySelector("p")?.dispatchEvent(new PE("pointerover", { bubbles: true }));
    await tick();
    expect(host.querySelector(".aiui-knob-readout")?.textContent).toBe("6epochs");
  });
});
