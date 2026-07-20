/**
 * Vendor-agnostic helpers shared by `mint.ts` and `test-keys.ts`:
 * keys-file IO, a small logger, time helpers, and a flexible WebSocket probe.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { CACHE_DIR, KEYS_FILE, type KeysFile } from "./spec.ts";

// ── logging ────────────────────────────────────────────────────────────────

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
export const color = c;

export function heading(s: string): void {
  console.log(`\n${c.bold(c.cyan(`▐ ${s}`))}`);
}
export function ok(s: string): void {
  console.log(`  ${c.green("✔")} ${s}`);
}
export function fail(s: string): void {
  console.log(`  ${c.red("✗")} ${s}`);
}
export function info(s: string): void {
  console.log(`  ${c.dim("·")} ${c.dim(s)}`);
}
export function warn(s: string): void {
  console.log(`  ${c.yellow("!")} ${c.yellow(s)}`);
}

/** Redact a secret for logs: keep a short prefix, mask the rest. */
export function redact(secret: string): string {
  if (secret.length <= 10) return `${secret.slice(0, 3)}…`;
  return `${secret.slice(0, 8)}…(${secret.length} chars)`;
}

// ── time ─────────────────────────────────────────────────────────────────────

/** RFC3339 / ISO-8601 timestamp `secondsFromNow` in the future (or past if negative). */
export function isoIn(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

// ── keys file IO ─────────────────────────────────────────────────────────────

export function saveKeysFile(file: KeysFile): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(KEYS_FILE, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function loadKeysFile(): KeysFile {
  const raw = readFileSync(KEYS_FILE, "utf8");
  return JSON.parse(raw) as KeysFile;
}

// ── WebSocket probe ──────────────────────────────────────────────────────────

export interface WsProbeOptions {
  url: string;
  /** Handshake headers (e.g. `{ authorization: "Bearer …" }` or `{ "xi-api-key": … }`). */
  headers?: Record<string, string>;
  /** WS subprotocols (OpenAI realtime browser-style token auth rides here). */
  subprotocols?: string[];
  /** Frames to send once the socket opens (JSON-encoded). */
  onOpenSend?: unknown[];
  /** Overall timeout before we give up waiting for the first outcome. */
  timeoutMs?: number;
}

/**
 * The first thing that happens to a probed socket. This deliberately captures
 * the distinction both vendor reports flagged: an auth failure may reject the
 * HTTP upgrade (`http-error`, before `101`) OR open the socket and then arrive
 * as a `message` (`auth_error` frame) / a non-1000 `closed`.
 */
export interface WsProbeResult {
  outcome: "message" | "closed" | "http-error" | "error" | "timeout";
  opened: boolean;
  /** Parsed first inbound frame (JSON if parseable, else the raw string). */
  firstMessage?: unknown;
  rawMessage?: string;
  closeCode?: number;
  closeReason?: string;
  httpStatus?: number;
  httpBody?: string;
  errorMessage?: string;
  elapsedMs: number;
}

/**
 * Open a WebSocket and resolve on the FIRST of: first inbound frame, close,
 * failed HTTP upgrade, socket error, or timeout. Always closes the socket
 * before resolving. Never rejects — every outcome is a resolved result.
 */
export function probeWs(opts: WsProbeOptions): Promise<WsProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  return new Promise<WsProbeResult>((resolve) => {
    let settled = false;
    let opened = false;
    const socket = new WebSocket(opts.url, opts.subprotocols ?? [], {
      headers: opts.headers,
    });

    const done = (r: Omit<WsProbeResult, "elapsedMs" | "opened">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
      resolve({ ...r, opened, elapsedMs: Date.now() - started });
    };

    const timer = setTimeout(() => done({ outcome: "timeout" }), timeoutMs);

    socket.on("open", () => {
      opened = true;
      for (const frame of opts.onOpenSend ?? []) {
        socket.send(JSON.stringify(frame));
      }
    });

    socket.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // leave as raw string
      }
      done({ outcome: "message", firstMessage: parsed, rawMessage: raw });
    });

    // `ws` fires this when the server answers the Upgrade with a non-101 status.
    socket.on("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () =>
        done({
          outcome: "http-error",
          httpStatus: res.statusCode,
          httpBody: Buffer.concat(chunks).toString("utf8").slice(0, 500),
        }),
      );
    });

    socket.on("close", (code, reason) =>
      done({ outcome: "closed", closeCode: code, closeReason: reason.toString("utf8") }),
    );

    socket.on("error", (err) =>
      done({ outcome: "error", errorMessage: String(err?.message ?? err) }),
    );
  });
}
