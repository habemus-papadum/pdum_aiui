/**
 * `aiui-claude-channel serve` — a standalone debug channel server that can
 * **never reach an agent**. For developing and testing clients (the web intent
 * tool, a debug harness) against the real wire protocol, lowering pipeline, and
 * trace/debug tooling without a Claude Code session anywhere in the loop.
 *
 * The isolation is structural, not a flag check:
 *
 *  - **No MCP server, no stdio transport.** Unlike `mcp` (see mcp.ts), nothing
 *    here can emit a `notifications/claude/channel` — lowered prompts land on
 *    **stdout** as delimited blocks instead. There is no code path to a
 *    session.
 *  - **Registered as `debug`.** The server joins the shared registry like a
 *    real one (so selectors — `quick`, `aiui vite`, the VS Code extension —
 *    can offer it), but its entry carries `debug: true` and an optional
 *    display `--name` (e.g. "aiui debug"). Every selector marks such entries,
 *    and nothing *auto*-picks one (see select.ts): connecting a tool to a
 *    server that answers to nobody is always a human's deliberate choice.
 *
 * Everything else the real channel hosts is fair game — including the session
 * sidecars: like `mcp`, `serve` mounts the channel's `standardSidecars`
 * (intent, bar, pencil, console) by default, because a client under development
 * against this server needs the sidecar's endpoints on the very channel port it
 * is pointed at. (Callers — the tests — may inject their own set instead.)
 *
 * The server runs with `debug: true` (surfaced on `/health`,
 * `/debug/api/info`, and every hello ack, so clients can tell), traces to the
 * project-local cache as usual, and — with `--record` — appends every
 * frame-log entry as JSONL under `.aiui-cache/recordings/` (see recording.ts).
 * It binds an OS-assigned loopback port unless `--port` pins one (the
 * debug harness pins its channel to a fixed port so a human always knows where it
 * is); either way the ready line below carries the actual port, and a pinned
 * port that is already taken fails loudly instead of drifting.
 *
 * stdout protocol (stderr carries all progress/errors): the first line,
 * printed exactly once when the server is ready, is machine-parseable —
 *
 *   AIUI_CHANNEL_SERVE {"port":<n>,"pid":<n>,"debug":true}
 *
 * — and each lowered prompt then prints as
 *
 *   --- lowered prompt ---
 *   <the prompt text>
 *   --- meta ---            (only when the prompt carries attachment meta)
 *   <the meta, as JSON>
 *   --- end ---
 *
 * Page-tool transitions print the same delimited way — the register/unregister
 * events that `mcp` would voice to its session (as `tools/list_changed` + a
 * page-tools push) have no session here, so `serve` narrates them to stdout as
 * plain text: a diff of which `ns/tool` names appeared and disappeared, then
 * the current set.
 *
 *   --- page tools ---
 *   + morpho/plot_spectrum, morpho/set_range   (active tab: Morphogen)
 *   - aztec/step
 *   = now: morpho/plot_spectrum, morpho/set_range
 *   --- end ---
 *
 * Everything else worth watching narrates to **stderr** (never stdout — that is
 * the parseable protocol above), alongside the lifecycle lines: each connection
 * (`hello`), a *coalesced* summary of a thread's inbound media at `fin`
 * (audio/shots/events — byte counts only, so streaming binary never spams the
 * terminal), outbound `speech`, malformed frames, and a curated slice of
 * pipeline trace stages (linter, transcription, cost, the composed intent) that
 * otherwise live only in the on-disk trace. This is the register/unregister-style
 * visibility a debug run wants for the *rest* of the wire, without an agent.
 */

import { randomUUID } from "node:crypto";
import {
  parseStageLabel,
  type StageTag,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import { createChannelLog } from "../channel-log";
import type { FrameLogEntry } from "../frame-log";
import { createJsonlRecorder, type JsonlRecorder } from "../recording";
import { registerServer } from "../registry";
import { projectCacheDir, type TraceStageEvent } from "../trace";
import { startWebServer } from "../web";
import {
  type CommonChannelOptions,
  commonWebOptions,
  createShutdown,
  installExitBackstop,
  resolveSidecars,
  startStalenessWatch,
} from "./lifecycle";

export interface ServeOptions extends CommonChannelOptions {
  /**
   * Display name for the registry entry (`--name`, e.g. "aiui debug") —
   * how selectors title this server, since a debug server has no owning
   * Claude Code session to be recognised by.
   */
  name?: string;
  /** Record every frame-log entry as JSONL under `<cache>/recordings/`. */
  record?: boolean;
  /**
   * Cache root for traces/recordings. Defaults to the project-local cache
   * (`.aiui-cache/` under the cwd); tests point it at a temp dir.
   */
  cacheDir?: string;
  /**
   * Fixed loopback port to bind (`--port`). Omitted, the OS assigns a free one
   * — the right default for anything discovered via the ready line or the
   * registry. A supervisor that promises its user a *known* address (the
   * harness pins its channel to a fixed port) passes one; a taken port is then a
   * hard, explained failure instead of a silent drift (see {@link runServe}).
   */
  port?: number;
}

/**
 * Parse a `--port` value: an integer in [1, 65535], strictly decimal (no
 * `0x10`, no floats, no empty string — `Number()` alone is too forgiving for a
 * CLI flag). Throws with a human-readable message; the CLI layer (program.ts)
 * re-wraps it as a commander `InvalidArgumentError` so usage errors render as
 * usage errors.
 */
export function parsePort(value: string): number {
  const port = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`expected an integer between 1 and 65535, got "${value}"`);
  }
  return port;
}

