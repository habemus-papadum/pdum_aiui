/**
 * The minimal Vite HMR surface the invalidate-on-accept guards touch.
 * Ambient (not `vite/client`) on purpose: this package ships framework-free
 * source that non-Vite consumers (vitest, tsx, bundlers) also compile, and
 * the guards only ever run where a dev server defines `import.meta.hot`.
 * Kept assignment-compatible with Vite's own ViteHotContext so a consumer
 * app that DOES load `vite/client` typechecks both.
 */
interface ImportMeta {
  readonly hot?: {
    accept(cb: (mod?: unknown) => void): void;
    invalidate(message?: string): void;
  };
}
