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
 * **Knobs and notes are the shared primitives.** A mark's `control` makes
 * its element a knob — the gesture, the stamps and the ARIA are `knob.tsx`'s
 * (`createKnobs`); this component binds the elements after each render and
 * each marks pass, and resolves a press through its own hit test, so an
 * edge's wide transparent clone scrubs the edge. A mark's `note` goes to
 * `notes.tsx`'s `NoteLayer` in its `overlay` layout: one absolute layer over
 * the diagram, each note beside its element (below, above, left or right),
 * notes on one rank pushed apart when they would overlap.
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
 *  - Mermaid's stylesheet is id-scoped (`#svgId .node rect {…}`) and
 *    unlayered, which would beat any class rule a page writes and any rule
 *    a design system keeps in a cascade layer: after each render the sheet
 *    is wrapped in `@layer aiui-vendor` and the id in `:where()`
 *    ({@link tameStyles}). A page's own unlayered skin then wins by
 *    specificity; a layered skin wins when its stylesheet declares
 *    `aiui-vendor` before its own layers (`@layer aiui-vendor, …;` — what
 *    aiui-design's site.css does). The palette still goes in through
 *    `config` (the base theme + `themeVariables` from the design tokens;
 *    `look: "classic"` for flat shapes) — Mermaid also reads it for
 *    arrowheads and label backgrounds, which no stylesheet reaches.
 *
 * **Configuration.** {@link configureMermaid} sets the site-wide defaults
 * (theme, font, layout) once; `config` on a diagram is injected as YAML
 * frontmatter (`---\nconfig: {…}\n---`), Mermaid's per-diagram mechanism
 * — a text that brings its own frontmatter is left alone. One default is
 * this component's own ({@link LABEL_DEFAULTS}): Mermaid 12.2 ships
 * `flowchart.wrappingWidth: 120`, and a plain label is laid out `nowrap`
 * inside a box of that width — so any label wider than 120 px is CLIPPED,
 * and a shorter one is padded out to 120 px (measured on the lab's
 * `/anatomy`: a 515 px label in a 120 px box, every short node 160 px wide).
 * Raised, a node grows to its text up to that width, a markdown-string
 * label wraps there, and only a plain label longer than it still clips
 * (write it as a markdown string to wrap it). 640 fits some ninety
 * characters at the house 14 px. The site config and a diagram's own
 * `config` both override it.
 *
 * **Keyboard.** With `onClick` given, every node and cluster is focusable
 * (`tabindex`, `role="button"`) and Enter or Space is its click, the path a
 * clickable RichTeX term has; the root carries `aiui-mmd-clickable` so a
 * skin can show the pointer only where a click does something. A knob keeps
 * its slider role and the knob controller's keys.
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
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { ControlBox } from "../control";
import { createKnobs, KnobReadout } from "./knob";
import { NoteLayer, type NoteSide, type NoteSpec } from "./notes";
import { ensureStyles } from "./styles";

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
  place?: NoteSide;
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
  /** A click on a node, edge (its line, hit area or label) or cluster — or
   * Enter / Space on a focused node or cluster (see the module doc). */
  onClick?: (hit: MermaidHit, event: MouseEvent | KeyboardEvent) => void;
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

/** The label box a node grows to before a label wraps or clips — see the
 * module doc for why Mermaid's own 120 is not usable. */
export const LABEL_DEFAULTS = { wrappingWidth: 640 } as const;

/** What `initialize` gets: the component's base, the site's config over it,
 * and the label default under the site's flowchart settings. Pure; exported
 * for tests. */
export function initConfig(site: MermaidConfig): MermaidConfig {
  return { ...BASE, ...site, flowchart: { ...LABEL_DEFAULTS, ...site.flowchart } };
}

/**
 * Site-wide Mermaid defaults — theme, fonts, layout, look — applied at load
 * (or at once, if Mermaid is already loaded). A diagram's own `config`
 * frontmatter layers on top per render. Call it once, where the design
 * system's tokens are known (the host app, not this package; aiui-design's
 * `mermaidTheme()` is the house theme).
 */
export function configureMermaid(config: MermaidConfig): void {
  siteConfig = config;
  if (loaded !== undefined) void loaded.then((m) => m.initialize(initConfig(siteConfig)));
}

function loadMermaid(): Promise<MermaidApi> {
  loaded ??= import("mermaid").then((mod) => {
    mod.default.initialize(initConfig(siteConfig));
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

/** The cascade layer Mermaid's own stylesheet is moved into. */
export const VENDOR_LAYER = "aiui-vendor";

/**
 * Mermaid scopes its stylesheet by the svg's id — `#p1 .node rect {…}` —
 * which outranks any class rule a page writes, and leaves it unlayered,
 * which outranks any rule a design system keeps in a cascade layer. Two
 * rewrites: the id is wrapped in `:where()`, keeping the scoping and
 * dropping its specificity to zero, so a page's ordinary skin
 * (`.my-diagram .node rect`) wins without `!important`; and the whole sheet
 * goes into `@layer aiui-vendor`, so a layered skin wins too once its
 * stylesheet has declared that layer first. Mermaid's own `!important`
 * rules (a `classDef` in the text) are left as they are — the text's
 * directives are not the lever here.
 */
export function tameStyles(svg: SVGSVGElement): void {
  const style = svg.querySelector(":scope > style");
  if (style === null || svg.id === "") return;
  const id = svg.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only where a selector starts (the sheet's start, after `}` or `,`) and
  // the id is whole — never inside a declaration value.
  const scoped = (style.textContent ?? "").replace(
    new RegExp(`(?<=^|[},])#${id}(?=[\\s.>:,{[])`, "g"),
    `:where(#${svg.id})`,
  );
  style.textContent = `@layer ${VENDOR_LAYER}{${scoped}}`;
}

// ── structural CSS (positions only; the look is the consumer's) ─────────────

export const MERMAID_STYLES = `
.aiui-mmd { position: relative; }
.aiui-mmd-svg > svg { display: block; max-width: 100%; height: auto; }
.aiui-mmd-stage { position: absolute; left: 0; top: 0; width: 100%; visibility: hidden; pointer-events: none; }
.aiui-mmd-hit { fill: none; stroke: transparent; pointer-events: stroke; }
.aiui-mmd [${MERMAID_ID_ATTR}] { outline: none; }
.aiui-mmd-error { color: #cc0000; font-family: ui-monospace, monospace; font-size: 0.8em; white-space: pre-wrap; margin: 0; }
`;
const STYLE_MARK = "data-aiui-mermaid";

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
  ensureStyles(STYLE_MARK, MERMAID_STYLES);
  const source = createMemo(() => withConfig(props.text, props.config));
  const [error, setError] = createSignal<string | undefined>();
  // Bumped per swapped-in svg: the notes layer re-measures its anchors.
  const [rendered, setRendered] = createSignal(0);

  let root!: HTMLElement;
  let host!: HTMLElement;
  let stage!: HTMLElement;
  // id → element, for the CURRENT svg; rebuilt on every swap.
  let index = new Map<string, Indexed>();
  let marksNow: Readonly<Record<string, MermaidMark>> = {};
  // A fresh id per render (see the module doc); the newest request wins.
  let seq = 0;

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
  // Enter and Space on a focused node or cluster are its click. A knob's
  // keys are the knob controller's (it answers first, on the same host).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as Element | null;
    if (target === null || target.hasAttribute("data-control")) return;
    const hit = hitOf(target);
    if (hit === undefined || hit.el !== target) return;
    e.preventDefault();
    props.onClick?.(hit, e);
  };
  /** Focusable when the diagram is clickable and the element is not a knob. */
  let clickableNow = false;
  const focusable = (el: Element): void => {
    if (el.hasAttribute("data-control")) return;
    if (clickableNow) {
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "button");
    } else {
      el.removeAttribute("tabindex");
      el.removeAttribute("role");
    }
  };
  const refocusAll = (): void => {
    for (const { el, kind } of index.values()) if (kind !== "edge") focusable(el);
  };

  // The knobs: a press anywhere on an addressable element (a label, an edge's
  // wide clone) resolves to the element the mark decorated.
  const knobs = createKnobs({ resolve: (target) => hitOf(target)?.el });

  // Delegated to the host: the SVG is replaced on every render, the host
  // is not. Attached where the host is adopted (the render effect below —
  // refs bind during render, handlers run after it).
  let adopted = false;
  const adopt = (): void => {
    if (adopted) return;
    adopted = true;
    host.addEventListener("pointerover", onPointerOver);
    host.addEventListener("pointerleave", onPointerLeave);
    host.addEventListener("click", onClick);
    host.addEventListener("keydown", onKeyDown);
    knobs.attach(host);
  };
  onCleanup(() => {
    seq++; // any render in flight is now stale
    if (!adopted) return;
    host.removeEventListener("pointerover", onPointerOver);
    host.removeEventListener("pointerleave", onPointerLeave);
    host.removeEventListener("click", onClick);
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
  const applyMarks = (marks: Readonly<Record<string, MermaidMark>>): void => {
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
        knobs.unbind(hit.el);
        if (hit.kind !== "edge") focusable(hit.el);
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
      if (mark.control !== undefined) {
        knobs.bind(hit.el, { control: mark.control, span: mark.span });
      } else {
        knobs.unbind(hit.el);
        if (hit.kind !== "edge") focusable(hit.el);
      }
    }
  };

  // ── render: async, latest-wins; the previous svg stays until the next is ready
  const swap = (svg: string): SVGSVGElement | null => {
    host.innerHTML = svg;
    const el = host.querySelector("svg");
    applied.clear();
    knobs.clear();
    if (el !== null) {
      tameStyles(el);
      buildIndex(el);
      refocusAll();
    } else index = new Map();
    applyMarks(marksNow);
    setRendered((n) => n + 1);
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
  // memo already tracks them; a knob's value is the knob controller's to
  // follow, so a drag never re-runs this pass.
  const marks = createMemo(() => props.marks ?? {});
  createEffect(marks, (m) => {
    marksNow = m;
    applyMarks(m);
  });
  const clickable = createMemo(() => props.onClick !== undefined);
  createEffect(clickable, (c) => {
    clickableNow = c;
    refocusAll();
  });

  // ── notes ─────────────────────────────────────────────────────────────────
  // One spec per mark OBJECT, so a consumer that keeps a mark's reference
  // (the marks of untouched nodes, when only an edge's changed) keeps its
  // note's DOM too: the layer's <For> keys on the spec.
  const specs = new WeakMap<MermaidMark, NoteSpec>();
  let lastNotes: NoteSpec[] = [];
  const notes = createMemo((): NoteSpec[] => {
    const next = Object.entries(marks())
      .filter(([, m]) => "note" in m)
      .map(([id, m]) => {
        let s = specs.get(m);
        if (s === undefined || s.id !== id) {
          s = {
            id,
            get side() {
              return m.place ?? "below";
            },
            get active() {
              return m.active === true;
            },
            get note() {
              return m.note;
            },
          };
          specs.set(m, s);
        }
        return s;
      });
    // The same specs in the same order is the same list: hand back the
    // previous array so the memo's own equality holds and <For> stays idle.
    if (next.length === lastNotes.length && next.every((s, i) => s === lastNotes[i])) {
      return lastNotes;
    }
    lastNotes = next;
    return next;
  });

  const rootClass = () => {
    const base = clickable() ? "aiui-mmd aiui-mmd-clickable" : "aiui-mmd";
    return props.class === undefined ? base : `${base} ${props.class}`;
  };

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
      <KnobReadout of={knobs} />
      <NoteLayer
        layout="overlay"
        host={() => root}
        anchorOf={(id) => index.get(id)?.el}
        notes={notes()}
        version={rendered()}
      />
    </div>
  );
}
