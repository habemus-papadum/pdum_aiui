/**
 * The component locator: screenshot-rect → components → source.
 *
 * The enclosure strategy in {@link locateComponents} — the highest annotated
 * elements fully inside the rect, a `within` fallback when the drag framed
 * nothing, one level of cell frontier per element, and a naming ladder
 * (`data-cell` → authoring module → tag). The stamps it reads are the ones
 * the source-processor's locator pass emits (`data-source-loc="file:line:col"`
 * relative to the app root, `data-cell="name"`) — the same handles
 * `selection.ts` reads — so this exercises the exact screenshot-rect →
 * components → source path a real app has. The concepts-level write-up is
 * docs/guide/attribution.md. When `window.__AIUI__.sourceRoot` is known the
 * stamp is resolved to an absolute path (what the agent opens); otherwise the
 * relative stamp rides through and the channel resolves it.
 *
 * The capture half that used to live beside this (the ShotTool veil and the
 * one-grant display-capture broker) died with the dev overlay: the intent
 * client's hosts capture natively (CDP screenshots / a warm `tabCapture`
 * stream) and never call `getDisplayMedia` from the page.
 */
import type { LocatedCell, LocatedComponent, Rect } from "@habemus-papadum/aiui-lowering-pipeline";
import { cellSourceLoc } from "./vscode";

/** Border slack for containment tests: a drag rarely lands pixel-perfect. */
const ENCLOSE_TOLERANCE = 2;

/**
 * The locator pass: rect → the components the user *framed*.
 *
 * Earlier versions grid-sampled `elementsFromPoint` and reported every
 * annotated ancestor the rect touched — which put the app shell in every
 * shot's metadata (a rect anywhere intersects it). What the prompt actually
 * needs is a point of reference, not an inventory, so:
 *
 *  1. Keep the **highest annotated elements fully enclosed** by the rect
 *     (±{@link ENCLOSE_TOLERANCE}px): of the enclosed elements, drop any
 *     contained in another — the survivors are what the drag deliberately
 *     framed.
 *  2. If the rect encloses nothing annotated — a drag *inside* one big
 *     component — fall back to the **innermost annotated element containing
 *     the rect**, marked `containment: "within"`; one element, the smallest
 *     answer to "where is this?".
 *  3. For each kept element, surface its **direct-cell frontier**: the topmost
 *     `data-cell` descendants with no other cell between them and the element.
 *     One level deep on purpose — cells mirror the dataflow graph, and the
 *     frontier names are enough for an agent to enter it; enumerating the
 *     whole subtree would bury the reference points it exists to provide.
 */
export function locateComponents(rect: Rect): LocatedComponent[] {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return []; // no DOM (headless/exotic) — shot degrades to rect only
  }
  const sourceRoot = typeof window === "undefined" ? undefined : window.__AIUI__?.sourceRoot;
  const annotated = [...document.querySelectorAll("[data-source-loc], [data-cell]")];

  const enclosed = annotated.filter((el) => {
    const box = el.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left >= rect.x - ENCLOSE_TOLERANCE &&
      box.top >= rect.y - ENCLOSE_TOLERANCE &&
      box.right <= rect.x + rect.w + ENCLOSE_TOLERANCE &&
      box.bottom <= rect.y + rect.h + ENCLOSE_TOLERANCE
    );
  });
  // Highest-first: drop anything another enclosed element already contains.
  let kept = enclosed.filter((el) => !enclosed.some((other) => other !== el && other.contains(el)));
  let containment: LocatedComponent["containment"];

  if (kept.length === 0) {
    // Nothing framed — anchor to the innermost annotated container instead.
    const containing = annotated.filter((el) => {
      const box = el.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.left <= rect.x + ENCLOSE_TOLERANCE &&
        box.top <= rect.y + ENCLOSE_TOLERANCE &&
        box.right >= rect.x + rect.w - ENCLOSE_TOLERANCE &&
        box.bottom >= rect.y + rect.h - ENCLOSE_TOLERANCE
      );
    });
    const innermost = containing.find((el) => !containing.some((o) => o !== el && el.contains(o)));
    kept = innermost ? [innermost] : [];
    containment = "within";
  }

  return kept.map((host) => {
    const box = host.getBoundingClientRect();
    const stamp = host.getAttribute("data-source-loc") ?? undefined;
    const cells = cellFrontier(host, sourceRoot);
    return {
      // Name resolution mirrors the attribution ladder: the producing cell if
      // stamped, else the authoring module read off the source stamp
      // (src/ui/Controls.tsx:44:7 → "Controls"), else the bare tag. The tag is
      // the last resort because a prompt full of `name="div"` repeated per
      // panel carries nothing — the paid-for finding behind this ladder.
      // `|| undefined` (not ??): an empty data-cell attribute must fall
      // through the ladder, same as cellFrontier's `if (!name)` guard.
      component:
        (host.getAttribute("data-cell") || undefined) ??
        componentNameFromStamp(stamp) ??
        host.tagName.toLowerCase(),
      source: stamp ? absoluteSource(stamp, sourceRoot) : "unknown",
      rect: { x: box.x, y: box.y, w: box.width, h: box.height },
      ...(cells.length > 0 ? { cells } : {}),
      ...(containment !== undefined ? { containment } : {}),
    };
  });
}

/**
 * The authoring module's name from a `data-source-loc` stamp:
 * `src/ui/Controls.tsx:44:7` → `Controls`. In a component-per-file codebase
 * (this methodology's default) the file basename IS the component name; when a
 * file holds several components the name is still the right place to start
 * reading, and the line/col in `source` disambiguates.
 */
function componentNameFromStamp(stamp: string | undefined): string | undefined {
  if (!stamp) {
    return undefined;
  }
  const file = stamp.split(":")[0] ?? "";
  const base = file.split("/").pop() ?? "";
  const name = base.replace(/\.[^.]+$/, "");
  return name.length > 0 ? name : undefined;
}

/**
 * The direct-cell frontier under `host`: `data-cell` descendants with no
 * other `data-cell` element strictly between them and `host`.
 */
function cellFrontier(host: Element, sourceRoot: string | undefined): LocatedCell[] {
  const frontier: LocatedCell[] = [];
  for (const el of host.querySelectorAll("[data-cell]")) {
    let between = el.parentElement;
    let shadowed = false;
    while (between && between !== host) {
      if (between.hasAttribute("data-cell")) {
        shadowed = true;
        break;
      }
      between = between.parentElement;
    }
    if (shadowed) {
      continue;
    }
    const name = el.getAttribute("data-cell");
    if (!name) {
      continue;
    }
    // THE shared resolution ladder (cellSourceLoc, also used by the selection
    // watcher and the jump picker): data-cell-loc → the live cell registry
    // (which resolves a bare manual `data-cell="name"` to its definition
    // site) → the element's own JSX stamp → first stamped descendant.
    const stamp = cellSourceLoc(el);
    frontier.push({ name, ...(stamp ? { source: absoluteSource(stamp, sourceRoot) } : {}) });
  }
  return frontier;
}

/**
 * Resolve a `data-source-loc` stamp (`file:line:col`, app-root-relative) to an
 * absolute `sourceRoot/file:line:col` when the root is known, else pass the
 * relative stamp through for the channel to resolve.
 */
function absoluteSource(stamp: string, root: string | undefined): string {
  if (!root) {
    return stamp;
  }
  return root.endsWith("/") ? `${root}${stamp}` : `${root}/${stamp}`;
}
