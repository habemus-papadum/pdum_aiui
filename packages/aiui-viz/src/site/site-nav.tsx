/**
 * site-nav.tsx — the site's primary navigation as a LEFT SIDEBAR on desktop
 * that collapses to a top bar + slide-in drawer on a phone.
 *
 * It answers "this site has more than one experiment, plus a home": a wordmark
 * that returns to the landing page, the list of notebooks (each with a
 * one-line descriptor and a clear active state), and GitHub + docs links
 * pinned to the bottom. The active item is matched by `id` against `active`;
 * an empty `active` (the landing route) highlights the wordmark instead.
 *
 * Responsive behavior lives here, not in the shell: on a narrow screen the
 * sidebar becomes an off-canvas drawer and a slim top bar appears with a menu
 * button. The open/closed drawer state is this component's own concern (a
 * signal); it closes on any nav click, on the scrim, and on Escape. On desktop
 * the drawer machinery is inert (CSS hides the top bar and pins the sidebar in
 * flow), so the same markup serves both.
 *
 * The tab list, branding, and link URLs are the app's (see the gallery's
 * src/site/nav.ts). Styling is the consumer's, via the `.site-nav*` /
 * `.site-topbar*` / `.site-scrim` class names — the same CSS-ownership seam as
 * CellView. The shell is expected to wrap this plus its content in an
 * `.app-frame` (a flex row on desktop) with the page in `.app-content`.
 */
import { createSignal, For, onCleanup, Show } from "solid-js";

export interface SiteNavItem {
  /** Stable id, matched against the `active` prop (a route slug). */
  id: string;
  /** Href for the item (base-prefixed, deep-linkable). */
  href: string;
  /** Item name (one word reads best). */
  name: string;
  /** One-line descriptor shown under the name. */
  desc: string;
}

export interface SiteNavProps {
  /** Wordmark + home link. `href` is the landing page. */
  brand: { name: string; suffix?: string; href: string };
  items: SiteNavItem[];
  /** The active item's `id`; empty string (the landing route) highlights the
   * wordmark/home instead of any item. */
  active: string;
  links?: { github?: string; docs?: string };
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function DocsIcon() {
  return (
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
  );
}

export function SiteNav(props: SiteNavProps) {
  const [open, setOpen] = createSignal(false);
  const close = () => setOpen(false);

  // Solid 2.0 has no onMount — attach in the body (setup runs once), clean up
  // via onCleanup reached from the body. Escape closes the mobile drawer.
  if (typeof window !== "undefined") {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  }

  const wordmark = (extraClass?: string) => (
    <a
      class={`site-wordmark${extraClass ? ` ${extraClass}` : ""}${
        props.active === "" ? " site-wordmark-active" : ""
      }`}
      href={props.brand.href}
      aria-label={`${props.brand.name} home`}
      aria-current={props.active === "" ? "page" : undefined}
      onClick={close}
    >
      <b>{props.brand.name}</b>
      {props.brand.suffix !== undefined ? <> · {props.brand.suffix}</> : null}
    </a>
  );

  return (
    <>
      {/* Phone-only top bar: wordmark + the drawer toggle. Hidden on desktop. */}
      <header class="site-topbar">
        <button
          type="button"
          class="site-menu-btn"
          aria-label="Open navigation"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M3 6h18M3 12h18M3 18h18"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
        {wordmark("site-topbar-brand")}
      </header>

      {/* The scrim behind the open drawer (phone only; inert on desktop). */}
      <div
        class={`site-scrim${open() ? " site-scrim-open" : ""}`}
        onClick={close}
        aria-hidden="true"
      />

      {/* The sidebar: pinned in the flex row on desktop, an off-canvas drawer on
          a phone. `data-open` drives the drawer transform on narrow screens. */}
      <aside class={`site-nav${open() ? " site-nav-open" : ""}`} aria-label="Site navigation">
        <div class="site-nav-head">{wordmark()}</div>
        <nav class="site-nav-items" aria-label="Notebooks">
          <For each={props.items}>
            {(t) => (
              <a
                class={
                  t.id === props.active ? "site-nav-item site-nav-item-active" : "site-nav-item"
                }
                href={t.href}
                data-tab-id={t.id}
                aria-current={t.id === props.active ? "page" : undefined}
                onClick={close}
              >
                <span class="site-nav-item-name">{t.name}</span>
                <span class="site-nav-item-desc">{t.desc}</span>
              </a>
            )}
          </For>
        </nav>
        <div class="site-nav-links">
          <Show when={props.links?.github}>
            {(url) => (
              <a
                class="site-icon"
                href={url()}
                target="_blank"
                rel="noreferrer"
                title="View source on GitHub"
              >
                <GithubIcon />
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
                <DocsIcon />
                <span class="sr-only">Documentation</span>
              </a>
            )}
          </Show>
        </div>
      </aside>
    </>
  );
}
