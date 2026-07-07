import { describe, expect, it } from "vitest";
import {
  createLspProxy,
  createMessageDecoder,
  frameMessage,
  type LspChild,
  type LspLaunch,
  type LspSocket,
} from "./proxy";

// --- frameMessage ----------------------------------------------------------

describe("frameMessage", () => {
  it("uses a byte-length Content-Length header, not char length", () => {
    const body = "café ☕ 日本語";
    const byteLen = Buffer.byteLength(body, "utf8");
    // Precondition: the string genuinely has multi-byte codepoints.
    expect(byteLen).not.toBe(body.length);

    const frame = frameMessage(body);
    const header = `Content-Length: ${byteLen}\r\n\r\n`;
    const headerLen = Buffer.byteLength(header, "ascii");

    // Header is exactly `Content-Length: N\r\n\r\n` + body, nothing more.
    expect(frame.subarray(0, headerLen).toString("ascii")).toBe(header);
    expect(frame.subarray(headerLen).toString("utf8")).toBe(body);
    expect(frame.byteLength).toBe(headerLen + byteLen);
  });

  it("frames an ASCII body with a length equal to its char count", () => {
    const frame = frameMessage("hi");
    expect(frame.toString("utf8")).toBe("Content-Length: 2\r\n\r\nhi");
  });
});

// --- createMessageDecoder --------------------------------------------------

function collect(): { decoder: ReturnType<typeof createMessageDecoder>; out: string[] } {
  const out: string[] = [];
  return { decoder: createMessageDecoder((json) => out.push(json)), out };
}

describe("createMessageDecoder", () => {
  it("(a) decodes a single message", () => {
    const { decoder, out } = collect();
    decoder.push(frameMessage("solo"));
    expect(out).toEqual(["solo"]);
  });

  it("(b) decodes a message split across two push calls", () => {
    const { decoder, out } = collect();
    const frame = frameMessage("hello");
    // Split inside the body so the first chunk has a complete header but a
    // partial body — the harder of the two boundaries.
    decoder.push(frame.subarray(0, frame.length - 2));
    expect(out).toEqual([]);
    decoder.push(frame.subarray(frame.length - 2));
    expect(out).toEqual(["hello"]);
  });

  it("(c) decodes two messages coalesced in one chunk", () => {
    const { decoder, out } = collect();
    decoder.push(Buffer.concat([frameMessage("one"), frameMessage("two")]));
    expect(out).toEqual(["one", "two"]);
  });

  it("(d) decodes a multi-byte body where byte length != char length", () => {
    const { decoder, out } = collect();
    const body = "λ→π 你好";
    expect(Buffer.byteLength(body, "utf8")).not.toBe(body.length);
    decoder.push(frameMessage(body));
    expect(out).toEqual([body]);
  });

  it("(e) drops a header block with no Content-Length and resyncs to the next message", () => {
    const { decoder, out } = collect();
    const malformed = Buffer.from("X-Bad: header\r\n\r\n", "ascii");
    decoder.push(Buffer.concat([malformed, frameMessage('{"ok":true}')]));
    expect(out).toEqual(['{"ok":true}']);
  });

  it("round-trips framing → decoding byte-by-byte (including an empty body)", () => {
    const messages = ['{"jsonrpc":"2.0","id":1}', "café ☕ 日本語", ""];
    const all = Buffer.concat(messages.map(frameMessage));
    const { decoder, out } = collect();
    for (const byte of all) decoder.push(Buffer.from([byte]));
    expect(out).toEqual(messages);
  });
});

// --- createLspProxy (fake child + fake socket) -----------------------------

const launch: LspLaunch = { command: "launcher", args: [], cwd: "/tmp" };

interface FakeChild {
  child: LspChild;
  readonly writes: Buffer[];
  readonly killCount: number;
  emitData(chunk: Buffer): void;
  emitError(err: Error): void;
  emitExit(code: number | null): void;
}

