import { transformSync } from "@babel/core";
import { sourceLocatorBabel } from "./src/source-locator";

const src = `/**
 * Diffusion constant — how fast heat spreads.
 * @remarks internal
 */
export const kappa = control({ value: 0.1 });`;
const out = transformSync(src, {
  filename: "/proj/src/model/store.ts",
  parserOpts: { plugins: ["typescript"] },
  plugins: [[sourceLocatorBabel, { root: "/proj" }]],
  configFile: false,
  babelrc: false,
});
console.log(out?.code);
