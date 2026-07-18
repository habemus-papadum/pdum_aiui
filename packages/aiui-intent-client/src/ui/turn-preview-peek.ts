/**
 * turn-preview-peek.ts — the hover peek, one per TurnPreview: genuinely
 * imperative (attach, MEASURE, then flip above/below whichever side has room).
 * createPeek MUST be called during component setup, under a reactive owner —
 * the onCleanup(hide) is what tears the peek down when the pane disposes; call
 * it outside an owner and the body-attached element leaks.
 */

import { onCleanup } from "solid-js";

/** The peek's imperative face — shared by the shot/selection/nav/tab rows. */
export interface Peek {
  showImage: (anchor: HTMLElement, src: string) => void;
  showText: (anchor: HTMLElement, loc: string | undefined, text: string) => void;
  hide: () => void;
}

/**
 * The hover peek, one per component: genuinely imperative (attach, MEASURE,
 * then flip above/below whichever side has room — found live in the retired
 * extension side panel, where a hard-coded "above" clipped off-screen). Everything
 * else about a row is declarative; this owns the measurement.
 */
export function createPeek(): Peek {
  let peek: HTMLElement | undefined;
  const hide = (): void => {
    peek?.remove();
    peek = undefined;
  };
  /** Measure the attached peek and flip it above/below (and clamp left) against
   * the anchor. Re-runnable: an <img> reports 0×0 until it decodes, so the
   * image path calls this again on load — the FIRST measurement placed a text
   * card correctly (it has its size at once) but left a not-yet-decoded image
   * pinned to 0×0. */
  const position = (anchor: HTMLElement, el: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect();
    const height = el.getBoundingClientRect().height;
    const gap = 8;
    const above = rect.top - gap;
    const below = window.innerHeight - rect.bottom - gap;
    if (height <= above || above >= below) {
      el.style.top = "";
      el.style.bottom = `${window.innerHeight - rect.top + gap}px`;
    } else {
      el.style.bottom = "";
      el.style.top = `${rect.bottom + gap}px`;
    }
    const width = el.getBoundingClientRect().width;
    const left = Math.min(Math.max(gap, rect.left), Math.max(gap, window.innerWidth - width - gap));
    el.style.left = `${left}px`;
  };
  const place = (anchor: HTMLElement, el: HTMLElement): void => {
    hide();
    document.body.append(el);
    peek = el;
    position(anchor, el);
  };
  onCleanup(hide);
  return {
    showImage: (anchor, src) => {
      const img = document.createElement("img");
      img.className = "aiui-tp-peek-img";
      // Re-measure once the pixels are known — until decode the img is 0×0, so
      // the flip and left-clamp above would compute off a zero box.
      img.onload = () => {
        if (peek === img) {
          position(anchor, img);
        }
      };
      img.src = src;
      place(anchor, img);
    },
    showText: (anchor, loc, text) => {
      const card = document.createElement("div");
      card.className = "aiui-tp-peek";
      if (loc !== undefined) {
        const locEl = document.createElement("div");
        locEl.className = "aiui-tp-peek-loc";
        locEl.textContent = loc;
        card.append(locEl);
      }
      const textEl = document.createElement("div");
      textEl.className = "aiui-tp-peek-text";
      textEl.textContent = text;
      card.append(textEl);
      place(anchor, card);
    },
    hide,
  };
}
