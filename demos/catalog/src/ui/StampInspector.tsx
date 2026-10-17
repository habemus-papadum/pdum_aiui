/**
 * StampInspector.tsx — the agent surface made visible: hover anything inside
 * a live specimen and a bar at the foot of the page lists the stamps the
 * element (and its ancestors) carry — the attributes `locate`, `selection`
 * and `read-page` resolve. The bar is agent chrome itself (`data-aiui-chrome`),
 * so `read-page` skips it. Listeners attach in the component body and detach
 * on cleanup (Solid 2.0: no onMount).
 */
import { AGENT_CHROME_ATTR } from "@habemus-papadum/aiui-viz";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";

/** The stamps table of the catalog's §4, in the order it lists them. */
const STAMPS = [
  "data-source-loc",
  "data-cell",
  "data-cell-loc",
  "data-cell-state",
  "data-control",
  "data-tex",
  "data-aiui-term",
  "data-mermaid",
  "data-aiui-id",
  "data-aiui-kind",
] as const;

const clip = (s: string, n = 56): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function StampInspector(): JSX.Element {
  const [found, setFound] = createSignal<Array<[string, string]>>([]);

  const onOver = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element) || target.closest(".cat-specimen") === null) {
      setFound([]);
      return;
    }
    // Innermost wins per stamp; walk up to the specimen's edge.
    const seen = new Map<string, string>();
    for (let el: Element | null = target; el !== null; el = el.parentElement) {
      for (const attr of STAMPS) {
        const v = el.getAttribute(attr);
        if (v !== null && !seen.has(attr)) seen.set(attr, v);
      }
      if (el.classList.contains("cat-specimen")) break;
    }
    setFound([...seen.entries()]);
  };
  document.addEventListener("pointerover", onOver);
  onCleanup(() => document.removeEventListener("pointerover", onOver));

  return (
    <Show when={found().length > 0}>
      <aside class="cat-stamps" {...{ [AGENT_CHROME_ATTR]: "" }} aria-live="polite">
        <span class="cat-stamps-title">stamps</span>
        <For each={found()}>
          {([k, v]) => (
            <span class="cat-stamp">
              <code class="cat-stamp-key">{k}</code>
              <code class="cat-stamp-value">{clip(v)}</code>
            </span>
          )}
        </For>
      </aside>
    </Show>
  );
}
