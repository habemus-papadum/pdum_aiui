/**
 * styles.ts — one `<style>` per module for the STRUCTURAL CSS a site
 * component cannot do without (positions, grids, cursors; never a color or a
 * font — the look is the consumer's, aiui-design's by default).
 *
 * Idempotent per mark, and REFRESHED rather than merely created: a hot edit
 * of a module's CSS string must land on the open page too, or the old rules
 * outlive the module that wrote them (first paid for in rich-tex.tsx).
 */

export function ensureStyles(mark: string, css: string): void {
  if (typeof document === "undefined") return;
  let el = document.head.querySelector<HTMLStyleElement>(`style[${mark}]`);
  if (el === null) {
    el = document.createElement("style");
    el.setAttribute(mark, "");
    document.head.append(el);
  }
  if (el.textContent !== css) el.textContent = css;
}
