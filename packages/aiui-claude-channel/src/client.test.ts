import { afterEach, describe, expect, it } from "vitest";
import type { ChannelFormat } from "./channel";
import { type ChannelClient, connectChannelClient } from "./client";
import { rawCodec } from "./codec";
import { defaultFormats } from "./processors";
import { startWebServer, type WebServer } from "./web";

/**
 * A raw-binary format: it accumulates opaque byte chunks and, on fin, reports
 * the exact bytes it received (as a comma-joined list) so a test can prove the
 * bytes survived untouched — impossible had they been base64'd or JSON-mangled.
 */
const rawEchoFormat: ChannelFormat = {
  codec: rawCodec,
  createProcessor: (ctx) => {
    const chunks: Uint8Array[] = [];
    return {
      onMessage(payload, meta) {
        chunks.push(payload as Uint8Array);
        if (meta.fin) {
          ctx.sendPrompt(Array.from(Buffer.concat(chunks)).join(","));
          ctx.close();
        }
      },
    };
  },
};

const formats = new Map([...defaultFormats(), ["raw-echo", rawEchoFormat]]);

describe("connectChannelClient", () => {
  let server: WebServer | undefined;
  let client: ChannelClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server?.close();
    server = undefined;
  });

  const start = async (): Promise<{ prompts: string[]; url: string }> => {
    const prompts: string[] = [];
    server = await startWebServer({ formats, onPrompt: (text) => void prompts.push(text) });
    return { prompts, url: `ws://127.0.0.1:${server.port}/ws` };
  };

  it("opens a thread and delivers text-concat prompts", async () => {
    const { prompts, url } = await start();
    client = await connectChannelClient({ url, format: "text-concat" });

    const thread = client.openThread();
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await thread.send({ text: "Hello, " })).toMatchObject({ ok: true, threadId: thread.id });
    await thread.send({ text: "world" });
    expect(await thread.finish()).toMatchObject({ ok: true, threadId: thread.id, closed: true });
    expect(prompts).toEqual(["Hello, world"]);
  });

  it("carries raw binary payloads through unchanged (no base64)", async () => {
    const { prompts, url } = await start();
    client = await connectChannelClient({ url, format: "raw-echo", codec: rawCodec });

    const thread = client.openThread();
    await thread.send(new Uint8Array([0, 1, 2]));
    await thread.finish(new Uint8Array([255, 254, 253]));
    expect(prompts).toEqual(["0,1,2,255,254,253"]);
  });

  it("runs several threads over one connection", async () => {
    const { prompts, url } = await start();
    client = await connectChannelClient({ url, format: "text-concat" });

    const a = client.openThread("a");
    const b = client.openThread("b");
    await a.send({ text: "from a" });
    await b.send({ text: "from b" });
    await b.finish();
    await a.finish();
    expect(prompts).toEqual(["from b", "from a"]);
  });

  it("rejects when the server does not know the format", async () => {
    const { url } = await start();
    await expect(connectChannelClient({ url, format: "no-such-format" })).rejects.toThrow(
      /unknown format "no-such-format"/,
    );
  });

  it("rejects when the connection cannot be made", async () => {
    await expect(
      connectChannelClient({ url: "ws://127.0.0.1:1/ws", format: "text-concat" }),
    ).rejects.toThrow();
  });
});