function makeFakeChild(): FakeChild {
  const writes: Buffer[] = [];
  let dataCb: ((chunk: Buffer) => void) | undefined;
  let errorCb: ((err: Error) => void) | undefined;
  let exitCb: ((code: number | null) => void) | undefined;
  let killCount = 0;
  const child: LspChild = {
    stdin: {
      write: (data) => {
        writes.push(data);
      },
    },
    stdout: {
      onData: (cb) => {
        dataCb = cb;
      },
    },
    onError: (cb) => {
      errorCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: () => {
      killCount += 1;
    },
  };
  return {
    child,
    writes,
    get killCount() {
      return killCount;
    },
    emitData: (chunk) => dataCb?.(chunk),
    emitError: (err) => errorCb?.(err),
    emitExit: (code) => exitCb?.(code),
  };
}

interface FakeSocket {
  socket: LspSocket;
  readonly sent: string[];
  readonly closeCount: number;
  emitMessage(data: string): void;
  emitClose(): void;
}

function makeFakeSocket(): FakeSocket {
  const sent: string[] = [];
  let msgCb: ((data: string) => void) | undefined;
  let closeCb: (() => void) | undefined;
  let closeCount = 0;
  const socket: LspSocket = {
    send: (data) => {
      sent.push(data);
    },
    onMessage: (cb) => {
      msgCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: () => {
      closeCount += 1;
    },
  };
  return {
    socket,
    sent,
    get closeCount() {
      return closeCount;
    },
    emitMessage: (data) => msgCb?.(data),
    emitClose: () => closeCb?.(),
  };
}

describe("createLspProxy", () => {
  it("frames browser→server messages onto the child's stdin", () => {
    const fc = makeFakeChild();
    const fs = makeFakeSocket();
    createLspProxy(launch, { spawn: () => fc.child }).attach(fs.socket);

    const payload = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
    fs.emitMessage(payload);

    expect(fc.writes).toHaveLength(1);
    expect(fc.writes[0].equals(frameMessage(payload))).toBe(true);
  });

  it("deframes server→browser bytes into websocket text frames", () => {
    const fc = makeFakeChild();
    const fs = makeFakeSocket();
    createLspProxy(launch, { spawn: () => fc.child }).attach(fs.socket);

    fc.emitData(frameMessage('{"result":1}'));
    // Two coalesced in one chunk should surface as two sends.
    fc.emitData(Buffer.concat([frameMessage('{"a":2}'), frameMessage('{"b":3}')]));

    expect(fs.sent).toEqual(['{"result":1}', '{"a":2}', '{"b":3}']);
  });

  it("kills the child when the socket closes", () => {
    const fc = makeFakeChild();
    const fs = makeFakeSocket();
    createLspProxy(launch, { spawn: () => fc.child }).attach(fs.socket);

    fs.emitClose();
    expect(fc.killCount).toBe(1);
  });

  it("kills the child and closes the socket when the child exits", () => {
    const fc = makeFakeChild();
    const fs = makeFakeSocket();
    createLspProxy(launch, { spawn: () => fc.child }).attach(fs.socket);

    fc.emitExit(1);
    expect(fc.killCount).toBe(1);
    expect(fs.closeCount).toBe(1);
  });

  it("kills the child and closes the socket on a child error", () => {
    const fc = makeFakeChild();
    const fs = makeFakeSocket();
    createLspProxy(launch, { spawn: () => fc.child }).attach(fs.socket);

    fc.emitError(new Error("kaboom"));
    expect(fc.killCount).toBe(1);
    expect(fs.closeCount).toBe(1);
  });

  it("kills live children on dispose()", () => {
    const fc = makeFakeChild();
    const fs = makeFakeSocket();
    const proxy = createLspProxy(launch, { spawn: () => fc.child });
    proxy.attach(fs.socket);

    proxy.dispose();
    expect(fc.killCount).toBe(1);
  });

  it("closes the socket without throwing when spawn fails", () => {
    const fs = makeFakeSocket();
    const logs: string[] = [];
    const proxy = createLspProxy(launch, {
      spawn: () => {
        throw new Error("boom");
      },
      onLog: (line) => logs.push(line),
    });

    expect(() => proxy.attach(fs.socket)).not.toThrow();
    expect(fs.closeCount).toBe(1);
    expect(logs.some((l) => /spawn failed/.test(l))).toBe(true);
  });
});
