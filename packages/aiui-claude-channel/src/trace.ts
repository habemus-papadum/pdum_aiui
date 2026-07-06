/**
 * Lowering traces: the on-disk record of how an intent became a prompt.
 *
 * Every websocket thread the channel server processes gets a **trace** — the
 * inputs it received, any intermediate representations a processor chose to
 * record, and the final lowered prompt it sent into the session. Traces are
 * what the debug tool (see debug.ts) renders, and they're the substrate for
 * prompt-lowering research: inspectable IRs between pipeline stages, like
 * dumping a compiler's passes.
 *
 * Traces live in a **project-local** cache — `.aiui-cache/` under the MCP
 * server's working directory, *not* the per-user cache — because they belong
 * to the project/session being worked on (and because prompts reference blob
 * files by path, which Claude Code — running in the same cwd — can read).
 * The directory is gitignored.
 *
 * Layout:
 *
 *   .aiui-cache/traces/<traceId>/trace.json    the manifest (TraceManifest)
 *   .aiui-cache/traces/<traceId>/<blob>        binary/large stage files
 *
 * Everything here is **best-effort**: a full disk or unwritable directory must
 * never break the prompt path, so all fs failures are swallowed and the trace
 * is simply incomplete.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory name of the project-local cache, relative to the server cwd. */
export const PROJECT_CACHE_DIRNAME = ".aiui-cache";

/** The project-local cache directory for a given base dir (default: cwd). */
export function projectCacheDir(base: string = process.cwd()): string {
  return join(base, PROJECT_CACHE_DIRNAME);
}

/** What part of the lowering pipeline a stage records. */
export type TraceStageKind = "input" | "ir" | "output" | "info";

/** One recorded step of a lowering run. */
export interface TraceStage {
  /** When the stage was recorded (ISO timestamp). */
  at: string;
  /**
   * `input` — data as received from the client; `ir` — an intermediate
   * representation a processor chose to expose; `output` — the final lowered
   * prompt; `info` — anything else worth noting.
   */
  kind: TraceStageKind;
  /** Short human label, e.g. `"frame 0"`, `"lowered prompt"`. */
  label: string;
  /** Inline structured data (small payloads, prompt text). */
  data?: unknown;
  /** Filename (relative to the trace dir) of a blob, for binary/large stages. */
  file?: string;
}

/** The `trace.json` manifest of one lowering run. */
export interface TraceManifest {
  id: string;
  /** The stream format (= modality wire name) the thread spoke. */
  format: string;
  /** The client-generated thread id. */
  threadId: string;
  /**
   * Who drove the turn (`"human"` | `"agent"` | free-form) — the client's
   * self-report from its hello (see {@link HelloMeta.actor} in frame.ts).
   * Absent on traces whose hello carried none.
   */
  actor?: string;
  /**
   * Which server process recorded the trace — the label its trace store was
   * created with (see {@link sessionLabel}). Traces from every run of a
   * project pile up flat in one cache dir, so this is the dimension trace
   * lists filter on ("this server's traces") and label rows from other runs
   * with. Absent on traces recorded before the label existed.
   */
  session?: string;
  startedAt: string;
  endedAt?: string;
  status?: "completed" | "abandoned";
  /**
   * A one-line gloss of the turn, written **after** the fact by the lowering
   * processor once the prompt has been sent (see {@link TraceHandle.setSummary}
   * and summarize.ts). Absent on unsummarized traces (cancelled/empty turns, a
   * keyless channel, or a run whose summary call failed or is still in flight).
   * Rides the list route so viewers can title rows with it.
   */
  summary?: string;
  /**
   * Running roll-up (USD) of what the turn's own model calls cost —
   * transcription, correction, TTS, realtime responses, the summary gloss.
   * Accumulated via {@link TraceHandle.addCost}; absent when nothing was
   * accounted (mock tiers, keyless runs, unpriced models). Estimated
   * components (see cost.ts) are included, so treat it as a floor. Rides the
   * list route like {@link summary}.
   */
  costUsd?: number;
  stages: TraceStage[];
}

/** A live trace being recorded for one thread. All methods are best-effort. */
export interface TraceHandle {
  readonly id: string;
  /** Absolute path of this trace's directory (where blobs land). */
  readonly dir: string;
  /** Append a stage to the manifest. */
  record(stage: Omit<TraceStage, "at">): void;
  /**
   * Write `bytes` as a blob file in the trace dir and append a stage
   * referencing it. Returns the blob's absolute path (usable in prompts —
   * Claude Code runs in the same cwd and can read it), or undefined when the
   * write failed.
   */
  recordBlob(
    stage: Omit<TraceStage, "at" | "file" | "data">,
    bytes: Uint8Array,
    filename: string,
  ): string | undefined;
  /**
   * Set (or replace) the manifest's one-line {@link TraceManifest.summary}.
   * Unlike {@link record}, this works **after** the trace has ended — the
   * summary is generated off the hot path, well after the turn was sent and the
   * trace finalized (see summarize.ts, intent-v1.ts). Best-effort like the rest:
   * a vanished trace dir just means no summary lands.
   */
  setSummary(text: string): void;
  /**
   * Add one model call's spend (USD) to the manifest's {@link TraceManifest.costUsd}
   * roll-up. Like {@link setSummary}, deliberately usable **after** the trace has
   * ended — the summary gloss (the last paid call of a turn) resolves off the hot
   * path, after finalization. Non-finite/non-positive amounts are ignored.
   */
  addCost(usd: number): void;
  /** Finalize the manifest. Idempotent. */
  end(status?: "completed" | "abandoned"): void;
}

