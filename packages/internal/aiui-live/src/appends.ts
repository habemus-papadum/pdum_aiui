/**
 * appends.ts — a backend result as the prompt toolkit's `Chunk`: the
 * 500-token append cap, handled where the record is. One record per text;
 * the toolkit cuts it into chunks within the budget at paragraph, line,
 * sentence or word boundaries (a hard cut only when nothing else fits) and
 * records the cut as a decision; each chunk is sent as its own append
 * operation naming its index, so the ledger links the appends through the
 * record's fingerprint and the inspector shows the ruler.
 */

import {
  Chunk,
  type CompiledPrompt,
  chunksOf,
  type Decision,
  type PromptNode,
  type SemanticRecord,
  Text,
} from "@habemus-papadum/aiui-prompts";
import { renderPrompt } from "@habemus-papadum/aiui-viz/tool-brief";
import { APPEND_TOKEN_LIMIT, type AppendKind } from "./protocol";

/** The budget one chunk is cut to: 70 percent of the cap, the margin for an estimate. */
export const APPEND_CHUNK_LIMIT = Math.floor(APPEND_TOKEN_LIMIT * 0.7);

/** The text of one append as a prompt value: a chunk over one authored text. */
export function appendValue(
  kind: AppendKind,
  text: string,
  delegationId: string | null,
): PromptNode {
  return Chunk({
    unit: "tokens",
    limit: APPEND_CHUNK_LIMIT,
    label: `append ${kind}`,
    children: [
      Text({
        value: text,
        origin: {
          site: `aiui-live append ${kind}`,
          ...(delegationId === null ? {} : { delegation: delegationId }),
        },
      }),
    ],
  });
}

export interface AppendChunk {
  index: number;
  count: number;
  text: string;
}

export interface AppendPlan {
  /** The one record every chunk's operation binds. */
  record: SemanticRecord;
  compiled: CompiledPrompt;
  chunks: readonly AppendChunk[];
  /** The recorded partition: count, cut points, boundary kinds, sizes. */
  decision: Decision | undefined;
}

/** Render the append once and slice it: what the session sends, and what the lab shows. */
export function planAppends(
  kind: AppendKind,
  text: string,
  delegationId: string | null,
): AppendPlan {
  const rendered = renderPrompt(appendValue(kind, text, delegationId));
  const chunks = chunksOf(rendered.compiled).map((slice) => ({
    index: slice.index,
    count: slice.count,
    text: slice.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
  }));
  return {
    record: rendered.record,
    compiled: rendered.compiled,
    chunks,
    decision: rendered.compiled.decisions.find((decision) => decision.kind === "chunk"),
  };
}
