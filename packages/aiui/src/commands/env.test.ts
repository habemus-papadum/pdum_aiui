import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnvScript, findWorkspaceRoot, parseDotenv, shQuote } from "./env";

describe("parseDotenv", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    const parsed = parseDotenv("# a comment\n\nOPENAI_API_KEY=sk-abc\nGEMINI_API_KEY=gm-def\n");
    expect([...parsed]).toEqual([
      ["OPENAI_API_KEY", "sk-abc"],
      ["GEMINI_API_KEY", "gm-def"],
    ]);
  });

  it("strips one pair of matching outer quotes and an `export ` prefix", () => {
    const parsed = parseDotenv('export A="with space"\nB=\'single\'\nC="unterminated\n');
    expect(parsed.get("A")).toBe("with space");
    expect(parsed.get("B")).toBe("single");
    expect(parsed.get("C")).toBe('"unterminated');
  });

  it("ignores lines that aren't assignments and rejects bad key names", () => {
    const parsed = parseDotenv("not a var\n1BAD=x\nGOOD=1\n");
    expect([...parsed.keys()]).toEqual(["GOOD"]);
  });

  it("later assignment of the same key wins (file order)", () => {
    expect(parseDotenv("K=first\nK=second\n").get("K")).toBe("second");
  });
});

describe("shQuote", () => {
  it("single-quotes plain values and escapes embedded single quotes", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote("")).toBe("''");
  });
});

describe("findWorkspaceRoot", () => {
  it("walks up to the nearest pnpm-workspace.yaml / .git, else returns the start", () => {
    const root = mkdtempSync(join(tmpdir(), "aiui-env-root-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n");
    const nested = join(root, "packages", "thing", "src");
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(root);

    const bare = mkdtempSync(join(tmpdir(), "aiui-env-bare-"));
    expect(findWorkspaceRoot(bare)).toBe(bare);
  });
});

describe("buildEnvScript", () => {
  const script = buildEnvScript({
    pathDirs: ["/repo/bin", "/repo/node_modules/.bin"],
    vars: new Map([
      ["OPENAI_API_KEY", "sk-abc"],
      ["GEMINI_API_KEY", "with 'quote'"],
    ]),
  });

  it("saves the old PATH once, prepends guarded dirs, exports vars, defines deactivate", () => {
    expect(script).toContain('_AIUI_OLD_PATH="$PATH"');
    expect(script).toContain("'/repo/bin'");
    expect(script).toContain("'/repo/node_modules/.bin'");
    expect(script).toContain("export OPENAI_API_KEY='sk-abc';");
    expect(script).toContain("export GEMINI_API_KEY='with '\\''quote'\\''';");
    expect(script).toContain("aiui_deactivate ()");
    expect(script).toContain("unset OPENAI_API_KEY GEMINI_API_KEY;");
  });

  it("every line is semicolon-terminated (unquoted-eval survival)", () => {
    for (const line of script.trim().split("\n")) {
      expect(line.endsWith(";")).toBe(true);
    }
  });

  it("omits the var unset when there are no vars", () => {
    const bare = buildEnvScript({ pathDirs: [], vars: new Map() });
    expect(bare).toContain("aiui_deactivate ()");
    expect(bare).not.toContain("unset ;");
  });

  /** Evaluate `code` in a real `sh`, then report PATH/vars/deactivation state. */
  function evalInSh(code: string): { path: string; key: string; afterDeactivate: string } {
    const probe =
      `${code}\n` +
      'echo "PATH=$PATH"\n' +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
      'echo "KEY=${OPENAI_API_KEY:-}"\n' +
      "aiui_deactivate\n" +
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
      'echo "AFTER=$PATH:${OPENAI_API_KEY:-unset}"\n';
    const result = spawnSync("sh", ["-c", probe], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(result.status).toBe(0);
    const out = result.stdout;
    return {
      path: /PATH=(.*)/.exec(out)?.[1] ?? "",
      key: /KEY=(.*)/.exec(out)?.[1] ?? "",
      afterDeactivate: /AFTER=(.*)/.exec(out)?.[1] ?? "",
    };
  }

  it("round-trips through a real sh: PATH prepended, vars set, deactivate restores", () => {
    const { path, key, afterDeactivate } = evalInSh(script);
    expect(path.startsWith("/repo/bin:/repo/node_modules/.bin:")).toBe(true);
    expect(key).toBe("sk-abc");
    expect(afterDeactivate).toBe("/usr/bin:/bin:unset");
  });

  it("re-activation is idempotent: PATH gains each dir once", () => {
    const twice = `${script}\n${script}`;
    const { path } = evalInSh(twice);
    expect(path.split(":").filter((p) => p === "/repo/bin")).toHaveLength(1);
  });

  it("survives an UNQUOTED eval (newlines collapsed to spaces)", () => {
    const collapsed = script.replace(/\n/g, " ");
    const { path, key } = evalInSh(collapsed);
    expect(path.startsWith("/repo/bin:")).toBe(true);
    expect(key).toBe("sk-abc");
  });

  it("round-trips through zsh too, when zsh is available", () => {
    const probe = `${script}\necho "KEY=$OPENAI_API_KEY"\n`;
    const result = spawnSync("zsh", ["-fc", probe], { encoding: "utf8" });
    if (result.error !== undefined) {
      return; // no zsh on this machine (CI) — the sh round-trip above still covers POSIX
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("KEY=sk-abc");
  });
});
