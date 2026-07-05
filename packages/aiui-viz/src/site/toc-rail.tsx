/**
 * TocRail.tsx — the Observable-Framework-style "On this page" rail.
 *
 * Built from the page's `section[id] > h2` headings (static per page, so a plain
 * DOM read after mount is enough — no reactive list). IntersectionObserver
 * tracks which sections are in the reading band and highlights the topmost one;
 * clicking a link scrolls smoothly and updates the hash. Hidden below ~1280px by
 * CSS (.toc-rail). Solid 2.0: no onMount — a ref callback runs when the <nav>
 * exists; we defer the query a microtask so the sibling sections are inserted
 * first.
 */
import { createSignal, For, onCleanup } from "solid-js";

interface TocItem {
  id: string;
  title: string;
}

export function TocRail() {
  const [items, setItems] = createSignal<TocItem[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  let observer: IntersectionObserver | undefined;

  const setup = () => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>("section[id]"));
    const list: TocItem[] = sections.map((s) => ({
      id: s.id,
      title: s.querySelector("h2")?.textContent?.trim() ?? s.id,
    }));
    setItems(list);
    if (list.length > 0) setActiveId(list[0].id);

    // A section is "in the reading band" once its top passes below the header
    // and before it leaves the top ~30% of the viewport; the topmost such
    // section (document order) is the active one.
    const visible = new Set<string>();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = list.find((it) => visible.has(it.id));
        if (first) setActiveId(first.id);
      },
      { rootMargin: "-72px 0px -68% 0px", threshold: 0 },
    );
    for (const s of sections) observer.observe(s);
  };

  const mount = () => queueMicrotask(setup);
  onCleanup(() => observer?.disconnect());

  const go = (e: MouseEvent, id: string) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    setActiveId(id);
  };

  return (
    <nav class="toc-rail" ref={mount} aria-label="On this page">
      <div class="toc-title">On this page</div>
      <ul>
        <For each={items()}>
          {(it) => (
            <li>
              <a
                href={`#${it.id}`}
                class={activeId() === it.id ? "toc-link toc-active" : "toc-link"}
                onClick={(e) => go(e, it.id)}
              >
                {it.title}
              </a>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );
}
