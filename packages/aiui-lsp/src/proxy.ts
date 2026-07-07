/**
 * proxy.ts — the byte relay between a browser LSP client and a real language
 * server subprocess.
 *
 * The load-bearing constraint (code-reader proposal, §"No veneer"): *nothing in
 * the middle rewrites LSP semantics*. This converts **transport framing only** —
 * the server speaks `Content-Length`-framed JSON-RPC over stdio; the browser
 * speaks one JSON message per websocket text frame. Frame ↔ deframe, both ways.
 *
 * It spawns whatever `LspLaunch` says — for this subsystem that is the project's
 * executable launcher (`.aiui/lsp/<lang>/launch`), so the proxy is fully
 * language-agnostic: add a language by writing a launcher, not by editing code.
 *
 * Concurrency: **one child per attached socket**, spawned on attach, killed on
 * close — sidesteps multiplexing JSON-RPC ids across clients. A process per open
 * reader is fine for a loopback cockpit. Robustness mirrors the channel's hot.ts:
 * spawn error / child exit is logged and closes the socket; children are killed
 * on close and `dispose()`; EPIPE is swallowed. Nothing here crashes the process.
 */
import { spawn } from "node:child_process";

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// --- framing (pure, exhaustively unit-tested) ------------------------------

/** Prefix a JSON-RPC body with its `Content-Length` header. The length is the
 * body's **byte** length (UTF-8) — differs from char length for any multi-byte
 * codepoint, the classic framing bug this guards against. */
export function frameMessage(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

function parseContentLength(headerText: string): number | undefined {
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
      const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
      return Number.isNaN(value) ? undefined : value;
    }
  }
  return undefined;
}

export interface MessageDecoder {
  /** Feed raw bytes; emits `onMessage` for each complete JSON-RPC body. */
  push(chunk: Buffer): void;
}

/**
 * A streaming `Content-Length` deframer. Handles the three things that bite:
 * messages split across chunks, several messages coalesced in one chunk, and
 * byte-length (not char-length) bodies.
 */
export function createMessageDecoder(onMessage: (json: string) => void): MessageDecoder {
  let buffer: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // header incomplete
        const length = parseContentLength(buffer.subarray(0, headerEnd).toString("ascii"));
        if (length === undefined) {
          buffer = buffer.subarray(headerEnd + 4); // malformed: drop + resync
          continue;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (buffer.length < bodyEnd) return; // body incomplete
        onMessage(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
        buffer = buffer.subarray(bodyEnd);
      }
    },
  };
}

// --- child abstraction (injectable, so tests need no real server) ----------

/** The minimal child-process surface the relay uses. A test supplies a fake. */
export interface LspChild {
  readonly stdin: { write(data: Buffer): void } | null;
  readonly stdout: { onData(cb: (chunk: Buffer) => void): void } | null;
  /** Diagnostic output. Optional (test fakes may omit it) — but a host SHOULD
   * drain it: an unread stderr pipe backs up (~64KB) and blocks a chatty server. */
  readonly stderr?: { onData(cb: (chunk: Buffer) => void): void } | null;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** How to launch a language server: an argv + cwd (+ optional env overlay). For
 * this subsystem `command` is the executable launcher path and `args` is empty. */
export interface LspLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

/** Spawn a language server child from a launch spec. */
export type SpawnLspChild = (launch: LspLaunch) => LspChild;

/** The real spawn: node child_process wrapped in the {@link LspChild} shape. */
export const spawnNodeChild: SpawnLspChild = (launch) => {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    ...(launch.env ? { env: { ...process.env, ...launch.env } } : {}),
  });
  // A dead pipe surfaces as an async 'error' on stdin; swallow it so a late
  // write after the server exits can't take the process down (EPIPE).
  child.stdin?.on("error", () => {});
  return {
    stdin: child.stdin ? { write: (data: Buffer) => void child.stdin?.write(data) } : null,
    stdout: child.stdout ? { onData: (cb) => void child.stdout?.on("data", cb) } : null,
    stderr: child.stderr ? { onData: (cb) => void child.stderr?.on("data", cb) } : null,
    onError: (cb) => void child.on("error", cb),
    onExit: (cb) => void child.on("exit", (code) => cb(code)),
    kill: () => {
      // SIGTERM first (the launcher `exec`s the real server, so it lands there);
      // escalate to SIGKILL for a server that traps or ignores it. `unref` so a
      // pending escalation never holds a CLI open.
      child.kill();
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 3000);
      escalate.unref?.();
      child.once("exit", () => clearTimeout(escalate));
    },
  };
};

// --- the relay -------------------------------------------------------------

/** The minimal socket surface the relay drives — real `ws` or a test fake. */
export interface LspSocket {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface LspProxyOptions {
  /** Line logger for lifecycle/errors (defaults to a no-op). */
  onLog?: (line: string) => void;
  /** Injectable spawn (tests feed a fake child); defaults to the real one. */
  spawn?: SpawnLspChild;
  /** Label for log lines (e.g. the language). */
  label?: string;
}

export interface LspProxy {
  /** Spawn a private child for `socket` and relay bytes both ways. */
  attach(socket: LspSocket): void;
  /** Kill every live child (called on host shutdown). */
  dispose(): void;
}

/**
 * Create a relay manager for one launch spec. Each {@link LspProxy.attach}
 * spawns a fresh child bound to that socket; the child dies with the socket.
 */
export function createLspProxy(launch: LspLaunch, opts: LspProxyOptions = {}): LspProxy {
  const log = opts.onLog ?? (() => {});
  const spawnChild = opts.spawn ?? spawnNodeChild;
  const label = opts.label ?? launch.command;
  const live = new Set<LspChild>();

  const attach = (socket: LspSocket): void => {
    let child: LspChild;
    try {
      child = spawnChild(launch);
    } catch (err) {
      log(`lsp(${label}): spawn failed — ${errMsg(err)}`);
      socket.close();
      return;
    }
    live.add(child);

    let torn = false;
    const teardown = (): void => {
      if (torn) return;
      torn = true;
      live.delete(child);
      try {
        child.kill();
      } catch {
        // already dead
      }
    };

    // server → browser: deframe stdout, forward each message as a ws text frame.
    const decoder = createMessageDecoder((json) => {
      try {
        socket.send(json);
      } catch {
        // socket already closing — the close handler tears down
      }
    });
    child.stdout?.onData((chunk) => decoder.push(chunk));

    // Drain stderr into the log: it's the server's diagnostic channel, and an
    // unread pipe would back up and block a chatty server mid-handshake.
    child.stderr?.onData((chunk) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text) log(`lsp(${label}) stderr: ${text}`);
    });

    // browser → server: frame each ws text frame and write to stdin.
    socket.onMessage((data) => {
      try {
        child.stdin?.write(frameMessage(data));
      } catch (err) {
        log(`lsp(${label}): stdin write failed — ${errMsg(err)}`);
      }
    });

    socket.onClose(() => teardown());
    child.onError((err) => {
      log(`lsp(${label}): server error — ${errMsg(err)}`);
      teardown();
      socket.close();
    });
    child.onExit((code) => {
      log(`lsp(${label}): server exited (code ${code ?? "null"})`);
      teardown();
      socket.close();
    });
  };

  const dispose = (): void => {
    for (const child of [...live]) {
      live.delete(child);
      try {
        child.kill();
      } catch {
        // already dead
      }
    }
  };

  return { attach, dispose };
}
