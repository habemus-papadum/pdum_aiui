/**
 * The hot-reloadable lowering layer.
 *
 * This module is the entry the hot loader (see hot.ts) re-imports — query-busted
 * (`?v=<generation>`) — on every {@link WebServer.reload}. ESM mints a fresh copy
 * of a module per unique query string, so each reload re-executes this file from
 * whatever is currently on disk.
 *
 * The catch: a fresh copy of *this* module does **not** get fresh copies of the
 * files it statically `import`s — those resolve to the already-cached
 * specifiers. So to actually reload the format code (the processors, the
 * intent-v1 lowering), we can't `import { defaultFormats } from "./processors"`
 * at the top and call it; that would return the stale, first-loaded formats.
 * Instead we read our own `?v` back out of `import.meta.url` and **propagate it**
 * to dynamic imports of the format-source modules, so those re-execute too.
 *
 * Reload depth is therefore exactly one level below this file: `processors.ts`
 * and `intent-v1.ts` (the two format entries) reload; anything *they* statically
 * import (codec, channel, tracing, prompt-context, realtime, transcribe,
 * correct, compose) stays cached and needs a full process restart. That's the
 * documented boundary — hot reload is a dev aid, not a general HMR.
 *
 * Keep {@link buildReloadableFormats} in sync with `defaultFormats` in
 * processors.ts: same built-in format names. The `hot.test.ts` drift guard
 * asserts the two agree.
 */
import type { ChannelFormat, FormatRegistry } from "./channel";

/** Our own cache-busting generation, recovered from the import query. */
function ownGeneration(): string {
  try {
    return new URL(import.meta.url).searchParams.get("v") ?? "0";
  } catch {
    return "0";
  }
}

/** A sibling module's URL carrying this module's `?v`, so it reloads with us. */
function bust(rel: string): string {
  const base = new URL(rel, import.meta.url).href.split("?")[0];
  return `${base}?v=${ownGeneration()}`;
}

/**
 * Build the built-in format registry from freshly (re-)loaded format modules.
 *
 * Async because it dynamically imports the format sources with the propagated
 * query — the mechanism that makes their edits take effect on reload. The
 * result mirrors `defaultFormats()`; the two must list the same format names.
 */
export async function buildReloadableFormats(): Promise<FormatRegistry> {
  const [processors, intentV1] = await Promise.all([
    import(/* @vite-ignore */ bust("./processors.ts")),
    import(/* @vite-ignore */ bust("./intent-v1.ts")),
  ]);
  return new Map<string, ChannelFormat>([
    ["text-concat", processors.textConcatFormat],
    ["intent-v1", intentV1.intentV1Format],
  ]);
}
