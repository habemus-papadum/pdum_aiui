/**
 * probe.ts — a self-test for an LSP launcher.
 *
 * The setup flow's whole point is to *not* hand the user an untested launcher.
 * `probeLauncher` spawns the launcher, runs a real LSP handshake
 * (initialize → initialized → didOpen), exercises a few read-only operations,
 * and returns a structured report. `aiui setup-lsp` (via `aiui lsp probe`) runs
 * this against every launcher it writes and refuses to record one that fails.
 *
 * It is a genuine LSP client (real JSON-RPC over the child's stdio) — the same
 * "no veneer" contract as the browser client, just headless and minimal.
 */
import {
  createMessageDecoder,
  frameMessage,
  type LspLaunch,
  type SpawnLspChild,
  spawnNodeChild,
} from "./proxy";

export type ProbeOp = "hover" | "documentSymbol" | "definition" | "references" | "foldingRange";

export interface ProbeOptions {
  launch: LspLaunch;
  /** `file://` URI of the project root. */
  rootUri: string;
  /** A real file from the project to open + query. */
  sample: { uri: string; languageId: string; text: string };
  /** 0-based position to aim hover/definition/references at (a symbol). */
  position?: { line: number; character: number };
  /** Which operations to exercise beyond the mandatory initialize/didOpen. */
  ops?: ProbeOp[];
  /** `initializationOptions` to send (mirrors what the manifest records). */
  initializationOptions?: Record<string, unknown>;
  timeoutMs?: number;
  /** Injectable spawn for tests. */
  spawn?: SpawnLspChild;
}

export interface ProbeOpResult {
  op: string;
  ok: boolean;
  summary?: string;
  error?: string;
}

export interface ProbeReport {
  ok: boolean;
  /** The server's advertised capabilities (definitionProvider, etc.). */
  serverCapabilities?: Record<string, unknown>;
  results: ProbeOpResult[];
  /** Stderr/diagnostic lines, for debugging a failure. */
  log: string[];
  error?: string;
}

const DEFAULT_TIMEOUT = 20_000;

/** Run the handshake + requested ops against a launcher. Never throws — every
 * failure mode comes back in the report (that is what the CLI/skill wants). */
