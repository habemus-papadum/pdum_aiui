/**
 * source-reader.ts — the app's own source, read from the page: the engine of
 * the `source` and `sources` standard tools and of the dock's source browser.
 * A file is named the way the stamps name it (`src/ui/App.tsx`, or
 * `../seismos/src/ui/App.tsx` from a shell that declared stamp roots), and
 * the text comes from wherever this page can get it — one of three MODES:
 *
 *  - `dev`: a DEV SERVER. The aiui plugin seeds `window.__AIUI__.sources`
 *    with a manifest it serves (`mode: "dev"`): every app file on disk, each
 *    mapped to Vite's `/@fs/…` URL, which the reader imports as a `?raw`
 *    string module. An older plugin that seeds only `sourceRoot` (a machine
 *    path) still reads: the URL is joined from the root, there is just no
 *    listing;
 *  - `shipped`: a PRODUCTION build made with `aiui({ sources: "ship" })`. The
 *    plugin emitted the files under `__aiui/src/` and the manifest maps stamp
 *    paths to those published ones under `base`; the reader fetches them;
 *  - `none`: anything else. Every read answers that the page carries no
 *    source — as a {@link SourceUnavailableError}, which the tools turn into
 *    a structured `{ available: false, reason }` rather than a bare failure.
 *
 * A file the page does not list is unavailable too, with the closest names
 * the page does list as suggestions ({@link suggestSources}).
 *
 * Framework-free. The dependencies (the global, fetch, the raw import) are
 * injectable so the reader is testable without a server.
 */
import { type AiuiGlobal, ensureAiuiGlobal } from "./aiui-global";

/** Lines per call when `to` is not given. */
export const SOURCE_DEFAULT_LINES = 200;
/** Characters per call, after which the window stops early (`to` says where). */
export const SOURCE_MAX_CHARS = 32_768;
/** At most this many near-miss names ride an unavailable answer. */
const MAX_SUGGESTIONS = 5;

/** Where this page's source comes from (see the module doc). */
export type SourcesMode = "dev" | "shipped" | "none";

export interface SourceListing {
  mode: SourcesMode;
  /** The stamp paths this page can read, sorted. Absent only on a dev server
   * whose plugin predates the listing (it still reads by name). */
  files?: string[];
  /** Why the listing is what it is, when that needs saying. */
  note?: string;
}

export interface SourceWindow {
  file: string;
  /** First and last line returned, 1-based, inclusive. */
  from: number;
  to: number;
  /** Lines in the whole file. */
  total: number;
  /** True when lines remain after `to`. */
  more: boolean;
  /** The lines, each prefixed `<n> | `. */
  text: string;
}

export interface ReadSourceOptions {
  from?: number;
  to?: number;
  maxChars?: number;
}

export interface SourceReaderDeps {
  /** The page global; `ensureAiuiGlobal()` by default. */
  global?: AiuiGlobal | undefined;
  fetchImpl?: typeof fetch;
  /** Import a `?raw` string module from the dev server. */
  importRaw?: (url: string) => Promise<unknown>;
}

/** A file this page cannot read, and why — the tools' structured answer. */
export class SourceUnavailableError extends Error {
  readonly file: string;
  readonly reason: string;
  /** The closest names the page does list, when it lists any. */
  readonly suggestions: string[];
  constructor(file: string, reason: string, suggestions: string[] = []) {
    super(reason);
    this.name = "SourceUnavailableError";
    this.file = file;
    this.reason = reason;
    this.suggestions = suggestions;
  }
}

type ShippedSources = NonNullable<AiuiGlobal["sources"]>;

