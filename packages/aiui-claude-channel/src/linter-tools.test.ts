import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeReadFile, READ_FILE_CAP_BYTES } from "./linter-tools";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "aiui-linter-tools-"));
}

describe("executeReadFile", () => {
  it("reads a text file relative to the prompt cwd", () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "a.ts"), "const a = 1;\n");
    const result = executeReadFile({ path: "a.ts" }, cwd);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("const a = 1;\n");
    expect(result.summary).toContain("a.ts — 0.0 KB");
  });

  it("reads an absolute path as-is (anything readable — fully traced)", () => {
    const cwd = tempProject();
    const other = join(tempProject(), "outside.txt");
    writeFileSync(other, "outside the project");
    const result = executeReadFile({ path: other }, cwd);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("outside the project");
  });

  it("caps at 32 KB with an explicit truncation marker", () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "big.txt"), "x".repeat(READ_FILE_CAP_BYTES + 5000));
    const result = executeReadFile({ path: "big.txt" }, cwd);
    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThan(READ_FILE_CAP_BYTES + 200);
    expect(result.content).toContain("[…truncated at 32 KB");
    expect(result.summary).toContain("(truncated)");
  });

  it("refuses binary content with a readable explanation, never garbage", () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
    const result = executeReadFile({ path: "blob.bin" }, cwd);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("binary file");
    expect(result.summary).toContain("binary");
  });

  it("returns errors to the model as readable strings — a failed read never throws", () => {
    const cwd = tempProject();
    const missing = executeReadFile({ path: "nope.ts" }, cwd);
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("read_file error:");
    expect(missing.content).toContain("ENOENT");

    const pathless = executeReadFile({}, cwd);
    expect(pathless.ok).toBe(false);
    expect(pathless.summary).toBe("no path given");
  });
});
