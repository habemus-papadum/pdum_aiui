/**
 * The minimal Vite HMR surface the decline() guards touch. Ambient (not
 * `vite/client`) on purpose: this package ships framework-free source that
 * non-Vite consumers (vitest, tsx, bundlers) also compile, and the guards
 * only ever run where a dev server defines `import.meta.hot`.
 */
interface ImportMeta {
  readonly hot?: {
    decline(): void;
  };
}
