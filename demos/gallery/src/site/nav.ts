/**
 * nav.ts — the single source of the site's identity: the notebook tab list and
 * the header links, consumed by every page's `<SiteHeader>` (the library
 * component from `@habemus-papadum/aiui-viz/site`). Adding a notebook page =
 * one entry here (plus its Vite entry in vite.config.ts).
 */
import type { SiteTab } from "@habemus-papadum/aiui-viz/site";

export const BRAND = { name: "aiui", suffix: "notebooks" };

export const LINKS = {
  github: "https://github.com/habemus-papadum/pdum_aiui",
  docs: "https://habemus-papadum.github.io/pdum_aiui/",
};

export const TABS: SiteTab[] = [
  { id: "morphogen", href: "./", name: "morphogen", desc: "reaction–diffusion lab" },
  { id: "aztec", href: "./aztec.html", name: "aztec", desc: "random tilings & the arctic circle" },
  {
    id: "seismos",
    href: "./seismos.html",
    name: "seismos",
    desc: "earthquakes & the Gutenberg–Richter law",
  },
];
