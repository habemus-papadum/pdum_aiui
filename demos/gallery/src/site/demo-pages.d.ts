/**
 * Ambient types for the `virtual:demo-pages` module the gallery's
 * demo-discovery Vite plugin serves (see ../../demo-discovery.ts): the sibling
 * demo packages that carry an `aiui.sitePage` marker, sorted by their declared
 * `order`, each with a lazy loader for its SitePage entry.
 */
declare module "virtual:demo-pages" {
  import type { SitePage } from "@habemus-papadum/aiui-viz";

  export interface DemoPageEntry {
    /** The demo's directory name — doubles as its route slug. */
    slug: string;
    /** Tab label (marker `title`, defaulting to the slug). */
    title: string;
    /** Tab description line (marker `desc`). */
    desc: string;
    /** Tab position; the lowest order is the default route. */
    order: number;
    /** Lazy-load the demo's page module (code-split per demo). */
    load(): Promise<{ page: SitePage }>;
  }

  export const demos: DemoPageEntry[];
}
