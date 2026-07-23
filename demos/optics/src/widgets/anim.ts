/**
 * anim.ts — one small discipline for every animated island in these demos: a
 * rAF loop that only runs while its element is actually on screen and the tab
 * is visible. Notebook pages mount many wave maps; the ones scrolled away must
 * cost nothing.
 */

/**
 * Run `frame(tMs)` on rAF while `el` intersects the viewport and the document
 * is visible. Returns a stop function (call it from onCleanup).
 */
export function whileVisible(el: Element, frame: (tMs: number) => void): () => void {
  let raf = 0;
  let intersecting = false;
  let stopped = false;

  const loop = (t: number): void => {
    raf = 0;
    if (stopped || !intersecting || document.hidden) return;
    frame(t);
    raf = requestAnimationFrame(loop);
  };
  const kick = (): void => {
    if (!stopped && intersecting && !document.hidden && raf === 0) {
      raf = requestAnimationFrame(loop);
    }
  };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) intersecting = e.isIntersecting;
    kick();
  });
  io.observe(el);
  const onVis = (): void => kick();
  document.addEventListener("visibilitychange", onVis);

  return () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    io.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  };
}
