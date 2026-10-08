/**
 * source-reader.ts — the app's own source, read from the page: the engine of
 * the `source` standard tool. A file is named the way the stamps name it
 * (`src/ui/App.tsx`, or `../seismos/src/ui/App.tsx` from a shell that declared
 * stamp roots), and the text comes from wherever this page can get it:
 *
 *  - a DEV SERVER: `window.__AIUI__.sourceRoot` is the Vite root (a machine
 *    path, seeded by the aiui plugin), and Vite serves any workspace file as a
 *    string module at `/@fs/<path>?raw` — one dynamic import away;
 *  - a PRODUCTION build made with `aiui({ sources: "ship" })`: the plugin
 *    emitted the files under `__aiui/src/` and told the page where through
 *    `window.__AIUI__.sources = { base, manifest }`; the manifest maps stamp
 *    paths to published ones and is fetched once;
 *  - anything else answers "this page carries no source".
 *
 * Framework-free. The dependencies (the global, fetch, the raw import) are
 * injectable so the reader is testable without a server.
 */
import { type AiuiGlobal, ensureAiuiGlobal } from "./aiui-global";

/** Lines per call when `to` is not given. */
export const SOURCE_DEFAULT_LINES = 200;
/** Characters per call, after which the window stops early (`to` says where). */
export const SOURCE_MAX_CHARS = 32_768;

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

interface ShippedSources {
  base: string;
  manifest: string;
}

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

function checkFile(file: string): void {
  if (file === "" || /^[a-z]+:/i.test(file) || file.startsWith("/") || file.includes("\\")) {
    throw new Error(`"${file}" is not a stamp path — name a file as a stamp does: src/ui/App.tsx`);
  }
}

async function loadSource(file: string, deps: SourceReaderDeps): Promise<string> {
  const g = deps.global === undefined ? ensureAiuiGlobal() : deps.global;
  const shipped = (g as { sources?: ShippedSources } | undefined)?.sources;
  if (shipped !== undefined) {
    const files = await manifestOf(shipped, deps.fetchImpl ?? fetch);
    const published = files[file];
    if (published === undefined) {
      throw new Error(
        `no shipped source "${file}" — the build lists ${Object.keys(files).length} files; call source with no file to see them`,
      );
    }
    const res = await (deps.fetchImpl ?? fetch)(`${shipped.base}${published}`);
    if (!res.ok) throw new Error(`"${file}" answered ${res.status}`);
    return res.text();
  }
  const root = g?.sourceRoot;
  if (root !== undefined && isMachinePath(root)) {
    const url = `/@fs${joinSourcePath(root, file)}?raw`;
    const importRaw = deps.importRaw ?? ((u: string) => import(/* @vite-ignore */ u));
    const mod = await importRaw(url);
    const text = typeof mod === "string" ? mod : (mod as { default?: unknown })?.default;
    if (typeof text !== "string")
      throw new Error(`"${file}" did not load as text from the dev server`);
    return text;
  }
  throw new Error(
    'this page carries no source: not a dev server, and not built with aiui({ sources: "ship" })',
  );
}

/** The files a production build shipped, or undefined on a dev server (no list there). */
export async function listShippedSources(
  deps: SourceReaderDeps = {},
): Promise<string[] | undefined> {
  const g = deps.global === undefined ? ensureAiuiGlobal() : deps.global;
  const shipped = (g as { sources?: ShippedSources } | undefined)?.sources;
  if (shipped === undefined) return undefined;
  return Object.keys(await manifestOf(shipped, deps.fetchImpl ?? fetch));
}

/** Read a window of one source file (see the module doc). */
export async function readSource(
  file: string,
  options: ReadSourceOptions = {},
  deps: SourceReaderDeps = {},
): Promise<SourceWindow> {
  checkFile(file);
  const text = await loadSource(file, deps);
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
