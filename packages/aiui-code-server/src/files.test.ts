import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileService, resolveWithin } from "./files";

// --- resolveWithin (the security-relevant primitive) -----------------------

describe("resolveWithin", () => {
  const root = "/home/proj/root";

  it("resolves a normal relative path", () => {
    expect(resolveWithin(root, "pkg/geometry.py")).toBe(resolve(root, "pkg/geometry.py"));
  });

  it("allows a `..` that stays inside the root", () => {
    expect(resolveWithin(root, "a/../b.py")).toBe(resolve(root, "b.py"));
  });

  it("allows the root itself (empty rel)", () => {
    expect(resolveWithin(root, "")).toBe(resolve(root));
  });

  it("rejects a `..` that climbs out of the root", () => {
    expect(() => resolveWithin(root, "../secret.py")).toThrow(/escapes/);
    expect(() => resolveWithin(root, "a/../../secret.py")).toThrow(/escapes/);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveWithin(root, "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects a sibling directory sharing a name prefix", () => {
    expect(() => resolveWithin("/a/root", "../root2/x")).toThrow(/escapes/);
  });
});

// --- tree() / read() round-trip against a temp dir -------------------------

describe("createFileService", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aiui-files-"));
    await writeFile(join(dir, "a.py"), "print('hi')\n");
    await writeFile(join(dir, ".gitignore"), "dist\n");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.txt"), "hello\n");
    // Skipped dirs.
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "junk.js"), "x\n");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref\n");
    await mkdir(join(dir, ".hidden"));
    await writeFile(join(dir, ".hidden", "secret.txt"), "nope\n");
  });

  afterAll(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("walks the tree, skipping heavy/dot directories but keeping dotfiles", async () => {
    const svc = createFileService({ root: dir });
    const paths = (await svc.tree()).map((e) => e.path);
    expect(paths).toContain("a.py");
    expect(paths).toContain(".gitignore");
    expect(paths).toContain("sub");
    expect(paths).toContain("sub/b.txt");
    // Skipped.
    expect(paths).not.toContain("node_modules");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths).not.toContain(".git");
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".hidden"))).toBe(false);
  });

  it("returns POSIX paths with dirs before their contents, deterministically", async () => {
    const svc = createFileService({ root: dir });
    const paths = (await svc.tree()).map((e) => e.path);
    // `sub` (dir) precedes `sub/b.txt`.
    expect(paths.indexOf("sub")).toBeLessThan(paths.indexOf("sub/b.txt"));
    // Stable across calls.
    const again = (await svc.tree()).map((e) => e.path);
    expect(again).toEqual(paths);
  });

  it("reads a file with its inferred language id", async () => {
    const svc = createFileService({ root: dir });
    const res = await svc.read("a.py");
    expect(res).toEqual({ path: "a.py", content: "print('hi')\n", languageId: "python" });
  });

  it("rejects a path traversal in read()", async () => {
    const svc = createFileService({ root: dir });
    await expect(svc.read("../escape.py")).rejects.toThrow(/escapes/);
  });

  it("rejects a binary file (NUL byte)", async () => {
    const svc = createFileService({ root: dir });
    await writeFile(join(dir, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    await expect(svc.read("bin.dat")).rejects.toThrow(/binary/);
  });

  it("rejects an oversized file", async () => {
    const svc = createFileService({ root: dir });
    await writeFile(join(dir, "big.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    await expect(svc.read("big.txt")).rejects.toThrow(/too large/);
  });
});
