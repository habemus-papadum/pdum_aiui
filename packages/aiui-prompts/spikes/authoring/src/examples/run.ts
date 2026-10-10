import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { example as greeting } from "./01-greeting.prompt.tsx";
import { example as reuse } from "./02-reuse-and-selection.prompt.tsx";
import { example as scientific } from "./03-scientific.prompt.tsx";
import { example as tables } from "./04-tables.prompt.tsx";
import { example as comparison } from "./05-comparison.prompt.tsx";
import { example as history } from "./06-history.prompt.tsx";
import { example as messages } from "./07-current-messages.prompt.tsx";

const examples = {
  "01-greeting": greeting,
  "02-reuse-and-selection": reuse,
  "03-scientific": scientific,
  "04-tables": tables,
  "05-comparison": comparison,
  "06-history": history,
  "07-current-messages": messages,
};
const mode = process.argv[2];
if (mode && !["--write", "--check", "--json"].includes(mode))
  throw new Error("Use --write, --check, or --json.");
for (const [name, run] of Object.entries(examples)) {
  const result = await run();
  const content = `${JSON.stringify(result, null, 2)}\n`;
  const path = new URL(`../../expected/${name}.json`, import.meta.url);
  if (mode === "--write") {
    await writeFile(path, content);
    console.log(`Wrote ${fileURLToPath(path)}`);
  } else if (mode === "--check") {
    if (JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== JSON.stringify(result))
      throw new Error(`Expected artifact changed: ${name}; inspect before updating.`);
    console.log(`Matches ${name}`);
  } else if (mode === "--json") {
    console.log(content);
  } else {
    console.log(
      `${name}: executed ${Object.keys(result).join(" → ")}; inspect expected/${name}.json`,
    );
  }
}
