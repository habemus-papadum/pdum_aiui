/**
 * nav.ts — the site's identity: the brand, the header links, and the notebook
 * tab list, consumed by the SPA shell's `<SiteHeader>` (the library component
 * from `@habemus-papadum/aiui-viz/site`).
 *
 * The tabs are DERIVED from the discovered demo packages (site/registry.ts ←
 * the `aiui.sitePage` markers): adding a notebook = giving a demo package the
 * marker — nothing to edit here. Tab ids double as route slugs; hrefs are
 * real, deep-linkable URLs built through `hrefOf`, and the shell's link
 * interceptor turns clicks on them into client-side navigations — an open
 * intent turn survives the switch.
 */
import type { SiteTab } from "@habemus-papadum/aiui-viz/site";
import { DEFAULT_ROUTE, DEMOS } from "./registry";
import { hrefOf } from "./router";

export const BRAND = { name: "aiui", suffix: "notebooks", href: hrefOf(DEFAULT_ROUTE) };

export const LINKS = {
  github: "https://github.com/habemus-papadum/pdum_aiui",
  docs: "https://habemus-papadum.github.io/pdum_aiui/",
};

export const TABS: SiteTab[] = DEMOS.map((d) => ({
  id: d.slug,
  href: hrefOf(d.slug),
  name: d.title,
  desc: d.desc,
}));
