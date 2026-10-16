/**
 * mermaid.tsx — a Mermaid diagram as a CONTROL SURFACE: rendered from a
 * string, every node, edge and subgraph addressable afterwards — clicked,
 * hovered, decorated, annotated, dragged as a knob — reactively, while the
 * diagram stays one Mermaid render.
 *
 * ```tsx
 * <Mermaid
 *   text={pipelineText(stages())}
 *   marks={{
 *     train: { active: selected() === "train", note: <Rows of="train" />, control: epochs },
 *     L_feat_train_0: { color: hue("feat") },
 *   }}
 *   onClick={(hit) => hit.kind === "node" && select(hit.id)}
 * />
 * ```
 *
 * **Why this is simpler than RichTeX.** TeX has no identity, so `RichTeX`
 * injects markers at assembly to get one. Mermaid's syntax IS identity:
 * `A[Start]` names the node `A`, `A e1@--> B` names the edge `e1` (unnamed
 * edges are `L_A_B_0` — source, target, ordinal), `subgraph S` names the
 * cluster. Mermaid writes those ids into the SVG it returns: a node is
 * `<g class="node" id="<svgId>-flowchart-A-0">` (`state-…`, `classId-…`,
 * `entity-…` for the other unified-layout diagrams), an edge is
 * `<path data-edge data-id="L_A_B_0" data-points="…">`, an edge label is
 * `<g class="label" data-id="L_A_B_0">`, a subgraph is
 * `<g class="cluster" id="<svgId>-S">`; sequence diagrams carry `data-id`
 * on participants, messages and notes. So the map from the author's ids to
 * elements is RECOVERED from the markup ({@link recoverId}) — no marker
 * injection, no second parse — and every decoration keys on the ids the
 * author already wrote.
 *
 * **Two reactive levels, like RichTeX.** A change to `text` re-renders:
 * Mermaid's `render` is async (parse + layout + text measurement; ~30 ms for
 * a handful of nodes, ~150 ms for forty, ~700 ms for 120 — the layout is the
 * cost and it cannot be skipped), serialized inside Mermaid, and here
 * latest-wins: a result that arrives after a newer render was requested is
 * dropped, and the previous SVG stays on screen until the new one is ready
 * (no flash). A change to a mark touches only that element's attributes and
 * inline style — the SVG stays put, CSS transitions run. Mermaid's own
 * `style`/`classDef` directives are the WRONG lever for state: they live in
 * the text (a full re-render per change) and land as `!important` rules
 * that fight every stylesheet. Keep the text structural; decorate here.
 *
 * **Rendering facts this component is built on** (Mermaid 12.2, measured):
 *  - `render(id, text, container)` must get a FRESH id each time: Mermaid
 *    first removes any element with that id from the document — reuse the
 *    id and the diagram on screen vanishes while the new one is laid out.
 *  - The `container` argument is where Mermaid's temporary render div goes,
 *    and where labels are measured: pass an element INSIDE the host so the
 *    measurement sees the host's font (`fontFamily: "inherit"` then works;
 *    measured in the body, labels overflow their boxes).
 *  - On a parse error `render` rejects with the message; with
 *    `suppressErrorRendering` nothing is left in the document. The message
 *    is shown here, the last good SVG stays.
 *  - Labels are HTML (`foreignObject`), sanitized by DOMPurify under the
 *    default `securityLevel: "strict"`: `<span class data-*>` survive, event
 *    handlers and scripts do not — the analog of KaTeX's `\htmlData`, should
 *    a label ever need a hook of its own.
 *  - An edge is a 1 px stroke: a transparent 12 px clone (`pointer-events:
 *    stroke`) is laid under each so it can be clicked.
 *  - Mermaid's stylesheet is id-scoped (`#svgId .node rect {…}`), which
 *    would beat any class rule a page writes: the id is wrapped in
 *    `:where()` after each render ({@link tameStyles}), so a consumer's
 *    skin applies with ordinary selectors. The palette still goes in
 *    through `config` (the base theme + `themeVariables` from the design
 *    tokens; `look: "classic"` for flat shapes) — Mermaid also reads it for
 *    arrowheads and label backgrounds, which no stylesheet reaches.
 *
 * **Configuration.** {@link configureMermaid} sets the site-wide defaults
 * (theme, font, layout) once; `config` on a diagram is injected as YAML
 * frontmatter (`---\nconfig: {…}\n---`), Mermaid's per-diagram mechanism
 * — a text that brings its own frontmatter is left alone.
 *
 * **The agent surface.** The root carries `data-mermaid` with the source
 * text — the diagram as the author wrote it, which is also the best thing
 * an agent can read. Every addressable element carries `data-aiui-id` and
 * `data-aiui-kind` (`node` | `edge` | `cluster`), so a selection or a
 * `locate` inside the diagram resolves to an id. A knob's element carries
 * `data-control` like every control widget.
 *
 * `mermaid` is an optional peer loaded on first use (`import("mermaid")`),
 * kept off the `/site` barrel so only `/site/mermaid` consumers pay for it.
 */
