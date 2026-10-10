/**
 * tool-brief.ts — the tool surface rendered as a DOCUMENT for a model, by
 * the prompt toolkit (`@habemus-papadum/aiui-prompts`).
 *
 * A tool crosses every wire as `{ name, description, inputSchema }`, and a
 * tool definition alone does not say WHEN to call it, what its result means,
 * or how the app's tools relate. Both OpenAI voice prompting guides prescribe
 * exactly that text in the prompt (a `Tools` section with per-class rules; a
 * capability list for the voice model), and warn that the prompt must never
 * name a tool the tool list does not carry. So the text is DERIVED from the
 * same tool documents every consumer already holds, in the same breath as
 * the tool array is set, so the two cannot drift (the tool-docs proposal,
 * docs/proposals/tool-docs.md).
 *
 * Since the prompt toolkit (docs/proposals/structured-prompts-review.md,
 * stage 1) the document is the toolkit's `ToolSnapshot` — immutable,
 * fingerprinted JSON — and the text is its `ToolBrief` projection: a prompt
 * NODE a consumer places inside a larger prompt, compiled late, with the
 * character-budget decision recorded in the compiled artifact rather than
 * lost in a string. This module is the consumers' doorway to that: the loose
 * `KitDoc` shape a page registry or a session hands over, the snapshot, the
 * node, the string, the one composition every consumer makes
 * ({@link instructionsWithToolBrief}), and {@link renderPrompt}, which gives
 * both the semantic record a ledger stores and the text the wire carries.
 *
 * Consumers: the oracle appends it to its woven instructions; the live
 * delegators put it in the backend instructions and the delegation message;
 * the panel's tool log shows it as "what the model sees". The channel does
 * NOT render it into prompts — Claude Code reads the structured form from
 * `page_tools_list` — so nothing here is on a billed prompt path by default.
 */

import {
  type CompiledPrompt,
  type CompileOptions,
  toolSnapshot as captureToolSnapshot,
  type JsonObject,
  Prompt,
  type PromptNode,
  type PromptValue,
  rehydrate,
  type SemanticRecord,
  snapshot,
  ToolBrief,
  type ToolDeclaration,
  type ToolKit,
  type ToolSnapshot,
} from "@habemus-papadum/aiui-prompts";

export type { ToolSnapshot } from "@habemus-papadum/aiui-prompts";

/** Eagerness class: `read` is called freely once the intent is clear; `write`
 * changes the app. Tools without one are listed under neither heading. */
export type ToolKind = "read" | "write";

/**
 * One tool as a consumer hands it over — the documented fields, minus `run`.
 * A richer object (a live or oracle tool with its schema and executor) is
 * accepted as-is: {@link toolSnapshot} keeps exactly these fields and drops
 * the rest, so an executor never reaches the record.
 */
export interface ToolDoc {
  name: string;
  description: string;
  usage?: string;
  kind?: ToolKind;
  /** Category — a sub-heading inside the eagerness section when present. */
  group?: string;
  /** JSON Schema for the arguments, when the consumer carries one. The brief
   * never renders it; the toolkit's vendor projection reads it. */
  inputSchema?: Record<string, unknown>;
}

/** One kit's worth of tools, with its brief. */
export interface KitDoc {
  ns: string;
  brief?: string;
  tools: readonly ToolDoc[];
}

/** What every function here takes: the kits, or a snapshot already taken of them. */
export type ToolDocument = KitDoc[] | ToolSnapshot;

function declaration(tool: ToolDoc): ToolDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.usage !== undefined ? { usage: tool.usage } : {}),
    ...(tool.kind !== undefined ? { kind: tool.kind } : {}),
    ...(tool.group !== undefined ? { group: tool.group } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as JsonObject } : {}),
  };
}

function kit(doc: KitDoc): ToolKit {
  return {
    ns: doc.ns,
    ...(doc.brief !== undefined ? { brief: doc.brief } : {}),
    tools: doc.tools.map(declaration),
  };
}

/**
 * Take a snapshot of a tool document — the toolkit's `ToolSnapshot`: the
 * kits as immutable JSON under a `sha256:` fingerprint, named so a ledger can
 * record WHICH document a rendering came from, and a refresh can tell
 * "nothing changed" without comparing rendered text. The fingerprint covers
 * the declared fields (names, descriptions, usage, kind, group, schemas, the
 * briefs). `origin` records where it was captured, outside the content hash;
 * an enclosing semantic or operation record includes it in its own fingerprint.
 */