/** Bytes as a compact human size for a narration line. */
function humanBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * The parsed-stage tags `serve` narrates: the pipeline events a debug run cares
 * about (the whole linter family, cost, the composed intent, the fin compose),
 * out of the many IRs a lowering run records. Membership over the shared
 * trace-stage vocabulary. (The old prefix ladder also matched a
 * `transcription…` label; no living writer produces one on this live tap — the
 * transcription spend narrates as `cost: realtime transcription seg_N` — so that
 * branch was unreachable and is dropped.)
 */
const NARRATED: ReadonlySet<StageTag> = new Set<StageTag>([
  "linter-open",
  "linter-disabled",
  "linter-note",
  "linter-tool-call",
  "linter-tool-result",
  "linter-transcript",
  "linter-label",
  "linter-selection",
  "linter-selection-retracted",
  "linter-turn-end",
  "linter-turn-merged",
  "linter-interrupted",
  "linter-go-away",
  "linter-transcript-timeout",
  "linter-error",
  "linter-close",
  "linter-control",
  "cost",
  "composed-intent",
  "fin-compose",
]);

/**
 * Whether a trace stage is one `serve` narrates. Exported for unit testing.
 */
export function isNarratedTraceStage(label: string): boolean {
  return NARRATED.has(parseStageLabel(label).t);
}

/** One line describing a `hello`: what format connected, its actor, and from where. */
function helloNarration(data: unknown): string {
  const env = data as
    | { format?: unknown; meta?: { tab?: { title?: unknown; url?: unknown }; actor?: unknown } }
    | undefined;
  const format = typeof env?.format === "string" ? env.format : "?";
  const actor = typeof env?.meta?.actor === "string" ? env.meta.actor : undefined;
  const tab = env?.meta?.tab;
  const where =
    typeof tab?.title === "string" ? tab.title : typeof tab?.url === "string" ? tab.url : undefined;
  return `connected: ${format}${actor !== undefined ? ` (${actor})` : ""}${
    where !== undefined ? ` — ${where}` : ""
  }`;
}

/** Per-thread running counts, coalesced into one summary line at the thread's fin. */
interface ThreadTally {
  audio: number;
  audioBytes: number;
  shots: number;
  shotBytes: number;
  events: number;
  context: number;
  data: number;
  dataBytes: number;
}

/**
 * A stateful narrator over the frame log. It prints a line per connection,
 * outbound speech, and malformed frame, and *coalesces* a thread's inbound media
 * into one summary at `fin` — so a talked turn's hundreds of audio frames never
 * spam the terminal. Binary is safe by construction: the frame log hands byte
 * counts, never payloads (frame-log.ts). The returned function is fed every
 * frame-log entry; it writes through `narrate`. Exported for unit testing.
 */