import type { JSX } from "@solidjs/web";
import type { MermaidConfig } from "mermaid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ControlBox } from "../control";
import { withUnit } from "../control-widgets";

export type MermaidKind = "node" | "edge" | "cluster";

/** The attributes every addressable element carries after a render. */
export const MERMAID_ID_ATTR = "data-aiui-id";
export const MERMAID_KIND_ATTR = "data-aiui-kind";

/** What a pointer landed on. */
export interface MermaidHit {
  kind: MermaidKind;
  id: string;
  el: Element;
}

/** A decoration keyed on a node, edge or cluster id. Every field reactive. */
export interface MermaidMark {
  /** Stroke of a node's shape, or of an edge. Inline, so it beats Mermaid's
   * id-scoped theme rules. (An arrowhead keeps the theme's color — markers
   * are shared per diagram.) */
  color?: string;
  /** Fill of a node's shape or a cluster. Inline. */
  fill?: string;
  /** Extra class(es) on the element, after Mermaid's own. */
  class?: string;
  /** Marks the element `data-active="true"` (a linked highlight). */
  active?: boolean;
  /** Annotation JSX, in a layer over the diagram, anchored to the element. */
  note?: JSX.Element;
  /** Which side of the element the note sits on. Default `below`. */
  place?: "below" | "above" | "left" | "right";
  /** Makes the element a KNOB: drag horizontally to scrub this numeric
   * control (the same gesture as a RichTeX term's `control`); arrow keys
   * when focused. Bounds and snapping are the control's own. */
  control?: ControlBox<number>;
  /** Pixels of horizontal drag that cross the knob's declared range. Default 240. */
  span?: number;
}

export interface MermaidProps {
  /** The diagram source. A change re-renders (async, latest-wins). */
  text: string;
  /** Per-diagram config, injected as frontmatter (see the module doc). */
  config?: MermaidConfig;
  /** Decorations by id. */
  marks?: Readonly<Record<string, MermaidMark>>;
  /** A click on a node, edge (its line, hit area or label) or cluster. */
  onClick?: (hit: MermaidHit, event: MouseEvent) => void;
  /** The pointer entered an addressable element (`undefined` on leave). */
  onHover?: (hit: MermaidHit | undefined) => void;
  /** Extra class(es) on the root, after `aiui-mmd`. */
  class?: string;
  /** Width of the invisible stroke laid under each edge. Default 12. */
  hitWidth?: number;
  /** After each successful render: what became addressable, and the cost. */
  onRender?: (info: MermaidRenderInfo) => void;
}

export interface MermaidRenderInfo {
  /** Every addressable element, in document order. */
  ids: readonly { kind: MermaidKind; id: string }[];
  /** Mermaid's render (parse + layout + measure), in ms. */
  ms: number;
  svg: SVGSVGElement;
}

// ── mermaid, loaded once ─────────────────────────────────────────────────────

type MermaidApi = typeof import("mermaid").default;

/** Defaults the first `initialize` carries; `configureMermaid` replaces them. */
let siteConfig: MermaidConfig = {};
let loaded: Promise<MermaidApi> | undefined;
let renderCount = 0;

const BASE: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
};

/**
 * Site-wide Mermaid defaults — theme, fonts, layout, look — applied at load
 * (or at once, if Mermaid is already loaded). A diagram's own `config`
 * frontmatter layers on top per render. Call it once, where the design
 * system's tokens are known (the host app, not this package).
 */
export function configureMermaid(config: MermaidConfig): void {
  siteConfig = config;
  if (loaded !== undefined) void loaded.then((m) => m.initialize({ ...BASE, ...siteConfig }));
}

