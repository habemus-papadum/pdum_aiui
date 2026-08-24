/**
 * lens.tsx — the Lens: levels of detail for web-native documents, in three
 * tiers.
 *
 *  1. An inline TRIGGER — a real `<button>` (semantics first) carrying
 *     arbitrary JSX, with a dotted-underline affordance by default.
 *  2. Hover or keyboard focus (short delay) → a PEEK: an anchored popover
 *     rendering `preview` — dense, glanceable, deliberately cheap (the
 *     DemoCard discipline: pure model only). Touch devices have no hover;
 *     tap goes straight to tier 3 — by design, not simulation.
 *  3. Click → the DETAIL overlay: a centered panel rendering `detail` —
 *     full, interactive, and **in the same reactive graph** as the page: the
 *     Portal keeps Solid ownership under this component, so the detail view
 *     reads (and writes) the very cells and controls the page uses.
 *     Mount-on-open / dispose-on-close is the components-are-pure-readers
 *     discipline — nothing is lost on close.
 *
 * DECK-INDEPENDENT by construction: no deck imports, no deck context, no new
 * dependencies (viewport clamping is arithmetic, not a floating-ui
 * dependency) — a research notebook wants this component exactly as much as
 * a slide does, and its upstream home is aiui-viz once it has proven out in
 * both (docs/proposals/slides.md).
 *
 * Interaction conventions are the Dropdown's: outside-pointerdown and Escape
 * close, listeners attach in the component body and detach via onCleanup
 * (Solid 2.0: no onMount). The Escape listener runs at bubble phase, so a
 * capture-phase deck keymap that claims Escape (an open HUD) wins first — a
 * coherent ladder: topmost surface closes first. Focus goes into the panel
 * on open and back to the trigger on close.
 *
 * The peek and the overlay render IN PLACE (position: fixed), not through a
 * Portal: the page's design tokens (`--aiui-lens-*`, set on a page-scoped
 * class) must reach them by inheritance, and a body-mounted portal would sit
 * outside that scope. `position: fixed` escapes every ancestor's overflow
 * clipping on its own. A transformed/filtered ancestor DOES become the
 * fixed-position containing block — and the deck's translated track is
 * exactly that for every slide past the first — so both surfaces measure
 * that block's viewport origin and subtract it (`fixedOrigin`), staying
 * viewport-true under any ancestor.
 */
import { PageBoundary } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import {
  type Component,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  Show,
  useContext,
} from "solid-js";

type LensState = "closed" | "peek" | "open";

/**
 * Where Lens popovers MOUNT. A shell whose content rides a transformed
 * surface (the deck's translated track; a Step row mid-transition) provides
 * an element OUTSIDE every transform but INSIDE its token scope, and Lens
 * reparents its fixed surfaces there — their containing block is then the
 * real viewport, stable by construction. Without a provider the surfaces
 * render in place: the plain-page path, unchanged.
 */
export const LensLayer = createContext<HTMLElement | null>(null);

/** How long the pointer rests on the trigger before the peek appears. */
const PEEK_DELAY_MS = 200;
/** Grace period to travel trigger → popover without the peek collapsing. */
const PEEK_GRACE_MS = 160;
/** Minimum gap between a peek popover and the viewport edge. */
const EDGE_PAD_PX = 8;