/** Resolve `.` and `..` against an absolute root — the stamp's relative path, made a path. */
export function joinSourcePath(root: string, rel: string): string {
  const out = root.replace(/\/+$/, "").split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

const manifests = new Map<string, Promise<Record<string, string>>>();

function manifestOf(
  shipped: ShippedSources,
  fetchImpl: typeof fetch,
): Promise<Record<string, string>> {
  let held = manifests.get(shipped.manifest);
  if (held === undefined) {
    held = fetchImpl(shipped.manifest).then(async (res) => {
      if (!res.ok) throw new Error(`the sources manifest answered ${res.status}`);
      const body = (await res.json()) as { files?: Record<string, string> };
      return body.files ?? {};
    });
    held.catch(() => manifests.delete(shipped.manifest)); // let a later call retry
    manifests.set(shipped.manifest, held);
  }
  return held;
}

/** Looks like a filesystem root (the dev seed), not a URL (the shipped seed). */
const isMachinePath = (root: string): boolean => /^(\/|[A-Za-z]:[\\/])/.test(root);

/** Which mode this page is in (see the module doc). */
export function sourcesMode(global?: AiuiGlobal | undefined): SourcesMode {
  const g = global === undefined ? ensureAiuiGlobal() : global;
  const sources = g?.sources;
  if (sources?.mode === "dev") return "dev";
  if (sources !== undefined) return "shipped";
  if (g?.sourceRoot !== undefined && isMachinePath(g.sourceRoot)) return "dev";
  return "none";
}

const NO_SOURCE =
  'this page carries no source: not a dev server, and not built with aiui({ sources: "ship" })';

function checkFile(file: string): void {
  if (file === "" || /^[a-z]+:/i.test(file) || file.startsWith("/") || file.includes("\\")) {
    throw new Error(`"${file}" is not a stamp path — name a file as a stamp does: src/ui/App.tsx`);
  }
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * The closest listed names to one the page does not have: same basename
 * first, then paths containing the asked basename, then paths sharing the
 * asked path's last directory — at most {@link MAX_SUGGESTIONS}, in listing
 * order within each tier.
 */
export function suggestSources(file: string, files: readonly string[]): string[] {
  const want = basename(file).toLowerCase();
  const dir = file.includes("/")
    ? basename(file.slice(0, file.lastIndexOf("/"))).toLowerCase()
    : "";
  const tiers: Array<(f: string) => boolean> = [
    (f) => basename(f).toLowerCase() === want,
    (f) => want !== "" && f.toLowerCase().includes(want),
    (f) => dir !== "" && f.toLowerCase().split("/").includes(dir),
  ];
  const out: string[] = [];
  for (const tier of tiers) {
    for (const f of files) {
      if (out.length >= MAX_SUGGESTIONS) return out;
      if (!out.includes(f) && tier(f)) out.push(f);
    }
  }
  return out;
}

/** The files this page can read (see {@link SourceListing}). */
export async function listSources(deps: SourceReaderDeps = {}): Promise<SourceListing> {
  const g = deps.global === undefined ? ensureAiuiGlobal() : deps.global;
  const mode = sourcesMode(g);
  if (mode === "none") return { mode, files: [], note: NO_SOURCE };
  const sources = g?.sources;
  if (sources === undefined) {
    return {
      mode,
      note: "this dev server lists no files (its aiui plugin predates the listing); name one as a stamp does",
    };
  }
  const files = Object.keys(await manifestOf(sources, deps.fetchImpl ?? fetch)).sort();
  return { mode, files };
}

/** The whole text of one file (the browser's read; the tools window it). */
export async function sourceText(file: string, deps: SourceReaderDeps = {}): Promise<string> {
  checkFile(file);
  const g = deps.global === undefined ? ensureAiuiGlobal() : deps.global;
  const mode = sourcesMode(g);
  if (mode === "none") throw new SourceUnavailableError(file, NO_SOURCE);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sources = g?.sources;
  const manifest = sources === undefined ? undefined : await manifestOf(sources, fetchImpl);
  const published = manifest?.[file];
  if (manifest !== undefined && published === undefined) {
    const files = Object.keys(manifest);
    throw new SourceUnavailableError(
      file,
      `no source "${file}" among the ${files.length} files this page lists — call sources to see them`,
      suggestSources(file, files),
    );
  }
  if (mode === "dev") {
    let url: string;
    if (published !== undefined) {
      url = `${published}?raw`;
    } else if (g?.sourceRoot !== undefined && isMachinePath(g.sourceRoot)) {
      url = `/@fs${joinSourcePath(g.sourceRoot, file)}?raw`;
    } else {
      throw new SourceUnavailableError(file, "this dev server lists no files and seeds no root");
    }
    const importRaw = deps.importRaw ?? ((u: string) => import(/* @vite-ignore */ u));
    let mod: unknown;
    try {
      mod = await importRaw(url);
    } catch (err) {
      throw new SourceUnavailableError(
        file,
        `the dev server does not serve "${file}" (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const text = typeof mod === "string" ? mod : (mod as { default?: unknown })?.default;
    if (typeof text !== "string") {
      throw new SourceUnavailableError(file, `"${file}" did not load as text from the dev server`);
    }
    return text;
  }
  if (sources === undefined || published === undefined) {
    throw new SourceUnavailableError(file, NO_SOURCE); // unreachable: shipped ⇒ manifest
  }
  const res = await fetchImpl(`${sources.base}${published}`);
  if (!res.ok) throw new SourceUnavailableError(file, `"${file}" answered ${res.status}`);
  return res.text();
}

/** Read a window of one source file (see the module doc). */
export async function readSource(
  file: string,
  options: ReadSourceOptions = {},
  deps: SourceReaderDeps = {},
): Promise<SourceWindow> {
  const text = await sourceText(file, deps);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const total = lines.length;
  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.floor(n), lo), hi);
  const from = total === 0 ? 1 : clamp(options.from ?? 1, 1, total);
  const wantTo = options.to ?? from + SOURCE_DEFAULT_LINES - 1;
  const to = total === 0 ? 0 : clamp(wantTo, from, total);
  const maxChars = Math.max(1, options.maxChars ?? SOURCE_MAX_CHARS);
  const width = String(to).length;
  const out: string[] = [];
  let chars = 0;
  let last = from - 1;
  for (let n = from; n <= to; n++) {
    const line = `${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`;
    if (chars + line.length + 1 > maxChars && out.length > 0) break;
    out.push(line);
    chars += line.length + 1;
    last = n;
  }
  return { file, from, to: last, total, more: last < total, text: out.join("\n") };
}
