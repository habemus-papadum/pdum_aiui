/** Vite's ?raw imports (the FA glyphs in leader.ts) as strings, for tsc. */
declare module "*.svg?raw" {
  const markup: string;
  export default markup;
}
