import { describe, expect, it } from "vitest";
import { probeLauncher } from "./probe";
import { createMessageDecoder, frameMessage, type LspChild } from "./proxy";

type JsonRpc = Record<string, unknown>;

const CAPS = {
  documentSymbolProvider: true,
  hoverProvider: true,
  definitionProvider: true,
};

/**
 * A fake language-server child: it decodes the framed JSON-RPC the probe writes
 * to stdin, feeds each message to `handler`, and frames whatever the handler
 * returns back out through stdout — reusing the package's own framing so the
 * probe's real decoder round-trips it.
 */
function makeFakeServer(handler: (msg: JsonRpc) => JsonRpc | undefined): LspChild {
  let onData: ((chunk: Buffer) => void) | undefined;
  let onExit: ((code: number | null) => void) | undefined;
  const decoder = createMessageDecoder((json) => {
    const response = handler(JSON.parse(json) as JsonRpc);
    if (response !== undefined) {
      queueMicrotask(() => onData?.(frameMessage(JSON.stringify(response))));
    }
  });
  return {
    stdin: {
      write: (data) => decoder.push(data),
    },
    stdout: {
      onData: (cb) => {
        onData = cb;
      },
    },
    onError: () => {},
    onExit: (cb) => {
      onExit = cb;
    },
    kill: () => onExit?.(0),
  };
}

const sampleOpts = {
  launch: { command: "fake", args: [], cwd: "/tmp" },
  rootUri: "file:///tmp",
  sample: { uri: "file:///tmp/a.ts", languageId: "typescript", text: "const x = 1;\n" },
};

describe("probeLauncher", () => {
  it("reports ok with capabilities and per-op results against a compliant server", async () => {
    const handler = (m: JsonRpc): JsonRpc | undefined => {
      const { method, id } = m;
      if (method === "initialize") {
        return { jsonrpc: "2.0", id, result: { capabilities: CAPS } };
      }
      if (method === "textDocument/documentSymbol") {
        return { jsonrpc: "2.0", id, result: [{ name: "x", kind: 13 }] };
      }
      if (method === "shutdown") {
        return { jsonrpc: "2.0", id, result: null };
      }
      // initialized / didOpen / exit are notifications — no reply.
      return undefined;
    };

    const report = await probeLauncher({
      ...sampleOpts,
      ops: ["documentSymbol"],
      timeoutMs: 1000,
      spawn: () => makeFakeServer(handler),
    });

    expect(report.ok).toBe(true);
    expect(report.serverCapabilities).toEqual(CAPS);

    const byOp = Object.fromEntries(report.results.map((r) => [r.op, r]));
    expect(byOp.initialize?.ok).toBe(true);
    expect(byOp.didOpen?.ok).toBe(true);
    expect(byOp.documentSymbol?.ok).toBe(true);
    expect(byOp.documentSymbol?.summary).toBe("1 symbols");
  });

  it("reports a timeout when the server never responds", async () => {
    const silent: LspChild = {
      stdin: { write: () => {} },
      stdout: { onData: () => {} },
      onError: () => {},
      onExit: () => {},
      kill: () => {},
    };

    const report = await probeLauncher({
      ...sampleOpts,
      ops: ["documentSymbol"],
      timeoutMs: 300,
      spawn: () => silent,
    });

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/timed out/);
  });
});
