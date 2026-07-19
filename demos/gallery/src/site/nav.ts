/**
 * nav.ts — the single source of the site's identity: the notebook tab list and
 * the header links, consumed by the SPA shell's `<SiteHeader>` (the library
 * component from `@habemus-papadum/aiui-viz/site`). Adding a notebook =
 * one entry here plus a page module in site/pages.ts.
 *
 * Tab ids double as route slugs (site/router.ts); hrefs are real, deep-linkable
 * URLs built through `hrefOf`, and the shell's link interceptor turns clicks on
 * them into client-side navigations — an open intent turn survives the switch.
 */
import type { SiteTab } from "@habemus-papadum/aiui-viz/site";
import { hrefOf } from "./router";

export const BRAND = { name: "aiui", suffix: "notebooks", href: hrefOf("morphogen") };

export const LINKS = {
  github: "https://github.com/habemus-papadum/pdum_aiui",
  docs: "https://habemus-papadum.github.io/pdum_aiui/",
};

export const TABS: SiteTab[] = [
  {
    id: "morphogen",
    href: hrefOf("morphogen"),
    name: "morphogen",
    desc: "reaction–diffusion lab",
  },
  {
    id: "aztec",
    href: hrefOf("aztec"),
    name: "aztec",
    desc: "random tilings & the arctic circle",
  },
  {
    id: "seismos",
    href: hrefOf("seismos"),
    name: "seismos",
    desc: "earthquakes & the Gutenberg–Richter law",
  },
  {
    id: "circle",
    href: hrefOf("circle"),
    name: "circle",
    desc: "how round can you draw a circle?",
  },
];
