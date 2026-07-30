import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeGrep,
  executeListFiles,
  executeReadFile,
  GREP_MATCH_CAP,
  READ_FILE_CAP_BYTES,
} from "./linter-tools";

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

describe("executeListFiles (O3c — the oracle's half of the surface)", () => {
  const project = (): string => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "node_modules", "huge.js"), "x");
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(cwd, "readme.md"), "# hi\n");
    return cwd;
  };

  it("lists a directory, sorted, one level deep by default", () => {
    const cwd = project();
    const result = executeListFiles({ path: "." }, cwd);
    expect(result.ok).toBe(true);
    const lines = result.content.split("\n");
    expect(lines).toContain("readme.md");
    expect(lines).toContain("src/");
    // depth 1: the directory is named, its contents are not walked.
    expect(result.content).not.toContain("app.ts");
  });

  it("descends when asked, and skips the directories that are never the answer", () => {
    const cwd = project();
    const result = executeListFiles({ path: ".", depth: 3 }, cwd);
    expect(result.content).toContain("app.ts");
    // Skipping is for SIGNAL and it SAYS so rather than pretending the
    // directory does not exist.
    expect(result.content).toContain("node_modules/ (skipped)");
    expect(result.content).not.toContain("huge.js");
  });

  it("points a file at read_file instead of failing obscurely", () => {
    const cwd = project();
    const result = executeListFiles({ path: "readme.md" }, cwd);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("read_file");
  });

  it("a missing path is an answer the model can read, never a throw", () => {
    const cwd = project();
    const result = executeListFiles({ path: "nope" }, cwd);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("list_files error");
  });
});

describe("executeGrep (O3c)", () => {
  const project = (): string => {
    const cwd = tempProject();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "wave.ts"), "export const freq = 3;\nconst other = 1;\n");
    writeFileSync(join(cwd, "src", "app.tsx"), "// freq lives in wave.ts\n");
    writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0x00, 0x66, 0x72, 0x65, 0x71]));
    return cwd;
  };

  it("finds matches with file and line, relativized against the project", () => {
    const cwd = project();
    const result = executeGrep({ pattern: "freq" }, cwd);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/wave.ts:1:");
    expect(result.content).toContain("src/app.tsx:1:");
    expect(result.summary).toContain("2 matches");
  });

  it("never offers a binary file as evidence", () => {
    const cwd = project();
    const result = executeGrep({ pattern: "freq" }, cwd);
    expect(result.content).not.toContain("blob.bin");
  });

  it("filters by extension when asked", () => {
    const cwd = project();
    const result = executeGrep({ pattern: "freq", extensions: [".tsx"] }, cwd);
    expect(result.content).toContain("app.tsx");
    expect(result.content).not.toContain("wave.ts:");
  });

  it("no matches is a SUCCESS with a readable answer, not a failure", () => {
    const cwd = project();
    const result = executeGrep({ pattern: "zzz-nothing" }, cwd);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("no matches");
  });

  it("a bad regex comes back as a message, never a throw", () => {
    const cwd = project();
    const result = executeGrep({ pattern: "[unclosed" }, cwd);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("bad pattern");
  });

  it("TELLS the model when it truncated — a silent cap reads as completeness", () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, "many.txt"), Array.from({ length: 200 }, () => "hit").join("\n"));
    const result = executeGrep({ pattern: "hit" }, cwd);
    expect(result.content).toContain(`stopped at ${GREP_MATCH_CAP} matches`);
    expect(result.summary).toContain("truncated");
  });
});