function loadMermaid(): Promise<MermaidApi> {
  loaded ??= import("mermaid").then((mod) => {
    mod.default.initialize({ ...BASE, ...siteConfig });
    return mod.default;
  });
  return loaded;
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

/**
 * The source Mermaid gets: `config` as YAML frontmatter (JSON is YAML, so
 * the object is embedded verbatim). A text that already opens with
 * frontmatter is the author's business and goes through untouched.
 */
export function withConfig(text: string, config: MermaidConfig | undefined): string {
  if (config === undefined || Object.keys(config).length === 0) return text;
  if (/^\s*---\s*\n/.test(text)) return text;
  return `---\nconfig: ${JSON.stringify(config)}\n---\n${text}`;
}

/**
 * The author's id behind a rendered element, from the markup Mermaid wrote:
 * a `data-id` when there is one (edges, edge labels, state clusters,
 * sequence parts); else the element id with the svg id stripped — a node is
 * `<svgId>-<diagram>-<id>-<n>` (the diagram word has no dash; `<id>` may),
 * a cluster is `<svgId>-<id>`. `undefined` for anything else.
 */
export function recoverId(el: Element, svgId: string, kind: MermaidKind): string | undefined {
  const dataId = el.getAttribute("data-id");
  if (dataId !== null && dataId !== "") return dataId;
  const id = el.id;
  if (id === "" || !id.startsWith(`${svgId}-`)) return undefined;
  const rest = id.slice(svgId.length + 1);
  if (kind === "cluster") return rest;
  const m = /^[A-Za-z]+-(.+)-\d+$/.exec(rest);
  return m === null ? rest : m[1];
}

/**
 * Mermaid scopes its stylesheet by the svg's id — `#p1 .node rect {…}` —
 * which outranks any class rule a page writes. Wrapping the id in
 * `:where()` keeps the scoping and drops its specificity to zero, so the
 * consumer's ordinary skin (`.my-diagram .node rect`) wins without
 * `!important`. Mermaid's own `!important` rules (a `classDef` in the text)
 * are left as they are — the text's directives are not the lever here.
 */
export function tameStyles(svg: SVGSVGElement): void {
  const style = svg.querySelector(":scope > style");
  if (style === null || svg.id === "") return;
  const id = svg.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only where a selector starts (the sheet's start, after `}` or `,`) and
  // the id is whole — never inside a declaration value.
  style.textContent = (style.textContent ?? "").replace(
    new RegExp(`(?<=^|[},])#${id}(?=[\\s.>:,{[])`, "g"),
    `:where(#${svg.id})`,
  );
}

/** An element's box in CSS px relative to the diagram root's top-left. */
export interface MermaidBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function formatKnob(value: number, meta: ControlBox<number>["meta"]): string {
  const step = meta.step;
  const shown =
    step !== undefined && step > 0 && step < 1
      ? value.toFixed(Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)))))
      : String(value);
  return withUnit(shown, meta.unit);
}
function perPxOf(control: ControlBox<number>, span: number | undefined): number {
  const { min, max, step } = control.meta;
  const px = span ?? 240;
  if (min !== undefined && max !== undefined && max > min) return (max - min) / px;
  return step ?? 1;
}
function keyStepOf(control: ControlBox<number>): number {
  const { min, max, step } = control.meta;
  if (step !== undefined && step > 0) return step;
  if (min !== undefined && max !== undefined && max > min) return (max - min) / 100;
  return 1;
}
const leafName = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

// ── structural CSS (positions only; the look is the consumer's) ─────────────

export const MERMAID_STYLES = `
.aiui-mmd { position: relative; }
.aiui-mmd-svg > svg { display: block; }
.aiui-mmd-stage { position: absolute; left: 0; top: 0; width: 100%; visibility: hidden; pointer-events: none; }
.aiui-mmd-hit { fill: none; stroke: transparent; pointer-events: stroke; }
.aiui-mmd [${MERMAID_ID_ATTR}] { cursor: default; }
.aiui-mmd [data-control] { cursor: ew-resize; touch-action: none; outline: none; }
.aiui-mmd-notes { position: absolute; inset: 0; pointer-events: none; }
.aiui-mmd-note { position: absolute; pointer-events: auto; }
.aiui-mmd-note-below { transform: translate(-50%, var(--aiui-mmd-gap, 6px)); }
.aiui-mmd-note-above { transform: translate(-50%, calc(-100% - var(--aiui-mmd-gap, 6px))); }
.aiui-mmd-note-right { transform: translate(var(--aiui-mmd-gap, 6px), -50%); }
.aiui-mmd-note-left { transform: translate(calc(-100% - var(--aiui-mmd-gap, 6px)), -50%); }
.aiui-mmd-error { color: #cc0000; font-family: ui-monospace, monospace; font-size: 0.8em; white-space: pre-wrap; margin: 0; }
`;

