/**
 * files.ts — the reader's read-only file service (list + read), rooted at the
 * project the backend serves.
 *
 * Two responsibilities, both narrow: walk the project into a flat, deterministic
 * tree (skipping the heavy/irrelevant dirs), and read one text file with a
 * language id attached. The security-relevant primitive is {@link resolveWithin}
 * — every read goes through it, so a `?path=` from the browser can never escape
 * the root.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { FileEntry, FileReadResponse } from "@habemus-papadum/aiui-code-protocol";
import { monacoLanguageId } from "./language-id";

/** Directories never walked (heavy, generated, or irrelevant to reading). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "__pycache__",
  ".aiui-cache",
]);

/** Hard cap on tree size, so a pathological repo can't produce an unbounded list. */
const MAX_ENTRIES = 5000;

/** Refuse to read files larger than this (bytes) — the reader is for source. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Resolve `rel` against `root`, rejecting anything that escapes `root` (a `..`
 * that climbs out, an absolute path, a sibling-directory prefix). Returns the
 * absolute path. Pure — no filesystem access.
 */
export function resolveWithin(root: string, rel: string): string {
  if (isAbsolute(rel)) {
    throw new Error(`path must be project-relative, got absolute: ${rel}`);
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, rel);
  // Compare against a separator-terminated root so `/a/root2` is not treated as
  // living under `/a/root`.
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (target !== rootResolved && !target.startsWith(rootWithSep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return target;
}

/** Native path → POSIX (the wire uses `/` regardless of host OS). */
const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));

export interface FileService {
  /** Flat, deterministic list of readable files/dirs under the root. */
  tree(): Promise<FileEntry[]>;
  /** One file's text + inferred language id. */
  read(rel: string): Promise<FileReadResponse>;
}

export interface FileServiceOptions {
  root: string;
  /** Resolve a path's language id (LSP-managed langs come from the manifest;
   * defaults to the Monaco grammar fallback). */
  languageId?: (rel: string) => string;
}

export function createFileService({ root, languageId }: FileServiceOptions): FileService {
  const rootResolved = resolve(root);
  const resolveLanguageId = languageId ?? monacoLanguageId;

  const tree = async (): Promise<FileEntry[]> => {
    const entries: FileEntry[] = [];

    const walk = async (absDir: string, relDir: string): Promise<void> => {
      if (entries.length >= MAX_ENTRIES) {
        return;
      }
      // Unreadable directory — skip it rather than fail the whole tree.
      const dirents = await readdir(absDir, { withFileTypes: true }).catch(() => null);
      if (!dirents) {
        return;
      }
      // Deterministic: directories first, then files, each alphabetical.
      const sorted = dirents.slice().sort((a, b) => {
        const rank = (isDir: boolean) => (isDir ? 0 : 1);
        const byKind = rank(a.isDirectory()) - rank(b.isDirectory());
        if (byKind !== 0) {
          return byKind;
        }
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      for (const dirent of sorted) {
        if (entries.length >= MAX_ENTRIES) {
          return;
        }
        const name = dirent.name;
        const relPath = relDir ? `${relDir}/${name}` : name;
        if (dirent.isDirectory()) {
          // Skip the known-heavy dirs and dot-DIRECTORIES generally; dot-FILES
          // (like .gitignore) are kept — they're worth reading.
          if (SKIP_DIRS.has(name) || name.startsWith(".")) {
            continue;
          }
          entries.push({ path: relPath, type: "dir" });
          await walk(join(absDir, name), relPath);
        } else if (dirent.isFile()) {
          entries.push({ path: relPath, type: "file" });
        }
        // symlinks and other special entries are skipped.
      }
    };

    await walk(rootResolved, "");
    return entries;
  };

  const read = async (rel: string): Promise<FileReadResponse> => {
    const abs = resolveWithin(rootResolved, rel);
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`not a file: ${rel}`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`file too large (${info.size} bytes > ${MAX_FILE_BYTES}): ${rel}`);
    }
    const buf = await readFile(abs);
    // A NUL byte is a strong signal of a binary file — the reader only handles text.
    if (buf.includes(0)) {
      throw new Error(`refusing to read binary file: ${rel}`);
    }
    return {
      path: toPosix(rel),
      content: buf.toString("utf8"),
      languageId: resolveLanguageId(rel),
    };
  };

  return { tree, read };
}