export function toolSnapshot(kits: readonly KitDoc[], origin?: JsonObject): ToolSnapshot {
  return captureToolSnapshot(kits.map(kit), origin);
}

/** The fingerprint of a tool document: equal documents share it, any declared field moves it. */
export function toolFingerprint(kits: readonly KitDoc[]): string {
  return toolSnapshot(kits).fingerprint;
}

const asSnapshot = (doc: ToolDocument): ToolSnapshot =>
  Array.isArray(doc) ? toolSnapshot(doc) : doc;

export interface ToolBriefOptions {
  /**
   * Soft budget in characters. Over budget, usage lines are dropped (longest
   * first) until the text fits; names and descriptions are never dropped, so
   * the rendered list always matches the tool array. The compiled artifact
   * records the decision (`tool-budget`: what was dropped, before/after).
   */
  maxChars?: number;
  /**
   * Prefix tool names with their namespace (`seismos/sql`) — what a consumer
   * that merges several kits into one tool array does (the oracle's registry
   * projection prefixes exactly when more than one namespace is listed).
   */
  qualify?: boolean;
}

/** The options' former name. */
export type RenderToolBriefOptions = ToolBriefOptions;

/**
 * The tool brief as a prompt NODE — the toolkit's `ToolBrief` over the
 * snapshot — to place inside a larger prompt (a `Prompt`'s child renders it
 * after a blank line; an `Xml` child escapes it once). Compiled late: the
 * text and the budget decision are derived when the prompt is.
 */
export function toolBrief(doc: ToolDocument, options: ToolBriefOptions = {}): PromptNode {
  return ToolBrief({
    snapshot: asSnapshot(doc),
    ...(options.qualify !== undefined ? { qualify: options.qualify } : {}),
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
  });
}

/**
 * Render the brief as the prompt section every consumer shares: "Tools:",
 * the kits' briefs, then the tools under read/write/other headings, grouped,
 * each as `- name: description usage`, and the failure line. Deterministic:
 * the same documents always weave the same text, so a prompt can be diffed
 * across sessions and a refresh that changes nothing sends nothing. Returns
 * "" when there are no tools at all. The text is exactly the compiled
 * {@link toolBrief} part — a consumer that needs the record too calls
 * {@link renderPrompt} on the node instead.
 */
export function renderToolBrief(doc: ToolDocument, options: ToolBriefOptions = {}): string {
  return renderPrompt(toolBrief(doc, options)).text;
}

/**
 * The composition every consumer makes today: a preface (the oracle's woven
 * instructions, a backend's task prompt — any prompt value, a plain string
 * included), then the tool brief, a blank line between (a `Prompt`). A
 * preface that is empty or a document with no tools simply leaves nothing
 * behind, so the text is the preface alone, the brief alone, or "".
 */
export function instructionsWithToolBrief(
  preface: PromptValue,
  doc: ToolDocument | undefined,
  options?: ToolBriefOptions,
): PromptNode {
  return Prompt({ children: [preface, doc === undefined ? null : toolBrief(doc, options)] });
}

/** A prompt compiled for a text wire: the record to store, the artifact, the text. */
export interface RenderedPrompt {
  /** The semantic record — what a ledger stores. `rehydrate(record)` reproduces `text`. */
  record: SemanticRecord;
  /** The compiled artifact: parts, contributions, the decisions taken (budgets, cases). */
  compiled: CompiledPrompt;
  /** Every text part joined — what goes on the wire. */
  text: string;
}

/**
 * Snapshot a prompt value into its semantic record, compile the RECORD
 * (never the value — so what the ledger holds is proven to reproduce the
 * wire), and join its text. The wires this serves carry text only, so an
 * image part is an error here, not a silent drop. `options` are the
 * toolkit's: the captured facts a `Case` decides on (`context`) and the
 * `Choice` selection — both end up in the record.
 */
export function renderPrompt(value: PromptValue, options?: CompileOptions): RenderedPrompt {
  const record = snapshot(value, options);
  const compiled = rehydrate(record);
  let text = "";
  for (const part of compiled.parts) {
    if (part.type !== "text") {
      throw new Error(`renderPrompt: part ${part.id} is an image; this wire carries text only`);
    }
    text += part.text;
  }
  return { record, compiled, text };
}
