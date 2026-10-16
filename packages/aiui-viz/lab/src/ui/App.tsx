/**
 * App.tsx — the lab's shell: the design system's sidebar, one routed page.
 * Links are intercepted into client-side navigation (a hard navigation would
 * reset every durable — the running training loop included).
 */
import { navigateTo, pathname, SiteNav } from "@habemus-papadum/aiui-viz/site";
import { Dynamic, type JSX } from "@solidjs/web";
import { createEffect, createMemo, onCleanup } from "solid-js";
import { NAV } from "./nav";
import { Derivation } from "./pages/Derivation";
import { Fidelity } from "./pages/Fidelity";
import { Fourier } from "./pages/Fourier";
import { Landing } from "./pages/Landing";
import { Training } from "./pages/Training";

const PAGES: Record<string, () => JSX.Element> = {
  fidelity: Fidelity,
  training: Training,
  derivation: Derivation,
  fourier: Fourier,
};

export function App(): JSX.Element {
  const route = createMemo(() => pathname().replace(/^\/+/, "").split("/")[0] ?? "");
  createEffect(route, (r) => {
    const item = NAV.find((n) => n.id === r);
    document.title = item ? `${item.name} · RichTeX Lab` : "RichTeX Lab";
  });

  const intercept = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const anchor = (e.target as Element | null)?.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.target !== "" || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.hash !== "") return;
    e.preventDefault();
    navigateTo(url.pathname);
    window.scrollTo(0, 0);
  };
  // On the document, not a wrapper div: the frame is static chrome, and the
  // component body is an owner, so the cleanup is honored.
  document.addEventListener("click", intercept);
  onCleanup(() => document.removeEventListener("click", intercept));

  return (
    <div class="app-frame">
      <SiteNav
        brand={{ name: "RichTeX", suffix: "lab", href: "/" }}
        items={[...NAV]}
        active={route()}
        links={{ github: "https://github.com/habemus-papadum/pdum_aiui" }}
      />
      <main class="app-content rtx-lab">
        <Dynamic component={PAGES[route()] ?? Landing} />
      </main>
    </div>
  );
}
