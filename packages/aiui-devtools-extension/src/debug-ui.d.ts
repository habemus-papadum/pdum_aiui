/**
 * Types for `./debug-ui.js` — the esbuild-bundled shared debug UI (built from
 * `@habemus-papadum/aiui-dev-overlay/debug-ui` by build-debug-ui.mjs, loaded by
 * the panel at runtime). NodeNext resolves the panel's `./debug-ui.js` import to
 * this declaration.
 *
 * Hand-written on purpose: the extension compiles under NodeNext, the overlay
 * source under bundler mode, so importing the overlay's types directly would
 * drag its extensionless imports through a resolver that rejects them. This
 * declares just the surface the panel uses — keep it in sync with the debug-ui
 * module's public API (src/debug-ui/index.ts over in the overlay).
 */

export interface TraceStageLike {
  at?: string;
  kind?: string;
  label?: string;
  data?: unknown;
  file?: string;
}

export interface LiveTrace {
  rev: number;
  id?: string;
  format?: string;
  threadId?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  stages: TraceStageLike[];
}

export interface TracePollResult {
  changed: boolean;
  rev: number;
  trace?: LiveTrace;
  events?: unknown[];
}

export interface TracePollOptions {
  baseUrl: string;
  traceId: string;
  fetch?: typeof fetch;
}

export interface TracePoll {
  readonly rev: number | undefined;
  poll(): Promise<TracePollResult>;
  reset(): void;
}

export function createTracePoll(opts: TracePollOptions): TracePoll;

export type PreviewUrl = (path: string) => string;

export interface TraceViewConfig {
  blobUrl?: (traceId: string, file: string) => string;
  previewUrl?: PreviewUrl;
  correctionPolicy?: "replace" | "note";
  document?: Document;
}

export declare class TraceView {
  constructor(config?: TraceViewConfig);
  readonly root: HTMLDivElement;
  update(trace: LiveTrace | undefined): void;
}
