// Injected at build time by Vite's `define` (see vite.config.ts). The `typeof`
// guard is a no-op in the built CLI (where the define replaces it with a string
// literal) but keeps this working anywhere the define isn't applied.
declare const __AIUI_VERSION__: string;

/** This aiui build's version. */
export const VERSION = typeof __AIUI_VERSION__ === "string" ? __AIUI_VERSION__ : "0.0.0+dev";
