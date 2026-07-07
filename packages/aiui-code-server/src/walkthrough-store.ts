/**
 * walkthrough-store.ts — the on-disk store for Tier 3 walkthroughs
 * (docs/proposals/code-reader.md, §Tier 3). One JSON file per walkthrough under
 * `<cacheDir>/walkthroughs/`, the same `.aiui-cache` family as traces.
 *
 * The clock and id-suffix generator are injectable (mirroring
 * {@link PageToolDirectory}) so tests are deterministic; at runtime they default
 * to the real wall clock and a random suffix.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Walkthrough, WalkthroughSummary } from "@habemus-papadum/aiui-code-protocol";
import { summarize } from "@habemus-papadum/aiui-code-protocol";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface WalkthroughStoreOptions {
  /** The walkthroughs directory (caller passes `<cacheDir>/walkthroughs`). */
  dir: string;
  /** Clock for `createdAt` — inject for deterministic tests. */
  now?: () => Date;
  /** Short random suffix for generated ids — inject for deterministic tests. */
  newId?: () => string;
  /** Where the skip-a-bad-file log line goes (defaults to stderr). */
  log?: (line: string) => void;
}

export interface WalkthroughStore {
  list(): Promise<WalkthroughSummary[]>;
  get(id: string): Promise<Walkthrough | undefined>;
  save(w: Walkthrough): Promise<{ id: string }>;
}

const isPos = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { line?: unknown }).line === "number" &&
  typeof (v as { character?: unknown }).character === "number";

/** Validate the shape we require to persist a walkthrough. `id` may be empty
 * (it is generated). Throws a descriptive error on the first problem. */
function validate(w: unknown): asserts w is Walkthrough {
  const obj = w as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") {
    throw new Error("walkthrough must be an object");
  }
  if (typeof obj.title !== "string" || obj.title.trim() === "") {
    throw new Error("walkthrough.title must be a non-empty string");
  }
  if (obj.id !== undefined && typeof obj.id !== "string") {
    throw new Error("walkthrough.id must be a string when present");
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error("walkthrough.steps must be a non-empty array");
  }
  obj.steps.forEach((step: unknown, i: number) => {
    const s = step as Record<string, unknown> | null;
    if (!s || typeof s !== "object") {
      throw new Error(`walkthrough.steps[${i}] must be an object`);
    }
    if (typeof s.file !== "string" || s.file === "") {
      throw new Error(`walkthrough.steps[${i}].file must be a non-empty string`);
    }
    if (typeof s.prose !== "string") {
      throw new Error(`walkthrough.steps[${i}].prose must be a string`);
    }
    const range = s.range as Record<string, unknown> | null;
    if (!range || !isPos(range.start) || !isPos(range.end)) {
      throw new Error(`walkthrough.steps[${i}].range must have {start,end} positions`);
    }
  });
}

/** Slugify a title into a filesystem/URL-safe stem. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "walkthrough";
}

/** Map an id to its on-disk filename, neutralizing path separators so an id can
 * never traverse out of the store directory. */
const fileNameFor = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;

export function createWalkthroughStore(options: WalkthroughStoreOptions): WalkthroughStore {
  const { dir } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID().slice(0, 8));
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

  const list = async (): Promise<WalkthroughSummary[]> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // store dir not created yet — nothing to list
    }
    const summaries: WalkthroughSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
        validate(parsed);
        summaries.push(summarize(parsed));
      } catch (err) {
        log(`walkthrough-store: skipping unreadable ${name} — ${errMsg(err)}`);
      }
    }
    summaries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return summaries;
  };

  const get = async (id: string): Promise<Walkthrough | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(join(dir, fileNameFor(id)), "utf8"));
      validate(parsed);
      return parsed;
    } catch {
      return undefined;
    }
  };

  const save = async (w: Walkthrough): Promise<{ id: string }> => {
    validate(w);
    const id = w.id && w.id.trim() !== "" ? w.id.trim() : `${slugify(w.title)}-${newId()}`;
    const record: Walkthrough = {
      ...w,
      id,
      createdAt: w.createdAt ?? now().toISOString(),
    };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileNameFor(id)), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { id };
  };

  return { list, get, save };
}
