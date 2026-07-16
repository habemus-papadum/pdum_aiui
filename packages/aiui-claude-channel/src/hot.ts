/**
 * The hot-reload loader: how the web backend gets a *fresh* format registry
 * built from whatever is currently on disk, plus the optional dev file-watcher
 * that triggers a reload on source edits.
 *
 * The mechanism is ESM's per-query module identity: `import(url + "?v=" + n)`
 * mints a fresh, re-transformed copy of the target module for each unique `n`.
 * We confirmed this holds under both runners this package ships to — `tsx`
 * source runs (the in-repo CLI is `node --import tsx …`, see
 * packages/aiui/src/util/resolve-cli.ts) and plain `node` dist runs.
 *
 * Two loading strategies, chosen by whether we're running from source:
 *
 *  - **Source run** (`…/src/hot.ts`): re-import {@link reloadable.ts} query-busted,
 *    which propagates the query on to the format-source modules so their edits
 *    take effect. This is the real "edit the channel, reload it live" path.
 *  - **Packaged run** (bundled `…/dist/…`): there is no separate on-disk module
 *    to reload — it's one bundle — so reload rebuilds the registry from the
 *    already-loaded {@link defaultFormats}. Code doesn't change, but the reload
 *    still cycles connections and rebuilds in-memory state (exercising the
 *    drop/reconnect robustness the clients are built for).
 *
 * Old module instances are never evicted — each reload leaks the previous copy.
 * That's an accepted cost of a dev-only feature.
 */
import { watch as fsWatch } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FormatRegistry } from "./channel";
import { defaultFormats } from "./processors";

/** Produces a fresh base (untraced) format registry for a reload generation. */
export type FormatLoader = (generation: number) => FormatRegistry | Promise<FormatRegistry>;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** True when this module is running from TypeScript source (not a built bundle). */
export function isSourceRun(): boolean {
  return import.meta.url.includes("/src/");
}

/**
 * Re-import a module with a cache-busting `?v=<generation>` query, yielding a
 * freshly re-transformed instance per unique generation. `baseUrl` is a
 * file:// URL; any existing query is dropped first. Exported so an out-of-harness
 * integration test can prove the reload-from-disk semantics directly.
 */
export function loadModuleFresh(
  baseUrl: string,
  generation: number,
): Promise<Record<string, unknown>> {
  const url = `${baseUrl.split("?")[0]}?v=${generation}`;
  return import(/* @vite-ignore */ url);
}

/**
 * The default loader for {@link startWebServer}. Picks the source or packaged
 * strategy (above) once, at server start.
 */
export function defaultFormatLoader(): FormatLoader {
  if (!isSourceRun()) {
    // Packaged: rebuild from the bundle — a fresh Map over the built formats.
    return () => defaultFormats();
  }
  const reloadableUrl = new URL("./reloadable.ts", import.meta.url).href;
  return async (generation) => {
    const mod = await loadModuleFresh(reloadableUrl, generation);
    const build = mod.buildReloadableFormats as () => Promise<FormatRegistry>;
    return build();
  };
}

/** The package's own `src/` directory, or undefined when running from a bundle. */
export function channelSourceDir(): string | undefined {
  if (!isSourceRun()) {
    return undefined;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/** An fs.watch-like function: injected in tests, defaults to node's recursive watch. */
export type WatchFn = (
  dir: string,
  listener: (event: string, filename: string | null) => void,
) => { close: () => void };

export interface WatchOptions {
  /** Directory watched (recursively) for source edits. */
  dir: string;
  /** Called once a burst of changes settles. */
  onChange: () => void;
  /** Debounce window in ms (default 300). */
  delayMs?: number;
  /** The watcher factory; defaults to `fs.watch(dir, { recursive: true })`. */
  watch?: WatchFn;
  /** Where a diagnostic line goes (defaults to stderr). */
  log?: (line: string) => void;
}

const defaultWatch: WatchFn = (dir, listener) => fsWatch(dir, { recursive: true }, listener);

/**
 * The staleness notice a running channel raises when its own backend source
 * changes on disk. The channel does NOT hot-reload (the old shallow
 * format-registry swap gave a false sense of HMR and was removed), so the honest
 * signal is: tell the human/agent the process is now running OLD code, and a
 * restart is the only way to apply the edit.
 */
export const STALE_NOTICE =
  "⚠️ aiui channel source changed on disk. The running MCP server does NOT hot-reload, " +
  "so it is now STALE — your edits take effect only after the channel restarts (restart the " +
  "aiui session). Treat the channel's behavior as out-of-date until then.";

/** A source filename worth reacting to: a .ts/.tsx that isn't a test. */
const isSourceEdit = (filename: string | null): boolean =>
  filename !== null && /\.tsx?$/.test(filename) && !/\.test\.tsx?$/.test(filename);

/**
 * Watch a source directory and fire `onChange` (debounced) after edits settle.
 * Dev-only and strictly opt-in at the call site — this exists so `aiui claude`
 * can auto-reload the channel on save (gated by `AIUI_CHANNEL_WATCH=1`). Returns
 * a disposer; a watch that can't be established (unsupported platform) logs and
 * disposes to a no-op rather than throwing.
 */
export function watchChannelSource(options: WatchOptions): () => void {
  const delay = options.delayMs ?? 300;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const watchFn = options.watch ?? defaultWatch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: { close: () => void } | undefined;
  try {
    watcher = watchFn(options.dir, (_event, filename) => {
      if (!isSourceEdit(filename)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        options.onChange();
      }, delay);
      // Don't let a pending debounce keep the process alive on its own.
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
  } catch (err) {
    log(`[aiui-channel] source watch unavailable: ${errorMessage(err)}`);
    return () => {};
  }
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    watcher?.close();
  };
}
