/**
 * path-binding.ts — slide ↔ URL, over the shared pathname signal
 * (`@habemus-papadum/aiui-viz/site` path.ts).
 *
 * The URL shape: slide 0 is the BARE base ("/gear-talk" — a shared deck link
 * starts at the title), every other slide is `base/<id>` ("/gear-talk/mesh";
 * a bare 1-based number is accepted inbound). Writes use **replaceState** —
 * scrolling through a deck must not spam history; Back leaves the deck, like
 * scrolling a long document.
 *
 * A bare base is "no opinion", not "slide 0": the slide control is durable,
 * so an author revisiting /gear-talk resumes where they left off, while a
 * link WITH a tail always wins (that is what a deep link means). Hence
 * {@link bindDeckToPath} seeds the model from the URL synchronously (tail
 * only) BEFORE its effect runs — the effect's first pass then aligns the URL
 * to the model instead of clobbering the deep link.
 *
 * One effect owns both directions with a last-path tiebreak: when the URL
 * moved (popstate, shell navigation, pasted link) it wins; otherwise the
 * model moved and gets reflected. Both branches are equality-guarded, so the
 * pair converges instead of looping — and because the shell's router derives
 * from the SAME pathname signal, neither router can miss the other's writes.
 */
import { navigateTo, pathname } from "@habemus-papadum/aiui-viz/site";
import { createEffect, untrack } from "solid-js";
import type { DeckModel } from "./model";

/** Normalize a base to "" or "/prefix" (no trailing slash). */
function cleanBase(base: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b === "" || b.startsWith("/") ? b : `/${b}`;
}

/**
 * pathname → slide index; `-1` when the path is not under `base` (not ours —
 * never navigate on foreign paths). Unknown tails resolve to 0.
 */
export function slideFromPath(path: string, base: string, ids: readonly string[]): number {
  const b = cleanBase(base);
  if (!(path === b || path === `${b}/` || path.startsWith(`${b}/`))) return -1;
  const tail = path.slice(b.length).replace(/^\//, "").replace(/\/$/, "");
  if (tail === "") return 0;
  const byId = ids.indexOf(tail);
  if (byId !== -1) return byId;
  if (/^\d+$/.test(tail)) {
    const oneBased = Number.parseInt(tail, 10);
    return Math.min(Math.max(oneBased - 1, 0), ids.length - 1);
  }
  return 0;
}

/** slide index → pathname (slide 0 is the bare base). */
export function pathForSlide(base: string, ids: readonly string[], index: number): string {
  const b = cleanBase(base);
  if (index <= 0) return b === "" ? "/" : b;
  return `${b}/${ids[index]}`;
}

/**
 * The deck's mount base, sniffed from the live URL — host-agnostic on
 * purpose (the two-host rule: ask at runtime, never bake a `define`). A
 * gallery mounts the deck at "<BASE>/<slug>"; standalone dev serves it at
 * "/" and the slug never appears, so the base is "".
 */
export function deckBase(slug: string): string {
  if (typeof location === "undefined") return "";
  const path = location.pathname;
  const idx = path.indexOf(`/${slug}`);
  return idx === -1 ? "" : path.slice(0, idx + slug.length + 1);
}

/**
 * Bind a deck's slide control to the URL. Call from INSIDE a component (the
 * Deck does it when given `basePath`) — the effect belongs to that reactive
 * owner and unbinds when the page unmounts.
 */
export function bindDeckToPath(model: DeckModel, base: string): void {
  if (typeof location === "undefined") return;
  const ids = model.slides.map((s) => s.id);

  // Deep links win over durable state — but only a tail is an opinion.
  const initial = slideFromPath(location.pathname, base, ids);
  if (initial > 0) model.slide.set(initial);

  let lastPath = location.pathname;
  createEffect(
    () => ({ path: pathname(), slide: model.slide.get() }),
    ({ path, slide }) => {
      if (path !== lastPath) {
        // The URL moved (popstate / shell nav / pasted link): it wins.
        lastPath = path;
        const idx = slideFromPath(path, base, ids);
        if (idx >= 0 && idx !== slide) untrack(() => model.goTo(idx));
      } else {
        // The model moved (keys, widget, agent, scroll): reflect it.
        const want = pathForSlide(base, ids, slide);
        if (want !== path) {
          navigateTo(want, { replace: true });
          lastPath = want;
        }
      }
    },
  );
}
