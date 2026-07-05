/**
 * site-header.tsx — the slim, sticky top bar shared by every notebook page.
 *
 * It answers "this site has more than one experiment": a wordmark, then the
 * notebook tabs made impossible to miss (each with a one-line descriptor and a
 * clear active state), then GitHub + docs icon links. Keep tab hrefs relative
 * ("./", "./aztec.html") so they survive a hosting prefix (the demo publishes
 * under /aiui/) — pages at the same directory level can share one tab list.
 *
 * The tab list, branding, and link URLs are the app's (see the demo's
 * src/site/nav.ts for the worked example); this component owns only structure
 * and behavior. Styling is the consumer's, via the .site-* class names — same
 * CSS-ownership seam as CellView.
 */
import { For, Show } from "solid-js";

export interface SiteTab {
  /** Stable id, matched against the `active` prop. */
  id: string;
  /** Relative href ("./", "./aztec.html") — survives hosting prefixes. */
  href: string;
  /** Tab name (one word reads best). */
  name: string;
  /** One-line descriptor shown under the name. */
  desc: string;
}

export interface SiteHeaderProps {
  /** Wordmark text after the bold site name, e.g. "notebooks". */
  brand: { name: string; suffix?: string; href?: string };
  tabs: SiteTab[];
  /** The active tab's `id`. */
  active: string;
  links?: { github?: string; docs?: string };
}

export function SiteHeader(props: SiteHeaderProps) {
  return (
    <header class="site-header">
      <div class="site-header-inner">
        <a class="site-wordmark" href={props.brand.href ?? "./"} aria-label={`${props.brand.name} home`}>
          <b>{props.brand.name}</b>
          {props.brand.suffix !== undefined ? <> · {props.brand.suffix}</> : null}
        </a>
        <nav class="site-tabs" aria-label="Notebooks">
          <For each={props.tabs}>
            {(t) => (
              <a
                class={t.id === props.active ? "site-tab site-tab-active" : "site-tab"}
                href={t.href}
                aria-current={t.id === props.active ? "page" : undefined}
              >
                <span class="site-tab-name">{t.name}</span>
                <span class="site-tab-desc">{t.desc}</span>
              </a>
            )}
          </For>
        </nav>
        <div class="site-links">
          <Show when={props.links?.github}>
            {(url) => (
              <a
                class="site-icon"
                href={url()}
                target="_blank"
                rel="noreferrer"
                title="View source on GitHub"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
                <span class="sr-only">View source on GitHub</span>
              </a>
            )}
          </Show>
          <Show when={props.links?.docs}>
            {(url) => (
              <a
                class="site-icon"
                href={url()}
                target="_blank"
                rel="noreferrer"
                title="Documentation"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
                <span class="sr-only">Documentation</span>
              </a>
            )}
          </Show>
        </div>
      </div>
    </header>
  );
}
