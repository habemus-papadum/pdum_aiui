/**
 * prompt.ts — the woven instructions: a standard persona plus the
 * integrator's app-specific portion. Seeded from the persona of record
 * (packages/aiui-oracle/docs/oracle.md), re-registered for the new role: the oracle is an
 * APP's voice control surface now, not a briefing side-channel.
 *
 * The sync rule (documented vendor failure mode): the persona stays GENERIC
 * about which tools exist — the `tools` array is the single source of truth,
 * and a prompt naming an absent tool makes the model invent or pretend.
 */

export const ORACLE_BASE_PERSONA = `You are the oracle: a real-time voice assistant embedded in an interactive app. You answer questions about the app and drive it on the user's behalf through the tools you are given. Use as few words as possible — this is speech: no lists, no preamble, no recaps. When the user asks for a change, make it with a tool call; when it lands as asked, say only "done". Tools return the value actually applied — trust it over your intent, and don't announce it. Speak up only when the outcome differs from what was asked — a clamped, snapped, or coerced value, a change that only partly landed — and give just the difference: "capped at 8 hertz". When the divergence is too tangled to put in a phrase, say you couldn't fully apply the change. When translating the request into tool calls took some interpretation on your part — whether one call or several — you may surface it in a sentence: the approach, not the mechanics: "you asked to focus on Japan, so I centered the map there and zoomed in" — never a play-by-play of tool calls or a string of numbers. When asked a question, give a technically competent answer, brief and to the point; trust the user to ask follow-ups rather than explaining preemptively. If a tool fails, say what went wrong. Only use tools that are currently available; if something asked for has no tool, say so plainly. If unsure what the app currently shows, consult your tools before guessing.`;

import type { PromptSlots } from "./types";

/**
 * The slot name a caller passes, paired with the heading the model reads.
 *
 * The headings are the weaver's, not the caller's — that is the whole point
 * of named slots. An app supplies the content of "where the user is right
 * now"; it does not get to decide whether that section is called "Right now"
 * or "Current page" or nothing at all, because then two apps' prompts stop
 * being comparable and a shared persona stops being shared.
 *
 * `extra` renders bare: it is the escape hatch, and an escape hatch that
 * imposed a heading would just be a fifth slot with a worse name.
 */
const SLOT_HEADINGS: ReadonlyArray<readonly [keyof PromptSlots, string]> = [
  ["app", "About this app:"],
  ["context", "Right now:"],
  ["stance", "For this conversation:"],
  ["extra", ""],
];

/**
 * @deprecated The name from when there were two free-text fields. Use
 * {@link PromptSlots}; this alias keeps existing callers compiling.
 */
export type WeaveOptions = PromptSlots;

/**
 * Weave the standard persona with the app's own slots, in the table's fixed
 * order. Empty and absent slots are indistinguishable and both render
 * nothing, so a resolver can return a partial record without padding it.
 *
 * Every piece of the result is inspectable — the session ledger records the
 * woven whole, which is what makes a prompt bug a thing you can read rather
 * than a thing you infer.
 */
export function weaveInstructions(slots: PromptSlots = {}): string {
  const pieces = [ORACLE_BASE_PERSONA];
  for (const [slot, heading] of SLOT_HEADINGS) {
    const value = slots[slot];
    if (value === undefined || value === "") {
      continue;
    }
    pieces.push(heading === "" ? value : `${heading} ${value}`);
  }
  return pieces.join("\n\n");
}
