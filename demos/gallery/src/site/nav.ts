/**
 * nav.ts — the site's identity: the brand (a home link to the landing page),
 * the header links, and the sidebar item list, consumed by the SPA shell's
 * `<SiteNav>` (the library component from `@habemus-papadum/aiui-viz/site`).
 *
 * The items are DERIVED from the discovered demo packages (site/registry.ts ←
 * the `aiui.sitePage` markers): adding a notebook = giving a demo package the
 * marker — nothing to edit here. Item ids double as route slugs; hrefs are
 * real, deep-linkable URLs built through `hrefOf`, and the shell's link
 * interceptor turns clicks on them into client-side navigations — an open
 * intent turn survives the switch.
 */
import type { SiteNavItem } from "@habemus-papadum/aiui-viz/site";
import { DEMOS } from "./registry";
import { hrefOf, LANDING } from "./router";

/** The wordmark doubles as the home link (→ the landing card grid). */
export const BRAND = { name: "aiui", suffix: "notebooks", href: hrefOf(LANDING) };

export const LINKS = {
  github: "https://github.com/habemus-papadum/pdum_aiui",
  docs: "https://habemus-papadum.github.io/pdum_aiui/",
};

export const NAV_ITEMS: SiteNavItem[] = DEMOS.map((d) => ({
  id: d.slug,
  href: hrefOf(d.slug),
  name: d.title,
  desc: d.desc,
}));
