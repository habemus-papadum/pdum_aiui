import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEntry } from "./read.ts";
import { registerServer, removeEntryFile, writeFileAtomic } from "./write.ts";

let dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiui-registry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe("writeFileAtomic", () => {
  it("writes the content and leaves no temp file behind", () => {
    const dir = tmp();
    const file = join(dir, "x.json");
    writeFileAtomic(file, "hello");
    expect(readFileSync(file, "utf8")).toBe("hello");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("replaces existing content", () => {
    const dir = tmp();
    const file = join(dir, "x.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    expect(readFileSync(file, "utf8")).toBe("two");
  });
});

describe("registerServer", () => {
  it("writes a schema-2 entry that readEntry round-trips", () => {
    const dir = tmp();
    const reg = registerServer({ port: 4242, tag: "t", kind: "channel", registryDir: dir });
    expect(reg.file).toBe(join(dir, `${process.pid}.json`));
    const entry = readEntry(reg.file);
    expect(entry).toEqual(reg.entry);
    expect(entry?.schema).toBe(2);
    expect(entry?.pid).toBe(process.pid);
    expect(entry?.kind).toBe("channel");
  });

  it("records the optional fields only when given", () => {
    const dir = tmp();
    const reg = registerServer({
      port: 1,
      tag: "r",
      kind: "remote",
      assignedName: "dev-box tunnel",
      browserUrl: "http://127.0.0.1:9222",
      host: "dev-box",
      pid: 999999,
      ppid: 1,
      cwd: "/",
      registryDir: dir,
    });
    const entry = readEntry(reg.file);
    expect(entry?.assignedName).toBe("dev-box tunnel");
    expect(entry?.browserUrl).toBe("http://127.0.0.1:9222");
    expect(entry?.host).toBe("dev-box");
    const bare = registerServer({ port: 2, tag: "b", kind: "channel", registryDir: dir });
    expect(JSON.parse(readFileSync(bare.file, "utf8"))).not.toHaveProperty("assignedName");
  });

  it("remove() deletes the file and is idempotent", () => {
    const dir = tmp();
    const reg = registerServer({ port: 1, tag: "t", kind: "channel", registryDir: dir });
    expect(existsSync(reg.file)).toBe(true);
    reg.remove();
    expect(existsSync(reg.file)).toBe(false);
    reg.remove(); // no throw
  });
});

describe("removeEntryFile", () => {
  it("tolerates a missing file", () => {
    expect(() => removeEntryFile(join(tmp(), "gone.json"))).not.toThrow();
  });
});