/** Creates and reads traces under one project cache directory. */
export interface TraceStore {
  /** The traces root: `<cacheDir>/traces`. */
  readonly dir: string;
  /**
   * The session label every {@link begin} stamps on its manifest (see
   * {@link TraceManifest.session}), when the store was created with one.
   */
  readonly session?: string;
  /**
   * Start recording a new trace. Never throws. `actor` is the hello's
   * provenance self-report (see {@link TraceManifest.actor}), when known.
   */
  begin(format: string, threadId: string, actor?: string): TraceHandle;
}

const MANIFEST = "trace.json";

/**
 * Mint the label naming one server process's trace session:
 * `<tag>·<pid>·<HHMMSS>`. `tag` is the server's `--tag` (falling back to
 * `"channel"` when it launched untagged), and HHMMSS is the process-start
 * wall clock (local time) — tag, pid, and start time together let a human
 * tell "this server's traces" from an earlier run's at a glance, without
 * depending on the registry. Minted once per server process, when its trace
 * store is created; every trace the store begins is stamped with it (see
 * {@link TraceManifest.session}). The defaults describe *this* process;
 * tests pass explicit values.
 */
export function sessionLabel(
  tag: string | undefined,
  pid: number = process.pid,
  startedAt: Date = new Date(Date.now() - process.uptime() * 1000),
): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  const clock = `${two(startedAt.getHours())}${two(startedAt.getMinutes())}${two(startedAt.getSeconds())}`;
  return `${tag ?? "channel"}·${pid}·${clock}`;
}

/** Sortable-unique trace id: UTC timestamp + a short random suffix. */
function newTraceId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 17);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Only ids/filenames matching this ever touch the filesystem (no traversal). */
const SAFE_NAME = /^[\w.-]+$/;

/** A handle whose every method is a no-op — used when the dir can't be made. */
const noopHandle = (id: string, dir: string): TraceHandle => ({
  id,
  dir,
  record() {},
  recordBlob: () => undefined,
  setSummary() {},
  addCost() {},
  end() {},
});

/**
 * Open a trace store rooted at a project cache dir (created on first use).
 * `session` is the owning server process's label (see {@link sessionLabel});
 * every trace begun through the store carries it. Omitted (tests, ad-hoc
 * stores), manifests simply have no session — the "unknown" bucket in
 * session-filtered trace lists.
 */
export function createTraceStore(cacheDir: string, session?: string): TraceStore {
  const tracesDir = join(cacheDir, "traces");

  const begin = (format: string, threadId: string, actor?: string): TraceHandle => {
    const id = newTraceId();
    const dir = join(tracesDir, id);
    const manifest: TraceManifest = {
      id,
      format,
      threadId,
      ...(actor !== undefined ? { actor } : {}),
      ...(session !== undefined ? { session } : {}),
      startedAt: new Date().toISOString(),
      stages: [],
    };

    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return noopHandle(id, dir);
    }

    // Rewrite the whole manifest on every record: traces are small, and a
    // crash mid-run then loses at most the last stage.
    const flush = (): void => {
      try {
        writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      } catch {
        // best-effort: an unwritable trace must never break the prompt path
      }
    };
    flush();

    let ended = false;
    return {
      id,
      dir,
      record(stage) {
        if (ended) {
          return;
        }
        manifest.stages.push({ at: new Date().toISOString(), ...stage });
        flush();
      },
      recordBlob(stage, bytes, filename) {
        if (ended || !SAFE_NAME.test(filename)) {
          return undefined;
        }
        const file = join(dir, filename);
        try {
          writeFileSync(file, bytes);
        } catch {
          return undefined;
        }
        manifest.stages.push({ at: new Date().toISOString(), ...stage, file: filename });
        flush();
        return file;
      },
      setSummary(text) {
        // Deliberately *not* guarded by `ended`: the summary is written after
        // the turn is sent and the trace finalized. We are the sole writer of
        // this manifest, so the in-memory object (which already carries
        // endedAt/status) is authoritative — set the field and rewrite. A
        // vanished dir is swallowed by flush, so a pruned/cleaned trace no-ops.
        manifest.summary = text;
        flush();
      },
      addCost(usd) {
        // Same post-end latitude as setSummary (the summary's own cost is the
        // canonical late arrival); same sole-writer reasoning.
        if (!Number.isFinite(usd) || usd <= 0) {
          return;
        }
        manifest.costUsd = (manifest.costUsd ?? 0) + usd;
        flush();
      },
      end(status = "completed") {
        if (ended) {
          return;
        }
        ended = true;
        manifest.endedAt = new Date().toISOString();
        manifest.status = status;
        flush();
      },
    };
  };

  return { dir: tracesDir, ...(session !== undefined ? { session } : {}), begin };
}

/** Read one trace's manifest, or null if absent/malformed/unsafe id. */
export function readTrace(cacheDir: string, id: string): TraceManifest | null {
  if (!SAFE_NAME.test(id)) {
    return null;
  }
  try {
    const raw = readFileSync(join(cacheDir, "traces", id, MANIFEST), "utf8");
    const parsed = JSON.parse(raw) as TraceManifest;
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed.stages)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** List all trace manifests under a cache dir, newest first. */
export function listTraces(cacheDir: string): TraceManifest[] {
  let entries: string[];
  try {
    entries = readdirSync(join(cacheDir, "traces"));
  } catch {
    return [];
  }
  return entries
    .map((id) => readTrace(cacheDir, id))
    .filter((t): t is TraceManifest => t !== null)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** Resolve a blob file's absolute path, or null if the names are unsafe. */
export function traceBlobPath(cacheDir: string, id: string, filename: string): string | null {
  if (!SAFE_NAME.test(id) || !SAFE_NAME.test(filename) || filename === MANIFEST) {
    return null;
  }
  return join(cacheDir, "traces", id, filename);
}
