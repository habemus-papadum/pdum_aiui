import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { fields, name, object } from "./model.ts";
import { locked } from "./storage.ts";

export const PROJECT_FILES = [".aiui.yaml", ".aiui.yml", ".aiui.json"] as const;

export async function projectFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const filename of PROJECT_FILES) {
    const file = join(dir, filename);
    try {
      await lstat(file);
      found.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

export async function readProject(file: string): Promise<string> {
  try {
    const text = await readFile(file, "utf8");
    let raw: unknown;
    if (file.endsWith(".json")) raw = JSON.parse(text);
    else {
      const document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length || document.warnings.length)
        throw new Error(
          [...document.errors, ...document.warnings].map((e) => e.message).join("; "),
        );
      raw = document.toJS({ maxAliasCount: 0 });
    }
    const value = object(raw, file);
    fields(value, ["schemaVersion", "browser"], file);
    if (value.schemaVersion !== 1) throw new Error("Unsupported schemaVersion");
    const browser = object(value.browser, "Project browser selection");
    fields(browser, ["target"], "project browser selection");
    return name(browser.target);
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

export async function findProject(
  cwd: string,
): Promise<{ file: string; target: string } | undefined> {
  let dir = resolve(cwd);
  while (true) {
    const files = await projectFiles(dir);
    if (files.length > 1)
      throw new Error(
        `Multiple project configs in ${dir}: keep only one of ${PROJECT_FILES.join(", ")}`,
      );
    if (files.length) return { file: files[0], target: await readProject(files[0]) };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Create a stub only: never overwrite or silently shadow a config in the same directory. */
export async function writeProject(dir: string, target: string, format = "yaml"): Promise<string> {
  if (!["yaml", "yml", "json"].includes(format))
    throw new Error("Format must be yaml, yml or json");
  const data = { schemaVersion: 1, browser: { target: name(target) } };
  dir = resolve(dir);
  if (!(await stat(dir)).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  return locked(join(dir, ".aiui-config"), async () => {
    const existing = await projectFiles(dir);
    if (existing.length)
      throw new Error(
        `Project config already exists: ${existing.join(", ")}. Edit it to change the target.`,
      );
    const file = join(dir, `.aiui.${format}`);
    const text =
      format === "json"
        ? `${JSON.stringify(data, null, 2)}\n`
        : `# Browser target for this directory and its descendants.\n${stringify(data)}`;
    await writeFile(file, text, { flag: "wx", mode: 0o644 });
    return file;
  });
}