export function makeFrameNarrator(
  narrate: (message: string) => void,
): (entry: FrameLogEntry) => void {
  const threads = new Map<string, ThreadTally>();
  const tallyFor = (id: string): ThreadTally => {
    let tally = threads.get(id);
    if (tally === undefined) {
      tally = {
        audio: 0,
        audioBytes: 0,
        shots: 0,
        shotBytes: 0,
        events: 0,
        context: 0,
        data: 0,
        dataBytes: 0,
      };
      threads.set(id, tally);
    }
    return tally;
  };
  const flush = (id: string): void => {
    const tally = threads.get(id);
    if (tally === undefined) {
      return;
    }
    threads.delete(id);
    const parts: string[] = [];
    if (tally.audio > 0) parts.push(`${tally.audio} audio (~${humanBytes(tally.audioBytes)})`);
    if (tally.shots > 0) {
      parts.push(
        `${tally.shots} shot${tally.shots > 1 ? "s" : ""} (${humanBytes(tally.shotBytes)})`,
      );
    }
    if (tally.events > 0) parts.push(`${tally.events} event batch${tally.events > 1 ? "es" : ""}`);
    if (tally.context > 0) parts.push(`${tally.context} context`);
    if (tally.data > 0) parts.push(`${tally.data} data (~${humanBytes(tally.dataBytes)})`);
    if (parts.length > 0) {
      narrate(`thread ${id}: ${parts.join(", ")} → fin`);
    }
  };

  return (entry) => {
    const bytes = entry.bytes ?? 0;
    if (entry.dir === "out") {
      if (!entry.label.startsWith("push ")) {
        return; // acks are pure transport, not worth a line
      }
      const kind = entry.label.slice("push ".length);
      if (kind === "lowered-prompt") {
        return; // the prompt itself already lands on stdout via onPrompt
      }
      if (kind === "speech") {
        const chars = (entry.data as { data?: unknown } | undefined)?.data;
        narrate(`spoke${typeof chars === "number" ? ` (${chars} chars)` : ""}`);
      } else {
        narrate(`push ${kind}`);
      }
      return;
    }
    if (entry.label === "hello") {
      narrate(helloNarration(entry.data));
      return;
    }
    if (entry.label === "malformed frame") {
      narrate(`malformed frame (${bytes}B)`);
      return;
    }
    const id = entry.threadId ?? "-";
    const { label } = entry;
    if (label.startsWith("chunk audio")) {
      const tally = tallyFor(id);
      tally.audio += 1;
      tally.audioBytes += bytes;
    } else if (label.startsWith("chunk attachment")) {
      const tally = tallyFor(id);
      tally.shots += 1;
      tally.shotBytes += bytes;
    } else if (label.startsWith("chunk events")) {
      tallyFor(id).events += 1;
    } else if (label.startsWith("chunk context")) {
      tallyFor(id).context += 1;
    } else if (label.startsWith("data")) {
      const tally = tallyFor(id);
      tally.data += 1;
      tally.dataBytes += bytes;
    }
    // Only the THREAD terminator flushes — the bare intent-v1 `fin`, or the
    // text-concat `data (fin)`. A chunk's own `(fin)` (one audio segment ending)
    // is not the thread's end, so it must never print a partial summary.
    if (label === "fin" || label === "data (fin)") {
      flush(id);
    }
  };
}

/** The running debug server, for tests (the CLI just lets it run). */
export interface ServeHandle {
  /** The loopback port the server bound to. */
  port: number;
  /** Stop the server (and flush the recording, when one is on). Idempotent. */
  close(): Promise<void>;
}

