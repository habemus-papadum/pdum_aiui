import { greeting } from "../src/examples/01-greeting.prompt.tsx";
import { investigation } from "../src/examples/02-reuse-and-selection.prompt.tsx";
import { sciencePrompt } from "../src/examples/03-scientific.prompt.tsx";
import { tablePrompt } from "../src/examples/04-tables.prompt.tsx";
import { example as comparison } from "../src/examples/05-comparison.prompt.tsx";
import {
  current,
  history,
  example as historyExamples,
} from "../src/examples/06-history.prompt.tsx";
import { example as multipleMessages } from "../src/examples/07-current-messages.prompt.tsx";
import {
  type CompiledPrompt,
  compilePrompt,
  type History,
  type Node,
  prepareRequest,
  renderTurn,
  type Turn,
} from "../src/index.ts";

export const examples = [
  {
    id: "greeting",
    title: "01 · Greeting",
    file: "01-greeting",
    description:
      "Ordinary TypeScript values and a conditional become prompt content. Try changing the name or omitting the second paragraph.",
  },
  {
    id: "reuse",
    title: "02 · Reuse & selection",
    file: "02-reuse-and-selection",
    description:
      "The same evidence fragment resolves to heading levels 1 and 2. Choose how much background to include.",
  },
  {
    id: "science",
    title: "03 · Scientific content",
    file: "03-scientific",
    description:
      "Exact TeX, significant zeros, escaped XML, and an image between text parts. Compilation preserves the original scientific strings.",
  },
  {
    id: "tables",
    title: "04 · Dynamic tables",
    file: "04-tables",
    description:
      "Ordinary TypeScript functions and arrays assemble rows. Contribution boundaries survive when the compiler joins the text.",
  },
  {
    id: "comparison",
    title: "05 · Revisions",
    file: "05-comparison",
    description:
      "Switch between two complete compiled prompts. The image revision changes even though its URI, dimensions, and alt text stay the same.",
  },
  {
    id: "history",
    title: "06 · Current prompt & history",
    file: "06-history",
    description:
      "Change the current background independently of replay history or an opaque server reference. Only newly authored content is selected.",
  },
  {
    id: "messages",
    title: "07 · Several current messages",
    file: "07-current-messages",
    description:
      "Instructions plus two few-shot messages and a user question belong to this invocation. They are not replay history.",
  },
] as const;
export type ExampleId = (typeof examples)[number]["id"];
export type Options = {
  name: string;
  concise: boolean;
  background: "full" | "short" | "omit";
  revision: "before" | "after";
  history: "none" | "messages" | "remote" | "provider-items";
};
export const defaults: Options = {
  name: "Ada",
  concise: true,
  background: "full",
  revision: "after",
  history: "messages",
};
export interface Run {
  authored?: Node;
  prompts: { label: string; compiled: CompiledPrompt }[];
  turn: Turn;
  prepared: ReturnType<typeof prepareRequest>;
  invocation: string;
}

/** The browser calls the actual example functions and library, never saved JSON. */
export async function execute(id: ExampleId, options: Options): Promise<Run> {
  let authored: Node | undefined;
  let compiled: CompiledPrompt;
  let replay: History = { kind: "none" };
  let invocation: string;
  const selection = `{ selection: { background: ${JSON.stringify(options.background)} } }`;
  switch (id) {
    case "greeting":
      authored = greeting(options.name, options.concise);
      invocation = `const document = greeting(${JSON.stringify(options.name)}, ${options.concise});\nconst compiled = compilePrompt(document);`;
      compiled = compilePrompt(authored);
      break;
    case "reuse":
      authored = investigation;
      compiled = compilePrompt(authored, { selection: { background: options.background } });
      invocation = `const document = investigation;\nconst compiled = compilePrompt(document, ${selection});`;
      break;
    case "science":
      authored = await sciencePrompt();
      compiled = compilePrompt(authored);
      invocation =
        "const document = await sciencePrompt();\nconst compiled = compilePrompt(document);";
      break;
    case "tables":
      authored = tablePrompt();
      compiled = compilePrompt(authored);
      invocation = "const document = tablePrompt();\nconst compiled = compilePrompt(document);";
      break;
    case "comparison":
      compiled = comparison()[options.revision];
      invocation = `const compiled = example().${options.revision};`;
      break;
    case "history": {
      authored = current;
      compiled = compilePrompt(authored, { selection: { background: options.background } });
      const original = historyExamples();
      replay =
        options.history === "messages"
          ? history
          : options.history === "remote"
            ? original.remote.history
            : options.history === "provider-items"
              ? original.providerReplay.history
              : { kind: "none" };
      invocation = `const document = current;\nconst compiled = compilePrompt(document, ${selection});\nconst history = ${JSON.stringify(replay, null, 2)};`;
      break;
    }
    case "messages": {
      const result = multipleMessages();
      return {
        prompts: [
          ...(result.turn.instructions
            ? [{ label: "Instructions", compiled: result.turn.instructions }]
            : []),
          ...result.turn.messages.map((message, index) => ({
            label: `Message ${index + 1} · ${message.role}`,
            compiled: message.prompt,
          })),
        ],
        turn: result.turn,
        prepared: result.prepared,
        invocation:
          "const { turn, prepared } = example();\n// example() compiles each current contribution separately.\n// Inspect its full renderTurn(...) call in the source below.",
      };
    }
  }
  const turn = renderTurn({ input: compiled });
  const prepared = prepareRequest(turn, { history: replay });
  return {
    authored,
    prompts: [{ label: "Current user content", compiled }],
    turn,
    prepared,
    invocation: `${invocation}\nconst turn = renderTurn({ input: compiled });\nconst prepared = prepareRequest(turn${id === "history" ? ", { history }" : ""});`,
  };
}
