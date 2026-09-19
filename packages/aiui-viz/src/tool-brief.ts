/**
 * tool-brief.ts — the tool surface rendered as a DOCUMENT for a model.
 *
 * A tool crosses every wire as `{ name, description, inputSchema }`, and a
 * tool definition alone does not say WHEN to call it, what its result means,
 * or how the app's tools relate. Both OpenAI voice prompting guides prescribe
 * exactly that text in the prompt (a `Tools` section with per-class rules; a
 * capability list for the voice model), and warn that the prompt must never
 * name a tool the tool list does not carry. So the text is DERIVED: this is
 * one pure function over the same tool documents every consumer already
 * holds, called in the same breath as the tool array is set, so the two
 * cannot drift (the tool-docs proposal, docs/proposals/tool-docs.md).
 *
 * Consumers: the oracle appends it to its woven instructions; the live
 * delegators put it in the backend instructions and the delegation message;
 * the panel's tool log shows it as "what the model sees". The channel does
 * NOT render it into prompts — Claude Code reads the structured form from
 * `page_tools_list` — so nothing here is on a billed prompt path by default.
 */

/** Eagerness class: `read` is called freely once the intent is clear; `write`
 * changes the app. Tools without one are listed under neither heading. */
export type ToolKind = "read" | "write";

/** One tool as the renderer needs it — the wire fields, minus `run`. */
export interface ToolDoc {
  name: string;
  description: string;
  usage?: string;
  kind?: ToolKind;
}

/** One kit's worth of tools, with its brief. */
export interface KitDoc {
  ns: string;
  brief?: string;
  tools: ToolDoc[];
}

export interface RenderToolBriefOptions {
  /**
   * Soft budget in characters. Over budget, usage lines are dropped (longest
   * first) until the text fits; names and descriptions are never dropped, so
   * the rendered list always matches the tool array.
   */
  maxChars?: number;
  /**
   * Prefix tool names with their namespace (`seismos/sql`) — what a consumer
   * that merges several kits into one tool array does (the oracle's registry
   * projection prefixes exactly when more than one namespace is listed).
   */
  qualify?: boolean;
}

const READ_HEADING = "Read tools (call freely once the intent is clear; no confirmation needed):";
const WRITE_HEADING =
  "Write tools (they change the app; the result is the value actually applied):";
const OTHER_HEADING = "Other tools:";
const FAILURE_LINE =
  "If a tool fails, say what failed in a few words and do not repeat the same call unchanged.";

function line(tool: ToolDoc, name: string, withUsage: boolean): string {
  const usage = withUsage && tool.usage !== undefined && tool.usage !== "" ? ` ${tool.usage}` : "";
  return `- ${name}: ${tool.description}${usage}`;
}

/**
 * Render kits as the prompt section every consumer shares. Deterministic:
 * the same documents always weave the same text, so a prompt can be diffed
 * across sessions and a refresh that changes nothing sends nothing.
 * Returns "" when there are no tools at all.
 */
export function renderToolBrief(kits: KitDoc[], options: RenderToolBriefOptions = {}): string {
  const live = kits.filter((k) => k.tools.length > 0 || (k.brief !== undefined && k.brief !== ""));
  if (live.length === 0) return "";
  const qualify = options.qualify ?? false;

  const named = live.flatMap((k) =>
    k.tools.map((tool) => ({ tool, name: qualify ? `${k.ns}/${tool.name}` : tool.name })),
  );
  const reads = named.filter((n) => n.tool.kind === "read");
  const writes = named.filter((n) => n.tool.kind === "write");
  const others = named.filter((n) => n.tool.kind === undefined);

  const render = (drop: Set<string>): string => {
    const parts: string[] = ["Tools:"];
    for (const k of live) {
      if (k.brief !== undefined && k.brief.trim() !== "") parts.push(k.brief.trim());
    }
    const section = (heading: string, rows: typeof named): void => {
      if (rows.length === 0) return;
      parts.push(heading);
      for (const row of rows) parts.push(line(row.tool, row.name, !drop.has(row.name)));
    };
    section(READ_HEADING, reads);
    section(WRITE_HEADING, writes);
    section(OTHER_HEADING, others);
    if (named.length > 0) parts.push(FAILURE_LINE);
    return parts.join("\n");
  };

  const drop = new Set<string>();
  let text = render(drop);
  if (options.maxChars !== undefined) {
    // Drop the longest usage first; stop when it fits or nothing is left.
    const byUsageLength = [...named]
      .filter((n) => n.tool.usage !== undefined && n.tool.usage !== "")
      .sort((a, b) => (b.tool.usage?.length ?? 0) - (a.tool.usage?.length ?? 0));
    for (const n of byUsageLength) {
      if (text.length <= options.maxChars) break;
      drop.add(n.name);
      text = render(drop);
    }
  }
  return text;
}
