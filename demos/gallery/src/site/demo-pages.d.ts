/**
 * Ambient types for the `virtual:demo-pages` module the gallery's
 * demo-discovery Vite plugin serves (see ../../demo-discovery.ts): the sibling
 * demo packages that carry an `aiui.sitePage` marker, sorted by their declared
 * `order`, each with a lazy loader for its SitePage entry — and, when the demo
 * ships one, a lazy loader for its landing-card (DemoCard) module.
 */
declare module "virtual:demo-pages" {
  import type { DemoCard, SitePage } from "@habemus-papadum/aiui-viz";

  export interface DemoPageEntry {
    /** The demo's directory name — doubles as its route slug. */
    slug: string;
    /** Sidebar / card title (marker `title`, defaulting to the slug). */
    title: string;
    /** One-line sidebar description (marker `desc`). */
    desc: string;
    /** Sidebar position (marker `order`). */
    order: number;
    /** Lazy-load the demo's page module (code-split per demo). */
    load(): Promise<{ page: SitePage }>;
    /** Lazy-load the demo's landing-card module; absent when the demo ships no
     * `./card` export (the landing then renders a preview-less card). */
    loadCard?(): Promise<{ card: DemoCard }>;
  }

  export const demos: DemoPageEntry[];
}
