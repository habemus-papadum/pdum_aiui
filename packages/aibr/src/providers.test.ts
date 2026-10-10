import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture } from "../test/helpers.ts";
import { callProvider, discover, resolveProvider } from "./providers.ts";

describe("provider protocol", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.cleanup();
  });
  async function provider(body: string) {
    const script = join(f.root, "provider.mjs");
    await writeFile(
      script,
      `let data=''; for await (const chunk of process.stdin) data+=chunk; const request=JSON.parse(data); ${body}`,
    );
    return { command: process.execPath, args: [script], timeoutMs: 2000 };
  }
  it("discovers and connects with a versioned request, preserving opaque IDs", async () => {
    const p = await provider(
      `if(request.schemaVersion!==1)process.exit(3); console.error('diagnostic'); const response=request.operation==='discover'?{candidates:[{id:'host:project with spaces',label:'Work',host:'laptop'}]}:request.operation==='resolve'?{needsConnect:true}:{endpoint:'http://127.0.0.1:19222'}; console.log(JSON.stringify({schemaVersion:1,...response}));`,
    );
    expect((await discover(p))[0].id).toBe("host:project with spaces");
    expect(await resolveProvider(p, "host:project with spaces")).toBe("http://127.0.0.1:19222");
    await expect(resolveProvider(p, "id", false)).rejects.toThrow("needs a connection");
  });
  it("rejects malformed and duplicate results", async () => {
    await expect(
      discover(
        await provider(
          `console.log(JSON.stringify({schemaVersion:1,candidates:[{id:'x',label:'A'},{id:'x',label:'B'}]}))`,
        ),
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      callProvider(await provider(`console.log('not JSON')`), "discover"),
    ).rejects.toThrow();
    await expect(
      resolveProvider(
        await provider(
          `console.log(JSON.stringify({schemaVersion:1,endpoint:'file:///etc/passwd'}))`,
        ),
        "id",
      ),
    ).rejects.toThrow("Endpoint");
  });
  it("bounds execution and output", async () => {
    const hanging = await provider("setInterval(()=>{},1000)");
    await expect(callProvider({ ...hanging, timeoutMs: 50 }, "discover")).rejects.toThrow(
      "timed out",
    );
    await expect(
      callProvider(await provider(`console.log('x'.repeat(2*1024*1024))`), "discover"),
    ).rejects.toThrow("exceeded");
  });
});
