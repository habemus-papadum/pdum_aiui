import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLanguages } from "./providers";
import { workspaceMemberDirs } from "./workspace";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiui-ws-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `<root>/<rel>` with `content`, making parent dirs. */
function file(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("workspaceMemberDirs", () => {
  it("expands pnpm-workspace.yaml globs to member package dirs", () => {
    file(
      "pnpm-workspace.yaml",
      'packages:\n  - "packages/*"\n  - "tools/cli"\n\nallowBuilds:\n  esbuild: true\n',
    );
    file("packages/a/package.json", "{}");
    file("packages/b/package.json", "{}");
    file("tools/cli/package.json", "{}");
    file("packages/not-a-pkg/readme.md", "no package.json here"); // not a member
    const members = workspaceMemberDirs(root);
    expect(members).toEqual([
      join(root, "packages/a"),
      join(root, "packages/b"),
      join(root, "tools/cli"),
    ]);
  });

  it("reads a package.json `workspaces` array (npm/yarn)", () => {
    file("package.json", JSON.stringify({ workspaces: ["libs/*"] }));
    file("libs/x/package.json", "{}");
    expect(workspaceMemberDirs(root)).toEqual([join(root, "libs/x")]);
  });

  it("returns null for a plain (non-workspace) project", () => {
    file("package.json", JSON.stringify({ name: "solo" }));
    expect(workspaceMemberDirs(root)).toBeNull();
  });
});

describe("detectLanguages — monorepo awareness", () => {
  it("a workspace root reflects its members' languages, not unrelated nested projects", () => {
    // A TS monorepo with a Python app sitting in a non-member dir (the motivating
    // case: `examples/py-demo` must not drag the repo root into Python).
    file("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    file("packages/web/package.json", "{}");
    file("packages/web/src/index.ts", "export const x = 1;");
    file("examples/py-demo/pyproject.toml", "[project]\nname='x'");
    file("examples/py-demo/main.py", "print('hi')");
    expect(detectLanguages(root)).toEqual(["typescript"]);
  });

  it("a plain project still walks its own whole tree", () => {
    file("main.py", "print('hi')");
    file("web/app.ts", "export const y = 2;");
    expect(detectLanguages(root)).toEqual(["python", "typescript"]);
  });
});