const STYLE_MARK = "data-aiui-mermaid";
function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.head.querySelector(`style[${STYLE_MARK}]`)) return;
  const el = document.createElement("style");
  el.setAttribute(STYLE_MARK, "");
  el.textContent = MERMAID_STYLES;
  document.head.append(el);
}

// ── the component ────────────────────────────────────────────────────────────

interface Indexed {
  kind: MermaidKind;
  el: Element;
  /** The element that takes the mark's color/fill (a node's shape, the
   * edge path, a cluster's rect). */
  paint: Element[];
}

const SHAPE = ":scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path";

export function Mermaid(props: MermaidProps): JSX.Element {
  ensureStyles();
  const source = createMemo(() => withConfig(props.text, props.config));
  const [error, setError] = createSignal<string | undefined>();
  const [boxes, setBoxes] = createSignal<ReadonlyMap<string, MermaidBox>>(new Map());

  let root!: HTMLElement;
  let host!: HTMLElement;
  let stage!: HTMLElement;
  // id → element, for the CURRENT svg; rebuilt on every swap.
  let index = new Map<string, Indexed>();
  let marksNow: Readonly<Record<string, MermaidMark>> = {};
  let valuesNow: ReadonlyMap<string, number> = new Map();
  // A fresh id per render (see the module doc); the newest request wins.
  let seq = 0;

  // ── geometry ──────────────────────────────────────────────────────────────
  const measure = (): void => {
    if (root === undefined || !root.isConnected) return;
    const r = root.getBoundingClientRect();
    const next = new Map<string, MermaidBox>();
    for (const [id, { el }] of index) {
      const b = el.getBoundingClientRect();
      next.set(id, { left: b.left - r.left, top: b.top - r.top, width: b.width, height: b.height });
    }
    setBoxes(next);
  };
  let raf: number | undefined;
  const scheduleMeasure = (): void => {
    if (typeof requestAnimationFrame !== "function") return;
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = undefined;
      measure();
    });
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleMeasure) : undefined;
  if (typeof document !== "undefined" && "fonts" in document) {
    document.fonts.ready.then(scheduleMeasure, () => {});
  }

  // ── hits ──────────────────────────────────────────────────────────────────
  const hitOf = (target: Element | null): MermaidHit | undefined => {
    const el = target?.closest(`[${MERMAID_ID_ATTR}]`);
    if (!el || !host.contains(el)) return undefined;
    const id = el.getAttribute(MERMAID_ID_ATTR);
    const kind = el.getAttribute(MERMAID_KIND_ATTR) as MermaidKind | null;
    if (id === null || kind === null) return undefined;
    return { kind, id, el: index.get(id)?.el ?? el };
  };

  let hovered: MermaidHit | undefined;
  const syncHover = (hit: MermaidHit | undefined): void => {
    if (hovered?.id === hit?.id && hovered?.kind === hit?.kind) return;
    hovered?.el.removeAttribute("data-hover");
    hovered = hit;
    hit?.el.setAttribute("data-hover", "true");
    props.onHover?.(hit);
  };
  const onPointerOver = (e: PointerEvent): void => syncHover(hitOf(e.target as Element | null));
  const onPointerLeave = (): void => syncHover(undefined);
  const onClick = (e: MouseEvent): void => {
    const hit = hitOf(e.target as Element | null);
    if (hit !== undefined) props.onClick?.(hit, e);
  };

  // ── knobs: drag to scrub, arrows when focused ─────────────────────────────
  interface Scrub {
    id: string;
    control: ControlBox<number>;
    startX: number;
    startV: number;
    perPx: number;
  }
  let scrub: Scrub | undefined;
  const knobOf = (id: string | undefined): MermaidMark | undefined =>
    id === undefined ? undefined : marksNow[id]?.control === undefined ? undefined : marksNow[id];
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const hit = hitOf(e.target as Element | null);
    const knob = knobOf(hit?.id);
    if (hit === undefined || knob?.control === undefined) return;
    scrub = {
      id: hit.id,
      control: knob.control,
      startX: e.clientX,
      startV: knob.control.get(),
      perPx: perPxOf(knob.control, knob.span),
    };
    try {
      host.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic pointer — no capture */
    }
    e.preventDefault();
    hit.el.setAttribute("data-scrubbing", "true");
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (scrub === undefined) return;
    scrub.control.set((scrub.startV + (e.clientX - scrub.startX) * scrub.perPx) as never);
  };
  const endScrub = (): void => {
    if (scrub === undefined) return;
    index.get(scrub.id)?.el.removeAttribute("data-scrubbing");
    scrub = undefined;
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const hit = hitOf(e.target as Element | null);
    const control = knobOf(hit?.id)?.control;
    if (control === undefined) return;
    const unit = keyStepOf(control) * (e.shiftKey ? 10 : 1);
    const v = control.get();
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = v + unit;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = v - unit;
    else if (e.key === "Home") next = control.meta.min;
    else if (e.key === "End") next = control.meta.max;
    if (next === undefined) return;
    e.preventDefault();
    control.set(next as never);
  };

  // Delegated to the host: the SVG is replaced on every render, the host
  // is not. Attached where the host is adopted (the render effect below —
  // refs bind during render, handlers run after it).
  let adopted = false;
  const adopt = (): void => {
    if (adopted) return;
    adopted = true;
    ro?.observe(root);
    host.addEventListener("pointerover", onPointerOver);
    host.addEventListener("pointerleave", onPointerLeave);
    host.addEventListener("click", onClick);
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", endScrub);
    host.addEventListener("pointercancel", endScrub);
    host.addEventListener("keydown", onKeyDown);
  };
  onCleanup(() => {
    seq++; // any render in flight is now stale
    ro?.disconnect();
    if (raf !== undefined) cancelAnimationFrame(raf);
    if (!adopted) return;
    host.removeEventListener("pointerover", onPointerOver);
    host.removeEventListener("pointerleave", onPointerLeave);
    host.removeEventListener("click", onClick);
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", endScrub);
    host.removeEventListener("pointercancel", endScrub);
    host.removeEventListener("keydown", onKeyDown);
  });

  // ── the index: ids → elements, stamped; hit areas under the edges ─────────
  const stamp = (el: Element, kind: MermaidKind, id: string, paint: Element[]): void => {
    el.setAttribute(MERMAID_ID_ATTR, id);
    el.setAttribute(MERMAID_KIND_ATTR, kind);
    if (!index.has(id)) index.set(id, { kind, el, paint });
  };
  const buildIndex = (svg: SVGSVGElement): void => {
    index = new Map();
    const svgId = svg.id;
    for (const g of svg.querySelectorAll("g.cluster")) {
      const id = recoverId(g, svgId, "cluster");
      if (id !== undefined)
        stamp(g, "cluster", id, Array.from(g.querySelectorAll(":scope > rect")));
    }
    for (const g of svg.querySelectorAll("g.node")) {
      const id = recoverId(g, svgId, "node");
      if (id !== undefined) stamp(g, "node", id, Array.from(g.querySelectorAll(SHAPE)));
    }
    const width = String(props.hitWidth ?? 12);
    for (const p of svg.querySelectorAll("path[data-edge], path[data-et='edge']")) {
      const id = recoverId(p, svgId, "edge");
      if (id === undefined) continue;
      stamp(p, "edge", id, [p]);
      // The clickable clone: same geometry, no markers, wide transparent stroke.
      const hit = p.cloneNode(false) as SVGPathElement;
      for (const a of Array.from(hit.attributes)) {
        if (a.name !== "d") hit.removeAttribute(a.name);
      }
      hit.setAttribute("class", "aiui-mmd-hit");
      hit.setAttribute("stroke-width", width);
      hit.setAttribute(MERMAID_ID_ATTR, id);
      hit.setAttribute(MERMAID_KIND_ATTR, "edge");
      p.after(hit);
    }
    // An edge's label resolves to the edge (sequence messages carry data-id themselves).
    for (const g of svg.querySelectorAll("g.edgeLabel g.label[data-id]")) {
      const id = g.getAttribute("data-id");
      if (id !== null && index.has(id)) {
        g.setAttribute(MERMAID_ID_ATTR, id);
        g.setAttribute(MERMAID_KIND_ATTR, "edge");
      }
    }
    // Sequence diagrams: participants, messages, notes carry data-id + data-et.
    for (const el of svg.querySelectorAll("[data-et][data-id]")) {
      if (el.hasAttribute(MERMAID_ID_ATTR)) continue;
      const et = el.getAttribute("data-et");
      const id = el.getAttribute("data-id");
      if (id === null || et === null) continue;
      // A life-line belongs to its participant (same data-id): a node hit.
      const kind: MermaidKind = et === "message" ? "edge" : "node";
      stamp(el, kind, id, Array.from(el.querySelectorAll(":scope > rect, :scope > line")));
    }
  };

  // ── marks: attributes + inline style, idempotent ──────────────────────────
  const applied = new Map<string, string[]>();
  /** `values`: each knob's control value, read in the tracking scope that
   * called this (an untracked read here would be flagged, and stale). */
  const applyMarks = (
    marks: Readonly<Record<string, MermaidMark>>,
    values: ReadonlyMap<string, number>,
  ): void => {
    // Clear what the previous pass set on elements no longer marked.
    for (const [id, prev] of applied) {
      if (id in marks) continue;
      const hit = index.get(id);
      if (hit !== undefined) {
        hit.el.classList.remove(...prev);
        hit.el.removeAttribute("data-active");
        // Only what a mark sets: an edge's own inline dash settings stay.
        for (const p of hit.paint) {
          (p as HTMLElement).style.stroke = "";
          (p as HTMLElement).style.fill = "";
        }
        clearKnob(hit.el);
      }
      applied.delete(id);
    }
    for (const [id, mark] of Object.entries(marks)) {
      const hit = index.get(id);
      if (hit === undefined) continue;
      const prev = applied.get(id);
      if (prev !== undefined) hit.el.classList.remove(...prev);
      const next = mark.class === undefined ? [] : mark.class.split(/\s+/).filter((c) => c !== "");
      if (next.length > 0) hit.el.classList.add(...next);
      applied.set(id, next);
      if (mark.active === true) hit.el.setAttribute("data-active", "true");
      else hit.el.removeAttribute("data-active");
      for (const p of hit.paint) {
        const s = (p as HTMLElement).style;
        s.stroke = mark.color ?? "";
        s.fill = hit.kind === "edge" ? "" : (mark.fill ?? "");
      }
      if (mark.control !== undefined) setKnob(hit.el, mark.control, values.get(id));
      else clearKnob(hit.el);
    }
  };
  const setKnob = (el: Element, control: ControlBox<number>, v: number | undefined): void => {
    el.setAttribute("data-control", control.name);
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", control.description ?? leafName(control.name));
    if (control.meta.min !== undefined) el.setAttribute("aria-valuemin", String(control.meta.min));
    if (control.meta.max !== undefined) el.setAttribute("aria-valuemax", String(control.meta.max));
    if (v === undefined) return;
    el.setAttribute("aria-valuenow", String(v));
    el.setAttribute("aria-valuetext", formatKnob(v, control.meta));
  };
  const clearKnob = (el: Element): void => {
    if (!el.hasAttribute("data-control")) return;
    for (const a of [
      "data-control",
      "tabindex",
      "role",
      "aria-label",
      "aria-valuemin",
      "aria-valuemax",
      "aria-valuenow",
      "aria-valuetext",
    ])
      el.removeAttribute(a);
  };

  // ── render: async, latest-wins; the previous svg stays until the next is ready
  const swap = (svg: string): SVGSVGElement | null => {
    host.innerHTML = svg;
    const el = host.querySelector("svg");
    applied.clear();
    if (el !== null) {
      tameStyles(el);
      buildIndex(el);
    } else index = new Map();
    applyMarks(marksNow, valuesNow);
    scheduleMeasure();
    return el;
  };
  createEffect(source, (src) => {
    adopt();
    const mine = ++seq;
    const id = `aiui-mmd-${++renderCount}`;
    const t0 = typeof performance === "undefined" ? Date.now() : performance.now();
    loadMermaid()
      .then((m) => m.render(id, src, stage))
      .then(
        (r) => {
          if (mine !== seq) return;
          const ms = (typeof performance === "undefined" ? Date.now() : performance.now()) - t0;
          setError(undefined);
          const svg = swap(r.svg);
          if (svg !== null && props.onRender !== undefined) {
            const ids = Array.from(index, ([id, { kind }]) => ({ kind, id }));
            props.onRender({ ids, ms, svg });
          }
        },
        (err: unknown) => {
          if (mine !== seq) return;
          setError(err instanceof Error ? err.message : String(err));
        },
      );
  });

  // Marks: one memo both consumers read (a props getter re-evaluates per
  // read, and a note is JSX — built once per change, not once per reader).
  // The object literal's fields were evaluated when it was built, so the
  // memo already tracks them; a knob's control is read here, in the
  // tracking scope, and its value handed to the handler.
  const marks = createMemo(() => props.marks ?? {});
  createEffect(
    () => {
      const m = marks();
      const values = new Map<string, number>();
      for (const [id, mark] of Object.entries(m)) {
        if (mark.control !== undefined) values.set(id, mark.control.get());
      }
      return { m, values };
    },
    ({ m, values }) => {
      marksNow = m;
      valuesNow = values;
      applyMarks(m, values);
    },
  );

  // ── notes ─────────────────────────────────────────────────────────────────
  // One wrapper per mark OBJECT, so a consumer that keeps a mark's reference
  // (the marks of untouched nodes, when only an edge's changed) keeps its
  // note's DOM too: <For> keys on the wrapper.
  interface NoteItem {
    id: string;
    mark: MermaidMark;
  }
  const wrappers = new WeakMap<MermaidMark, NoteItem>();
  let lastNotes: NoteItem[] = [];
  const notes = createMemo(() => {
    const next = Object.entries(marks())
      .filter(([, m]) => "note" in m)
      .map(([id, m]) => {
        let w = wrappers.get(m);
        if (w === undefined || w.id !== id) {
          w = { id, mark: m };
          wrappers.set(m, w);
        }
        return w;
      });
    // The same wrappers in the same order is the same list: hand back the
    // previous array so the memo's own equality holds and <For> stays idle.
    if (next.length === lastNotes.length && next.every((w, i) => w === lastNotes[i])) {
      return lastNotes;
    }
    lastNotes = next;
    return next;
  });
  createEffect(
    () => notes().length,
    () => scheduleMeasure(),
  );
  const anchor = (b: MermaidBox, place: MermaidMark["place"]): { x: number; y: number } => {
    switch (place) {
      case "above":
        return { x: b.left + b.width / 2, y: b.top };
      case "left":
        return { x: b.left, y: b.top + b.height / 2 };
      case "right":
        return { x: b.left + b.width, y: b.top + b.height / 2 };
      default:
        return { x: b.left + b.width / 2, y: b.top + b.height };
    }
  };

  const rootClass = () => (props.class === undefined ? "aiui-mmd" : `aiui-mmd ${props.class}`);

  return (
    <div
      class={rootClass()}
      data-mermaid={props.text}
      ref={(el) => {
        root = el;
      }}
    >
      <Show when={error()}>{(e) => <pre class="aiui-mmd-error">{e()}</pre>}</Show>
      <div
        class="aiui-mmd-svg"
        ref={(el) => {
          host = el;
        }}
      />
      <div
        class="aiui-mmd-stage"
        aria-hidden="true"
        ref={(el) => {
          stage = el;
        }}
      />
      <Show when={notes().length > 0}>
        <div class="aiui-mmd-notes">
          <For each={notes()}>
            {(n) => {
              const box = () => boxes().get(n.id);
              const place = () => n.mark.place ?? "below";
              const at = () => {
                const b = box();
                return b === undefined ? undefined : anchor(b, place());
              };
              return (
                <div
                  class={`aiui-mmd-note aiui-mmd-note-${place()}`}
                  data-for={n.id}
                  data-active={n.mark.active === true ? "true" : undefined}
                  style={{
                    left: `${at()?.x ?? 0}px`,
                    top: `${at()?.y ?? 0}px`,
                    visibility: at() === undefined ? "hidden" : undefined,
                  }}
                >
                  {n.mark.note}
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