export async function probeLauncher(opts: ProbeOptions): Promise<ProbeReport> {
  const spawnChild = opts.spawn ?? spawnNodeChild;
  const log: string[] = [];
  const results: ProbeOpResult[] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let seq = 0;

  let child: ReturnType<SpawnLspChild>;
  try {
    child = spawnChild(opts.launch);
  } catch (err) {
    return { ok: false, results, log, error: `spawn failed: ${msg(err)}` };
  }
  const cleanup = () => {
    try {
      child.kill();
    } catch {
      // already dead
    }
  };

  const send = (obj: Record<string, unknown>) =>
    child.stdin?.write(frameMessage(JSON.stringify(obj)));
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });

  const decoder = createMessageDecoder((json) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof m.id === "number" && ("result" in m || "error" in m)) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error((m.error as { message?: string }).message ?? "lsp error"));
      else p.resolve(m.result);
    } else if (typeof m.method === "string" && "id" in m) {
      // Answer server→client requests so the server doesn't stall.
      const result =
        m.method === "workspace/configuration"
          ? ((m.params as { items?: unknown[] })?.items ?? []).map(() => ({}))
          : null;
      send({ jsonrpc: "2.0", id: m.id, result });
    }
  });
  child.stdout?.onData((c) => decoder.push(c));
  // The server's diagnostic channel: capture for the report (it's the whole
  // point of `log`), and keep the pipe drained so a chatty server can't block.
  child.stderr?.onData((c) => {
    const text = c.toString("utf8").trimEnd();
    if (text) log.push(text);
  });

  // A server that fails to start or dies mid-probe must settle the probe NOW
  // with the real cause — not leave the pending request hanging until the
  // timeout fires and misreports the most common setup failure as "timed out".
  let failFast: ((e: Error) => void) | undefined;
  const childFailure = new Promise<never>((_, reject) => {
    failFast = reject;
  });
  child.onError((e) => {
    log.push(`error: ${e.message}`);
    failFast?.(new Error(`server failed to start: ${e.message}`));
  });
  child.onExit((code) => {
    if (code && code !== 0) {
      log.push(`server exited with code ${code}`);
      failFast?.(new Error(`server exited with code ${code}`));
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`probe timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT}ms`)),
      opts.timeoutMs ?? DEFAULT_TIMEOUT,
    );
  });

  try {
    const report = await Promise.race([run(), timeout, childFailure]);
    return report;
  } catch (err) {
    return { ok: false, results, log, error: msg(err) };
  } finally {
    // Clear the pending timer (else it keeps the event loop alive for the full
    // timeout after a fast success) and kill the child.
    if (timer) clearTimeout(timer);
    cleanup();
  }

  async function run(): Promise<ProbeReport> {
    const init = (await request("initialize", {
      processId: null,
      clientInfo: { name: "aiui-lsp-probe" },
      rootUri: opts.rootUri,
      workspaceFolders: [{ uri: opts.rootUri, name: "workspace" }],
      capabilities: probeCapabilities(),
      ...(opts.initializationOptions ? { initializationOptions: opts.initializationOptions } : {}),
    })) as { capabilities?: Record<string, unknown> };
    results.push({ op: "initialize", ok: true, summary: capsSummary(init?.capabilities) });
    notify("initialized", {});

    notify("textDocument/didOpen", {
      textDocument: {
        uri: opts.sample.uri,
        languageId: opts.sample.languageId,
        version: 1,
        text: opts.sample.text,
      },
    });
    results.push({ op: "didOpen", ok: true });

    for (const op of opts.ops ?? []) {
      try {
        results.push(await runOp(op, init?.capabilities));
      } catch (err) {
        results.push({ op, ok: false, error: msg(err) });
      }
    }

    // Graceful shutdown (best-effort; some servers exit on their own).
    try {
      await Promise.race([request("shutdown", null), sleep(500)]);
      notify("exit", null);
    } catch {
      // ignore — we kill the child anyway
    }

    const ok = results.every((r) => r.ok);
    return {
      ok,
      ...(init?.capabilities ? { serverCapabilities: init.capabilities } : {}),
      results,
      log,
    };
  }

  async function runOp(
    op: ProbeOp,
    caps: Record<string, unknown> | undefined,
  ): Promise<ProbeOpResult> {
    const td = { textDocument: { uri: opts.sample.uri } };
    const pos = opts.position ?? { line: 0, character: 0 };
    switch (op) {
      case "documentSymbol": {
        const r = (await request("textDocument/documentSymbol", td)) as unknown[] | null;
        return { op, ok: Array.isArray(r), summary: `${r?.length ?? 0} symbols` };
      }
      case "foldingRange": {
        const r = (await request("textDocument/foldingRange", td)) as unknown[] | null;
        return { op, ok: Array.isArray(r), summary: `${r?.length ?? 0} ranges` };
      }
      case "hover": {
        const r = (await request("textDocument/hover", { ...td, position: pos })) as {
          contents?: unknown;
        } | null;
        return {
          op,
          ok: !!caps?.hoverProvider,
          summary: r?.contents ? "has hover" : "no hover at position",
        };
      }
      case "definition": {
        const r = (await request("textDocument/definition", { ...td, position: pos })) as unknown;
        const n = Array.isArray(r) ? r.length : r ? 1 : 0;
        return { op, ok: !!caps?.definitionProvider, summary: `${n} location(s)` };
      }
      case "references": {
        const r = (await request("textDocument/references", {
          ...td,
          position: pos,
          context: { includeDeclaration: true },
        })) as unknown[] | null;
        return { op, ok: !!caps?.referencesProvider, summary: `${r?.length ?? 0} reference(s)` };
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function capsSummary(caps: Record<string, unknown> | undefined): string {
  if (!caps) return "no capabilities";
  const flags = [
    "definitionProvider",
    "referencesProvider",
    "hoverProvider",
    "documentSymbolProvider",
    "foldingRangeProvider",
    "workspaceSymbolProvider",
  ].filter((k) => caps[k]);
  return flags.join(", ") || "minimal";
}

function probeCapabilities(): Record<string, unknown> {
  return {
    textDocument: {
      synchronization: { didSave: false },
      hover: { contentFormat: ["markdown", "plaintext"] },
      definition: { linkSupport: true },
      references: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      foldingRange: { lineFoldingOnly: true },
      publishDiagnostics: {},
    },
    workspace: { symbol: {}, configuration: true, workspaceFolders: true },
  };
}
