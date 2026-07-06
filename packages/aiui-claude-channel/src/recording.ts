/**
 * Recording mode (experimental): persist the frame log as JSONL.
 *
 * A {@link JsonlRecorder} is a {@link FrameLogSink} that appends every
 * {@link FrameLogEntry} as one JSON line to
 * `<cacheDir>/recordings/<ISO-timestamp>-<pid>.jsonl`. This is the raw
 * material for future dataset export (e.g. HuggingFace): a complete, ordered,
 * timestamped record of one debug session's protocol traffic — hellos, event
 * batches, acks, pushes. Binary payloads are **not** duplicated here; the
 * frame log already reduces them to byte counts, and the bytes themselves live
 * in the trace blob store (see trace.ts), keyed by the same thread.
 *
 * Deliberately tiny: the sink interface is a single function (frame-log.ts's
 * `FrameLogSink`), so other sinks — a websocket tap, a metrics counter, a
 * different serialization — attach the same way without touching this module.
 * Like tracing, recording is best-effort: an unwritable disk must never break
 * the prompt path, so failures are swallowed and the recording is simply
 * incomplete.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { FrameLogSink } from "./frame-log";

/** A frame-log sink writing JSONL to one file under `<cacheDir>/recordings/`. */
export interface JsonlRecorder {
  /** Absolute path of the recording file. */
  readonly path: string;
  /** Attach this to the frame log (see `WebServerOptions.frameSink`). */
  readonly sink: FrameLogSink;
  /** Flush and close the file. Idempotent; resolves once the stream is done. */
  close(): Promise<void>;
}

/**
 * Open a JSONL recorder under `cacheDir`. The filename embeds a filesystem-safe
 * ISO timestamp and the pid, so concurrent debug servers never collide.
 */
export function createJsonlRecorder(cacheDir: string): JsonlRecorder {
  const dir = join(cacheDir, "recordings");
  // The timestamp keeps its ISO field order but swaps `:`/`.` (illegal or
  // confusing in filenames) for `-`.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${process.pid}.jsonl`);

  let stream: WriteStream | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(path, { flags: "a" });
    // A stream error (disk full, dir removed) must not crash the server; drop
    // the stream and let later writes no-op.
    stream.on("error", () => {
      stream = undefined;
    });
  } catch {
    stream = undefined;
  }

  return {
    path,
    sink: (entry) => {
      try {
        stream?.write(`${JSON.stringify(entry)}\n`);
      } catch {
        // best-effort: an unwritable recording never breaks the prompt path
      }
    },
    close: () =>
      new Promise((resolve) => {
        const open = stream;
        stream = undefined;
        if (!open) {
          resolve();
          return;
        }
        open.end(() => resolve());
      }),
  };
}
