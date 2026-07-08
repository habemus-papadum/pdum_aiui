/**
 * The channel's **diagnostic log file** — always-on, append-only JSONL under
 * `<cacheDir>/logs/`, one file per channel process.
 *
 * The channel usually runs as an MCP subprocess of Claude Code, where stderr
 * is effectively invisible; before this file existed, a server-side failure
 * (say, Gemini Live closing every session over a bad key) left nothing on disk
 * to read after the fact — the error push went to whichever page was connected
 * and evaporated with it. The log is the durable copy: lifecycle lines
 * (startup, reload, shutdown) written by the process entrypoints, plus every
 * `kind:"error"` push the web backend emits, captured via the existing
 * frame-log sink seam (frame-log.ts) — the same seam recording mode uses, so
 * nothing new touches the prompt path.
 *
 * Deliberately errors-only on the frame side: the full protocol stream is
 * `serve --record`'s job (recording.ts); this file must stay small enough to
 * `cat` after something breaks. Like tracing and recording, it is best-effort —
 * an unwritable disk never breaks the channel, the log is simply incomplete.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { FrameLogEntry, FrameLogSink } from "./frame-log";

/** One channel process's diagnostic log. */
export interface ChannelLog {
  /** Absolute path of the log file (printed at startup so it's findable). */
  readonly path: string;
  /** Append one line: `{at, label, ...data}`. Never throws. */
  log(label: string, data?: unknown): void;
  /**
   * A frame-log sink that appends every **error push** (`kind:"error"`) to the
   * log — attach as `WebServerOptions.frameSink` (compose with the recorder's
   * sink when both are on).
   */
  readonly frameSink: FrameLogSink;
  /** Flush and close the file. Idempotent; resolves once the stream is done. */
  close(): Promise<void>;
}

/** Whether a frame-log entry is a server → client error push. */
function isErrorPush(entry: FrameLogEntry): boolean {
  return (
    entry.dir === "out" &&
    entry.label === "push error" &&
    entry.data !== null &&
    typeof entry.data === "object"
  );
}

/**
 * Open the diagnostic log under `cacheDir`. The filename embeds a
 * filesystem-safe ISO timestamp and the pid (recording.ts's convention), so
 * concurrent channels never collide.
 */
export function createChannelLog(cacheDir: string): ChannelLog {
  const dir = join(cacheDir, "logs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `channel-${stamp}-${process.pid}.jsonl`);

  let stream: WriteStream | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    stream = createWriteStream(path, { flags: "a" });
    stream.on("error", () => {
      stream = undefined;
    });
  } catch {
    stream = undefined;
  }

  const log = (label: string, data?: unknown): void => {
    try {
      stream?.write(
        `${JSON.stringify({ at: new Date().toISOString(), label, ...(data !== undefined ? { data } : {}) })}\n`,
      );
    } catch {
      // best-effort: an unwritable log never breaks the prompt path
    }
  };

  return {
    path,
    log,
    frameSink: (entry) => {
      if (isErrorPush(entry)) {
        log("error push", entry.data);
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
