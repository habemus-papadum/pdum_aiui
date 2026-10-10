import "@habemus-papadum/aiui-design/tokens.css";
import "@habemus-papadum/aiui-design/fonts.css";
import "./style.css";
import type { Part } from "../src/index.ts";
import { defaults, type ExampleId, examples, execute, type Options, type Run } from "./catalog";

const sources = import.meta.glob<string>("../src/examples/*.prompt.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});
const stages = [
  {
    id: "composition",
    title: "1 · Compose",
    description:
      "TypeScript runs first. Components, functions, arrays, and conditionals produce immutable content nodes.",
  },
  {
    id: "compiled",
    title: "2 · Compile",
    description:
      "Resolve headings and selection globally, then emit ordered text and asset parts with output ownership.",
  },
  {
    id: "turn",
    title: "3 · Current turn",
    description:
      "Assign the new content to messages for this invocation. Instructions are a separate contribution.",
  },
  {
    id: "request",
    title: "4 · Attach history",
    description:
      "Prepare a neutral envelope containing current messages and independently owned history. Nothing is sent.",
  },
] as const;
type Stage = (typeof stages)[number]["id"];
const params = new URLSearchParams(location.search);
let exampleId: ExampleId =
  examples.find((item) => item.id === params.get("example"))?.id ?? "greeting";
let stage: Stage = stages.find((item) => item.id === params.get("stage"))?.id ?? "compiled";
let options: Options = { ...defaults };
let run: Run | undefined;
let promptIndex = 0;
let generation = 0;
const mount = document.getElementById("app");
if (!mount) throw new Error("Missing playground root");

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text: string, action: () => void) {
  const node = el("button", "", text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function code(text: string, className = "") {
  const pre = el("pre", className);
  pre.append(el("code", "", text));
  return pre;
}
function jsonTree(value: unknown, label = "value", depth = 0): HTMLElement {
  if (value === null || typeof value !== "object") {
    return el("div", "json-leaf", `${label}: ${JSON.stringify(value) ?? "undefined"}`);
  }
  const entries = Object.entries(value);
  const node = el("details", "json-branch");
  node.append(
    el(
      "summary",
      "",
      `${label} · ${Array.isArray(value) ? `${entries.length} items` : `${entries.length} fields`}`,
    ),
  );
  let filled = false;
  const populate = () => {
    if (filled) return;
    filled = true;
    const children = el("div", "json-children");
    for (const [key, child] of entries) children.append(jsonTree(child, key, depth + 1));
    node.append(children);
  };
  node.addEventListener("toggle", () => {
    if (node.open) populate();
  });
  if (depth < 1) {
    populate();
    node.open = true;
  }
  return node;
}
function disclosure(title: string, content: HTMLElement) {
  const node = el("details", "disclosure");
  node.append(el("summary", "", title), content);
  return node;
}
function partsView(parts: readonly Part[]) {
  const list = el("div", "parts");
  parts.forEach((part, index) => {
    const section = el("section", `part part-${part.type}`);
    section.append(el("h4", "eyebrow", `Part ${index + 1} · ${part.type}`));
    if (part.type === "text") {
      section.append(code(part.text, "emitted-text"));
    } else {
      section.append(el("p", "", part.asset.alt));
      const fields = el("dl", "asset-fields");
      for (const [key, value] of Object.entries(part.asset)) {
        fields.append(el("dt", "", key), el("dd", "", String(value)));
      }
      section.append(
        fields,
        el(
          "p",
          "quiet",
          "This example supplies an asset descriptor only. Image bytes are not loaded or invented here.",
        ),
      );
    }
    list.append(section);
  });
  if (!parts.length) list.append(el("p", "quiet", "No content parts were emitted."));
  return list;
}

const header = el("header");
header.append(
  el("p", "eyebrow", "Prompt toolkit · authoring experiment"),
  el("h1", "", "From TSX to a model request"),
  el(
    "p",
    "lede",
    "Run an example, change its inputs, and follow the content through each transformation.",
  ),
);
const selectorRow = el("div", "toolbar");
const pickerLabel = el("label", "field");
pickerLabel.append(el("span", "eyebrow", "Example"));
const picker = el("select");
picker.id = "example";
for (const item of examples) {
  const option = el("option", "", item.title);
  option.value = item.id;
  option.selected = item.id === exampleId;
  picker.append(option);
}
pickerLabel.append(picker);
const controls = el("div", "toolbar example-controls");
const rerunButton = button("Run again", () => {
  void rerun();
});
selectorRow.append(pickerLabel, controls, rerunButton);
const description = el("p", "description");
const status = el("p", "status");
status.setAttribute("role", "status");
header.append(selectorRow, description, status);
const nav = el("nav", "stages");
nav.setAttribute("aria-label", "Transformation stage");
const stageButtons = new Map<Stage, HTMLButtonElement>();
for (const item of stages) {
  const control = button(item.title, () => {
    stage = item.id;
    updateUrl();
    renderOutput();
  });
  control.dataset.stage = item.id;
  control.setAttribute("aria-controls", "stage-output");
  stageButtons.set(item.id, control);
  nav.append(control);
}
const workspace = el("main", "workspace");
const sourcePanel = el("section", "source-panel");
sourcePanel.append(
  el("h2", "", "Source & invocation"),
  el(
    "p",
    "quiet",
    "Source is read-only. The controls call these actual example functions; editing their files also updates this page.",
  ),
);
const invocation = code("", "invocation");
const sourceTitle = el("h3");
const source = el("pre", "source-code");
source.tabIndex = 0;
source.setAttribute("aria-label", "Example TypeScript source");
sourcePanel.append(el("h3", "", "This run"), invocation, sourceTitle, source);
const output = el("section", "output-panel");
output.id = "stage-output";
output.setAttribute("aria-label", "Transformation output");
workspace.append(sourcePanel, output);
const footer = el("footer", "quiet");
footer.append(
  el(
    "p",
    "",
    "Executed locally with the owned JSX runtime. Source ownership is manually supplied; compiler source capture, token counting, provider adapters, and automatic optimization remain outside this spike.",
  ),
);
const inspectorLink = el("a", "", "Open the separate inspector experiment ↗");
inspectorLink.href = "http://127.0.0.1:5217/";
inspectorLink.target = "_blank";
inspectorLink.rel = "noopener";
footer.append(inspectorLink);
mount.append(header, nav, workspace, footer);

function updateUrl() {
  const next = new URL(location.href);
  next.searchParams.set("example", exampleId);
  next.searchParams.set("stage", stage);
  history.replaceState(null, "", next);
}
function selectControl<K extends "background" | "revision" | "history">(
  key: K,
  title: string,
  values: readonly (readonly [Options[K], string])[],
) {
  const label = el("label", "field");
  label.append(el("span", "eyebrow", title));
  const select = el("select");
  select.id = key;
  for (const [value, text] of values) {
    const option = el("option", "", text);
    option.value = value;
    option.selected = options[key] === value;
    select.append(option);
  }
  select.addEventListener("change", () => {
    options = { ...options, [key]: select.value };
    void rerun();
  });
  label.append(select);
  controls.append(label);
}
function renderControls() {
  controls.replaceChildren();
  if (exampleId === "greeting") {
    const label = el("label", "field");
    label.append(el("span", "eyebrow", "Name"));
    const name = el("input");
    name.id = "name";
    name.value = options.name;
    name.addEventListener("input", () => {
      options = { ...options, name: name.value };
      void rerun();
    });
    label.append(name);
    const check = el("label", "check");
    const concise = el("input");
    concise.type = "checkbox";
    concise.checked = options.concise;
    concise.addEventListener("change", () => {
      options = { ...options, concise: concise.checked };
      void rerun();
    });
    check.append(concise, document.createTextNode("Include concise instruction"));
    controls.append(label, check);
  }
  if (exampleId === "reuse" || exampleId === "history") {
    selectControl("background", "Background", [
      ["full", "Full"],
      ["short", "Short"],
      ["omit", "Omit"],
    ]);
  }
  if (exampleId === "comparison") {
    selectControl("revision", "Revision", [
      ["before", "A · before"],
      ["after", "B · after"],
    ]);
  }
  if (exampleId === "history") {
    selectControl("history", "History", [
      ["messages", "Replay messages"],
      ["remote", "Server conversation"],
      ["provider-items", "Tool-call replay"],
      ["none", "None"],
    ]);
  }
}
picker.addEventListener("change", () => {
  exampleId = picker.value as ExampleId;
  options = { ...defaults };
  promptIndex = 0;
  renderControls();
  updateUrl();
  void rerun();
});

function promptPicker(result: Run) {
  if (result.prompts.length < 2) return;
  const label = el("label", "field prompt-picker");
  label.append(el("span", "eyebrow", "Compiled contribution"));
  const select = el("select");
  select.id = "contribution";
  result.prompts.forEach((prompt, index) => {
    const option = el("option", "", prompt.label);
    option.value = String(index);
    option.selected = index === promptIndex;
    select.append(option);
  });
  select.addEventListener("change", () => {
    promptIndex = Number(select.value);
    renderOutput();
    output.querySelector<HTMLSelectElement>("#contribution")?.focus();
  });
  label.append(select);
  output.append(label);
}
function messageView(result: Run) {
  if (result.turn.instructions) {
    const instructions = el("section", "message");
    instructions.append(
      el("h3", "", "Instructions · current invocation"),
      partsView(result.turn.instructions.parts),
    );
    output.append(instructions);
  }
  result.turn.messages.forEach((message, index) => {
    const node = el("section", "message");
    node.append(
      el("h3", "", `Message ${index + 1} · ${message.role}`),
      partsView(message.prompt.parts),
    );
    output.append(node);
  });
}
function renderOutput() {
  for (const [id, control] of stageButtons)
    control.setAttribute("aria-pressed", String(id === stage));
  output.replaceChildren();
  const selectedStage = stages.find((item) => item.id === stage);
  output.append(el("h2", "", selectedStage?.title), el("p", "", selectedStage?.description));
  if (!run) {
    output.append(el("p", "quiet", "Running the example…"));
    return;
  }
  const result = run;
  const compiled = result.prompts[promptIndex]?.compiled ?? result.prompts[0].compiled;
  let stageValue: unknown;
  switch (stage) {
    case "composition":
      if (result.authored) {
        output.append(jsonTree(result.authored, "document"));
        stageValue = result.authored;
      } else {
        output.append(
          el(
            "p",
            "quiet",
            "This example returns already-compiled contributions. Its evaluated input nodes are not retained. Inspect their definitions here, or follow the composition in the source.",
          ),
        );
        promptPicker(result);
        output.append(jsonTree(compiled.definitions, "retained definitions"));
        stageValue = compiled.definitions;
      }
      break;
    case "compiled": {
      promptPicker(result);
      const { textCodeUnits, images } = compiled.metrics;
      output.append(
        el(
          "p",
          "metrics",
          `${textCodeUnits.toLocaleString()} UTF-16 code units · ${images} image parts · ${compiled.definitions.length} definitions · ${compiled.occurrences.length} placements`,
        ),
      );
      output.append(
        el(
          "p",
          "quiet",
          "The text below is exact emitted content. TeX and Markdown stay visible as written; counts are not tokens.",
        ),
        partsView(compiled.parts),
      );
      const placements = el("table");
      const head = el("thead");
      const heading = el("tr");
      for (const title of ["Kind / definition", "Heading / choice", "Placement"])
        heading.append(el("th", "", title));
      head.append(heading);
      const body = el("tbody");
      for (const occurrence of compiled.occurrences) {
        const definition = compiled.definitions.find((item) => item.id === occurrence.definition);
        const row = el("tr");
        row.append(
          el("td", "", `${definition?.kind} · ${occurrence.definition}`),
          el(
            "td",
            "",
            occurrence.headingLevel ? `h${occurrence.headingLevel}` : (occurrence.selected ?? "—"),
          ),
          el("td", "path", occurrence.id),
        );
        body.append(row);
      }
      placements.append(head, body);
      output.append(
        disclosure("Definitions and placements", placements),
        disclosure("Output ownership map", jsonTree(compiled.outputMap, "outputMap")),
      );
      stageValue = compiled;
      break;
    }
    case "turn":
      output.append(
        el(
          "p",
          "metrics",
          `${result.turn.messages.length} current messages · ${result.turn.instructions ? "with" : "no"} separate instructions · history attached in the next stage`,
        ),
      );
      messageView(result);
      stageValue = result.turn;
      break;
    case "request": {
      const replay = result.prepared.history;
      const historyPanel = el("section", "history-panel");
      const descriptions = {
        none: "No history supplied.",
        messages:
          "Prior messages are replayed unchanged. Current content selection never edits this sequence.",
        remote:
          "Only the server reference is supplied. Previous messages and their context cost remain unknown here.",
        "provider-items":
          "Opaque replay preserves tool-call IDs, order, and provider-specific records.",
      };
      historyPanel.append(
        el("h3", "", `History · ${replay.kind}`),
        el("p", "", descriptions[replay.kind]),
        code(JSON.stringify(replay, null, 2)),
      );
      output.append(
        el(
          "p",
          "quiet",
          "This is a provider-neutral envelope. A future adapter would turn it into a particular model API request.",
        ),
        historyPanel,
        el("h3", "", "New contributions"),
      );
      messageView(result);
      output.append(
        el(
          "p",
          "metrics",
          `Current text: ${result.prepared.accounting.currentTextCodeUnits} UTF-16 code units · history: ${result.prepared.accounting.history} · request tokens: unknown`,
        ),
      );
      stageValue = result.prepared;
      break;
    }
  }
  const serialized = JSON.stringify(stageValue, null, 2);
  const actions = el("div", "toolbar output-actions");
  actions.append(
    button("Copy stage JSON", () => {
      void navigator.clipboard
        .writeText(serialized)
        .then(() => {
          status.textContent = "Copied this stage's complete JSON.";
        })
        .catch(() => {
          status.textContent =
            "Clipboard unavailable. Expand Complete stage JSON below to copy it manually.";
        });
    }),
  );
  output.append(actions, disclosure("Complete stage JSON", code(serialized, "stage-json")));
}

async function rerun() {
  const version = ++generation;
  const example = examples.find((item) => item.id === exampleId);
  if (!example) return;
  description.textContent = example.description;
  sourceTitle.textContent = `${example.file}.prompt.tsx`;
  const sourceText = sources[`../src/examples/${example.file}.prompt.tsx`];
  source.replaceChildren();
  sourceText.split("\n").forEach((line, index) => {
    const row = el("span", "source-line");
    const number = el("span", "line-number", String(index + 1));
    number.setAttribute("aria-hidden", "true");
    row.append(number, document.createTextNode(`${line}\n`));
    source.append(row);
  });
  run = undefined;
  invocation.textContent = "Running…";
  status.textContent = "Running the actual example…";
  renderOutput();
  try {
    const result = await execute(exampleId, { ...options });
    if (version !== generation) return;
    run = result;
    invocation.textContent = result.invocation;
    status.textContent = "Ready · all stages computed locally · no model request sent";
    renderOutput();
  } catch (error) {
    if (version !== generation) return;
    status.textContent = "The example could not run.";
    output.replaceChildren(el("h2", "", "Example error"), code(String(error), "error"));
  }
}
renderControls();
void rerun();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    generation++;
    mount.replaceChildren();
  });
