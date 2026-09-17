/**
 * tokens.ts — the 500-token append cap, handled. A conservative estimate
 * (no tokenizer in the browser) and a sentence-boundary chunker so a long
 * backend result becomes a short SEQUENCE of appends instead of an
 * `invalid_value` rejection.
 */

import { APPEND_TOKEN_LIMIT } from "./protocol";

/** ~3.5 characters per token: conservative for English prose, safer for
 * numbers and code, which tokenize denser. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Chunks of at most `maxTokens` (estimated), split at sentence ends, then
 * at whitespace, then hard. Order preserved; empty input → no chunks. */
export function chunkForAppend(text: string, maxTokens = Math.floor(APPEND_TOKEN_LIMIT * 0.7)) {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [] as string[];
  }
  if (approxTokens(trimmed) <= maxTokens) {
    return [trimmed];
  }
  const maxChars = Math.floor(maxTokens * 3.5);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim() !== "") {
      chunks.push(current.trim());
    }
    current = "";
  };
  for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > maxChars) {
      flush();
      for (const piece of hardSplit(sentence, maxChars)) {
        chunks.push(piece);
      }
      continue;
    }
    if ((current + (current === "" ? "" : " ") + sentence).length > maxChars) {
      flush();
    }
    current = current === "" ? sentence : `${current} ${sentence}`;
  }
  flush();
  return chunks;
}

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const cut = rest.lastIndexOf(" ", maxChars);
    const at = cut > maxChars / 2 ? cut : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== "") {
    out.push(rest);
  }
  return out;
}
