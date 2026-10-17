/**
 * catalog-source.ts — the catalog's text, read at build time from the file
 * that owns it. Vite's `?raw` import inlines `packages/aiui-viz/CATALOG.md`
 * into this chunk, so the page and the file can never disagree: editing the
 * catalog re-renders the page on save, and the published site carries the
 * catalog of the commit it was built from.
 */
import md from "../../../../packages/aiui-viz/CATALOG.md?raw";

export const CATALOG_MD: string = md;

/** The file's own URL on GitHub — what its relative links resolve against. */
export const CATALOG_URL =
  "https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-viz/CATALOG.md";