/** Run the standalone debug channel server until a signal (or `close()`). */
export async function runServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const cacheDir = options.cacheDir ?? projectCacheDir();

  // The always-on diagnostic log (lifecycle + error pushes → <cache>/logs/),
  // same as `mcp` — a debug server's failures deserve a durable copy too.
  const channelLog = createChannelLog(cacheDir);

  let recorder: JsonlRecorder | undefined;
  if (options.record === true) {
    recorder = createJsonlRecorder(cacheDir);
    process.stderr.write(`[aiui-channel serve] recording frames to ${recorder.path}\n`);
  }

  // Host the channel's standard sidecar set (rooted at cwd), exactly like `mcp`
  // does — unless the caller injects its own (the tests pass `[]` to stay
  // hermetic). A failing mount is logged to stderr by `startWebServer`; stdout
  // stays the ready-line + lowered-prompt protocol.
  const sidecars = resolveSidecars(options);

  // Wire-event narration lands on stderr, next to the lifecycle lines (stdout is
  // the parseable protocol). `narrateFrame` coalesces per-thread media; the
  // trace sink narrates the pipeline stages that never reach the frame log.
  const narrate = (message: string): void => {
    process.stderr.write(`[aiui-channel serve] ${message}\n`);
  };
  const narrateFrame = makeFrameNarrator(narrate);

  let web: Awaited<ReturnType<typeof startWebServer>>;
  try {
    web = await startWebServer({
      // The whole point: the "session" is stdout. The delimiters make the block
      // easy to spot in a scrollback and easy to slice in a script.
      onPrompt: (text, meta) => {
        const lines = ["--- lowered prompt ---", text];
        if (meta !== undefined) {
          lines.push("--- meta ---", JSON.stringify(meta, null, 2));
        }
        lines.push("--- end ---");
        process.stdout.write(`${lines.join("\n")}\n`);
      },
      traceDir: cacheDir,
      debug: true,
      sidecars,
      // The recorder (when on), the diagnostic log, and the wire narrator all
      // share the one frame seam.
      frameSink: (entry) => {
        recorder?.sink(entry);
        channelLog.frameSink(entry);
        narrateFrame(entry);
      },
      // The live pipeline seam: narrate the curated stages (linter/cost/…) that
      // only ever land in the on-disk trace otherwise.
      traceSink: (event: TraceStageEvent) => {
        if (isNarratedTraceStage(event.stage.label)) {
          narrate(`${event.threadId} ${event.stage.label}`);
        }
      },
      ...commonWebOptions(options),
      ...(options.port !== undefined ? { port: options.port } : {}),
    });
  } catch (error) {
    await recorder?.close();
    await channelLog.close();
    // A fixed port exists to be predictable, so a collision must explain
    // itself — the raw EADDRINUSE stack says which port but not what to do.
    if (
      options.port !== undefined &&
      (error as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE"
    ) {
      throw new Error(
        `port ${options.port} is already in use — is another \`serve\` (or a debug harness, ` +
          "which spawns one) still running? Stop it, or pass a different --port.",
      );
    }
    throw error;
  }

  // Join the shared registry, marked as debug (see the header: selectors show
  // the mark, and never auto-pick a debug entry). Same lifecycle as `mcp`:
  // remove on close, with an exit backstop for paths that skip close().
  const registration = registerServer({
    port: web.port,
    tag: options.tag ?? randomUUID(),
    kind: "debug",
    assignedName: options.name,
  });
  installExitBackstop(registration);

  // Narrate page-tool transitions to stdout (see the header's stdout protocol).
  // The `/tools` websocket feeds `web.pageTools` here exactly as it would under
  // `mcp`; the only thing missing in a debug server is the MCP layer that would
  // voice the change to a session. So we diff the tool-name set on every change
  // and print what registered/unregistered — the register/unregister visibility
  // a debug run needs, without an agent on the wire.
  const toolNames = (): Set<string> =>
    new Set(web.pageTools.list().flatMap((reg) => reg.tools.map((t) => `${reg.ns}/${t.name}`)));
  const activeTabLabel = (): string | undefined => {
    const active = web.pageTools.list().find((reg) => reg.activeTab);
    return active ? (active.tab?.title ?? active.tab?.url ?? active.url) : undefined;
  };
  let lastTools = new Set<string>();
  const unsubscribeTools = web.pageTools.onChange(() => {
    const current = toolNames();
    const added = [...current].filter((n) => !lastTools.has(n));
    const removed = [...lastTools].filter((n) => !current.has(n));
    lastTools = current;
    // onChange coalesces by a content signature, but an active-tab flip changes
    // the signature without changing the tool set — nothing to narrate then.
    if (added.length === 0 && removed.length === 0) {
      return;
    }
    const label = activeTabLabel();
    const lines = ["--- page tools ---"];
    if (added.length > 0) {
      lines.push(`+ ${added.join(", ")}${label !== undefined ? ` (active tab: ${label})` : ""}`);
    }
    if (removed.length > 0) {
      lines.push(`- ${removed.join(", ")}`);
    }
    lines.push(`= now: ${current.size === 0 ? "none" : [...current].join(", ")}`, "--- end ---");
    process.stdout.write(`${lines.join("\n")}\n`);
  });

  // Dev-only STALENESS watch (AIUI_CHANNEL_WATCH=1, source only). Like `mcp`, no
  // hot-reload — but a debug server has no agent to tell, so the notice goes to
  // stderr, next to the wire narration. Restart the debug channel to apply edits.
  const stopWatch = startStalenessWatch({
    logPrefix: "[aiui-channel serve]",
    onStale: () => {
      narrate("source changed — this debug channel is now STALE; restart it to apply edits");
    },
  });

  // Only the web close is error-swallowed here (this twin lets a wedged recorder
  // or log close surface); channelLog.close() stays last, owned by createShutdown.
  const close = createShutdown({
    channelLog,
    registration,
    closers: [
      stopWatch,
      unsubscribeTools,
      () => web.close().catch(() => {}),
      () => recorder?.close(),
    ],
  });
  // `once`, not `on`: after our graceful pass the default handler is back, so
  // a second Ctrl-C during a wedged shutdown still kills the process.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      process.stderr.write(`[aiui-channel serve] ${signal} — shutting down\n`);
      void close().finally(() => process.exit(0));
    });
  }

  // The ready line: first on stdout, exactly once, machine-parseable. Nothing
  // can beat it there — prompts only flow once a client connects to the port
  // this very line announces.
  process.stdout.write(
    `AIUI_CHANNEL_SERVE ${JSON.stringify({ port: web.port, pid: process.pid, debug: true })}\n`,
  );
  process.stderr.write(
    `[aiui-channel serve] up — ${options.name !== undefined ? `name=${JSON.stringify(options.name)} ` : ""}` +
      `tag=${registration.entry.tag} pid=${process.pid} port=${web.port} cache=${cacheDir} ` +
      "(registered as debug, no MCP — prompts print to stdout)\n",
  );
  channelLog.log("up", {
    tag: registration.entry.tag,
    pid: process.pid,
    port: web.port,
    debug: true,
    ...(options.name !== undefined ? { name: options.name } : {}),
  });

  return { port: web.port, close };
}