export function Lens(props: {
  /** Trigger content (inline JSX — a term, a number, a thumbnail). */
  children: JSX.Element;
  /** Tier 2: the dense, glanceable preview. Omit to go straight to detail. */
  preview?: Component;
  /** Tier 3: the full, interactive detail view. */
  detail: Component;
  /** Accessible name for the trigger and heading for the detail panel. */
  label: string;
  class?: string;
  /** Extra class(es) for the DETAIL PANEL (`.aiui-lens-panel`) — the hook for
   * per-lens sizing (a wide instrument, a narrow definition) without touching
   * the global panel rule. `class` styles the trigger only. */
  panelClass?: string;
}): JSX.Element {
  const [state, setState] = createSignal<LensState>("closed");
  // Captured in the BODY (refs run without context in Solid 2.0).
  const layer = useContext(LensLayer);
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  let peekTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  // A surface REPARENTED into the layer leaves its <Show>'s marker span, so
  // Solid's branch disposal cannot remove it (found live: an unclosable
  // zombie panel). Track the moved nodes and remove them OURSELVES — when
  // their state ends, and when the component disposes (unmount, HMR).
  let peekEl: HTMLElement | undefined;
  let overlayEl: HTMLElement | undefined;
  // Removal is DEFERRED a microtask: removing a surface that holds focus
  // refires focus handlers synchronously, and inside this effect callback
  // their state() reads would warn STRICT_READ_UNTRACKED (seen live). The
  // element is captured first, so a same-tick reopen's fresh surface is
  // never the one removed.
  createEffect(
    () => state(),
    (s) => {
      if (s !== "peek" && peekEl !== undefined) {
        const el = peekEl;
        peekEl = undefined;
        queueMicrotask(() => el.remove());
      }
      if (s !== "open" && overlayEl !== undefined) {
        const el = overlayEl;
        overlayEl = undefined;
        queueMicrotask(() => el.remove());
      }
    },
  );
  onCleanup(() => {
    peekEl?.remove();
    overlayEl?.remove();
  });

  const clearTimers = (): void => {
    if (peekTimer !== undefined) clearTimeout(peekTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    peekTimer = undefined;
    graceTimer = undefined;
  };
  onCleanup(clearTimers);

  const openPeek = (): void => {
    if (props.preview !== undefined && state() === "closed") setState("peek");
  };
  const open = (): void => {
    clearTimers();
    setState("open");
    queueMicrotask(() => panel?.focus());
  };
  const close = (): void => {
    clearTimers();
    const wasOpen = state() === "open";
    setState("closed");
    if (wasOpen) trigger?.focus();
  };

  // Tier-2 pointer choreography: rest to peek; leaving either side starts the
  // grace clock; re-entering either side stops it.
  const pointerIn = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") return; // touch goes straight to tier 3
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (state() === "closed" && peekTimer === undefined) {
      peekTimer = setTimeout(() => {
        peekTimer = undefined;
        openPeek();
      }, PEEK_DELAY_MS);
    }
  };
  const pointerOut = (e: PointerEvent): void => {
    if (e.pointerType !== "mouse") return;
    if (peekTimer !== undefined) {
      clearTimeout(peekTimer);
      peekTimer = undefined;
    }
    if (state() === "peek") {
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (state() === "peek") setState("closed");
      }, PEEK_GRACE_MS);
    }
  };

  // Overlay dismissal (Dropdown conventions). Listeners live for the
  // component's life and act only when open — cheaper than re-wiring per
  // state flip, and Escape-at-bubble keeps the deck's capture keymap senior.
  if (typeof document !== "undefined") {
    /** Lenses NEST (a detail can hold further lenses), and every instance
     * listens on the document — where stopPropagation cannot stop the other
     * same-node listeners, so one Escape would close the whole stack (found
     * live: a nested calculator and its host both vanished). Overlays append
     * in open order, so the LAST one in the document is the topmost surface:
     * only its owner may claim this Escape. */
    const ownsTopOverlay = (): boolean => {
      const overlays = document.querySelectorAll(".aiui-lens-overlay");
      const top = overlays[overlays.length - 1];
      return top !== undefined && panel !== undefined && top.contains(panel);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (state() === "open") {
        if (!ownsTopOverlay()) return; // an inner lens closes first
        e.stopPropagation();
        close();
      } else if (state() === "peek") {
        setState("closed");
      }
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (state() !== "open") return;
      if (!ownsTopOverlay()) return; // clicks belong to the inner surface
      const target = e.target as Node | null;
      if (panel && target && panel.contains(target)) return;
      if (trigger && target && trigger.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    });
  }

  /** Where the element's fixed containing block sits in VIEWPORT space.
   * `position: fixed` anchors to the viewport only until some ancestor wears
   * a transform and becomes the containing block — the module caveat, now met
   * in practice: a deck's translated track transforms EVERY slide past the
   * first. Zero the insets, and the rect origin reveals the containing
   * block; subtracting it makes viewport coordinates true again anywhere. */
  const fixedOrigin = (el: HTMLElement): { x: number; y: number } => {
    el.style.left = "0px";
    el.style.top = "0px";
    const zero = el.getBoundingClientRect();
    return { x: zero.x, y: zero.y };
  };

  /** Anchor the peek under (or, cramped, above) the trigger, clamped to the
   * viewport — plain arithmetic on two rects, nothing more. */
  const placePeek = (pop: HTMLElement): void => {
    const anchor = trigger?.getBoundingClientRect();
    if (anchor === undefined) return;
    const origin = fixedOrigin(pop);
    const rect = pop.getBoundingClientRect();
    let left = anchor.left + anchor.width / 2 - rect.width / 2;
    left = Math.max(EDGE_PAD_PX, Math.min(left, window.innerWidth - rect.width - EDGE_PAD_PX));
    let top = anchor.bottom + EDGE_PAD_PX;
    if (top + rect.height > window.innerHeight - EDGE_PAD_PX) {
      top = Math.max(EDGE_PAD_PX, anchor.top - rect.height - EDGE_PAD_PX);
    }
    pop.style.left = `${left - origin.x}px`;
    pop.style.top = `${top - origin.y}px`;
  };

  /** Anchor the full-viewport overlay to the actual viewport: under a
   * transformed ancestor its `inset: 0` covers the containing block instead,
   * so shift by the measured origin and size it to the window explicitly. */
  const placeOverlay = (el: HTMLElement): void => {
    const origin = fixedOrigin(el);
    if (origin.x === 0 && origin.y === 0) return;
    el.style.left = `${-origin.x}px`;
    el.style.top = `${-origin.y}px`;
    el.style.width = `${window.innerWidth}px`;
    el.style.height = `${window.innerHeight}px`;
  };

  return (
    <>
      <button
        type="button"
        class={`aiui-lens-trigger${props.class === undefined ? "" : ` ${props.class}`}`}
        aria-haspopup="dialog"
        aria-expanded={state() === "open" ? "true" : "false"}
        aria-label={props.label}
        ref={(el) => {
          trigger = el;
        }}
        onPointerEnter={pointerIn}
        onPointerLeave={pointerOut}
        onFocusIn={() => openPeek()}
        onFocusOut={() => {
          if (state() === "peek") setState("closed");
        }}
        onClick={() => (state() === "open" ? close() : open())}
      >
        {props.children}
      </button>

      <Show when={state() === "peek"}>
        <div
          class="aiui-lens-peek"
          role="tooltip"
          onPointerEnter={pointerIn}
          onPointerLeave={pointerOut}
          ref={(el) => {
            // Both moves are DEFERRED: the ref fires before Solid inserts the
            // node at its anchor, so a synchronous reparent would be undone by
            // that insert (probed on beta.32) — and styles settle by then too.
            queueMicrotask(() => {
              if (layer !== null) {
                layer.appendChild(el);
                peekEl = el; // moved: ours to remove (see the state effect)
              }
              placePeek(el);
            });
          }}
        >
          {/* The lazy-getter pattern (gallery Landing.tsx): Show's children
              run untracked; PageBoundary both fixes the read and contains a
              faulty preview. */}
          <Show when={props.preview}>
            {(Preview) => (
              <PageBoundary name={`${props.label} preview`}>{Preview()({})}</PageBoundary>
            )}
          </Show>
        </div>
      </Show>

      <Show when={state() === "open"}>
        <div
          class="aiui-lens-overlay"
          ref={(el) => {
            // Same deferral as the peek: reparent after Solid's insert, then
            // anchor.
            queueMicrotask(() => {
              if (layer !== null) {
                layer.appendChild(el);
                overlayEl = el; // moved: ours to remove (see the state effect)
              }
              placeOverlay(el);
            });
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop; Escape is the keyboard path. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — the keyboard equivalent is Escape, handled document-wide. */}
          <div class="aiui-lens-backdrop" onClick={() => close()} />
          <div
            class={`aiui-lens-panel${props.panelClass === undefined ? "" : ` ${props.panelClass}`}`}
            role="dialog"
            aria-modal="true"
            aria-label={props.label}
            tabindex="-1"
            ref={(el) => {
              panel = el;
            }}
          >
            <div class="aiui-lens-head">
              <span class="aiui-lens-title">{props.label}</span>
              <button
                type="button"
                class="aiui-lens-close"
                aria-label="close"
                onClick={() => close()}
              >
                ✕
              </button>
            </div>
            <div class="aiui-lens-body">
              {/* Boundary at the mount seam: a broken detail view must not
                  halt the document's reactive system. */}
              <PageBoundary name={props.label}>
                <props.detail />
              </PageBoundary>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
