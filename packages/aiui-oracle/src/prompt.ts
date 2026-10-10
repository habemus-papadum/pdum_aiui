/**
 * prompt.ts — the woven instructions: a standard persona plus the
 * integrator's app-specific portion, as a PROMPT of the prompt toolkit.
 * Seeded from the persona of record (packages/aiui-oracle/docs/oracle.md),
 * re-registered for the new role: the oracle is an APP's voice control
 * surface now, not a briefing side-channel.
 *
 * The sync rule (documented vendor failure mode: a prompt naming an absent
 * tool makes the model invent or pretend): the prompt may name a tool ONLY
 * when the text is derived from the tool array itself, in the same breath.
 * The persona and the app's slots stay generic about which tools exist; the
 * session appends a `Tools:` section it projects from its own tool array
 * (the toolkit's `ToolBrief` over the session's tool snapshot — the brief,
 * each tool's usage, read/write classes) whenever `setTools` runs, so the two
 * cannot drift. Hand-written tool prose in `app` / `extra` remains the thing
 * this rule forbids.
 *
 * Since stage 2 of the structured-prompts migration the weave is authored as
 * nodes ({@link instructionsPrompt}): the persona is one text with its own
 * origin, each slot is placed under its own key with the weaver's heading
 * and the app's value as separate contributions, and the session compiles
 * the whole with the tool brief late. The ledger therefore holds a record
 * that says which slot every line came from, not one opaque string.
 * {@link weaveInstructions} is that prompt rendered — the same text as
 * before, byte for byte.
 */

import { Join, Prompt, type PromptNode, Text, Use } from "@habemus-papadum/aiui-prompts";
import { renderPrompt } from "@habemus-papadum/aiui-viz";
import { renderTabRecord } from "./tab-record";
import type { Greeting, PromptSlots } from "./types";

export const ORACLE_BASE_PERSONA = `You are the oracle: a real-time voice assistant embedded in an interactive app. You answer questions about the app and drive it on the user's behalf through the tools you are given. Use as few words as possible — this is speech: no lists, no preamble, no recaps. When the user asks for a change, make it with a tool call; when it lands as asked, say only "done". Tools return the value actually applied — trust it over your intent, and don't announce it. Speak up only when the outcome differs from what was asked — a clamped, snapped, or coerced value, a change that only partly landed — and give just the difference: "capped at 8 hertz". When the divergence is too tangled to put in a phrase, say you couldn't fully apply the change. When translating the request into tool calls took some interpretation on your part — whether one call or several — you may surface it in a sentence: the approach, not the mechanics: "you asked to focus on Japan, so I centered the map there and zoomed in" — never a play-by-play of tool calls or a string of numbers. When asked a question, give a technically competent answer, brief and to the point; trust the user to ask follow-ups rather than explaining preemptively. If a tool fails, say what went wrong. Only use tools that are currently available; if something asked for has no tool, say so plainly. If unsure what the app currently shows, consult your tools before guessing.`;

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

/** Where a piece of the prompt came from, as the record names it. */
const origin = (site: string, extra: Record<string, string> = {}) => ({
  site: `aiui-oracle ${site}`,
  ...extra,
});

/**
 * The instructions as a prompt: the persona, then the app's slots in the
 * weaver's fixed order, each placed under its own key (`app`, `context`,
 * `stance`, `extra`) so the compiled record can say which slot a line came
 * from — the heading is the weaver's contribution, the value the app's.
 * Empty and absent slots are indistinguishable and both place nothing, so a
 * resolver can return a partial record without padding it. A `Prompt`
 * separates its children with a blank line, which is the weave's seam.
 * A `context` given as a tab record is rendered here as the canonical
 * `<tab …/>` element (`./tab-record`'s one renderer), and the record says so
 * (`form: "tab"`), so every host describes the page the same way.
 *
 * The session composes this with the tool brief and compiles it late; the
 * facts the resolver saw ride in the record's context, so a ledger reader
 * can tell a start from a reconnect without re-running the app's resolver.
 */
export function instructionsPrompt(slots: PromptSlots = {}): PromptNode {
  const persona = Text({ value: ORACLE_BASE_PERSONA, label: "persona", origin: origin("persona") });
  const placed = SLOT_HEADINGS.map(([slot, heading]) => {
    const given = slots[slot];
    if (given === undefined || given === "") {
      return null;
    }
    const value =
      typeof given === "string"
        ? Text({ value: given, origin: origin("slot", { slot }) })
        : Text({ value: renderTabRecord(given), origin: origin("slot", { slot, form: "tab" }) });
    const content = Join({
      separator: " ",
      children: [
        heading === "" ? null : Text({ value: heading, origin: origin("slot heading", { slot }) }),
        value,
      ],
    });
    return Use({ key: slot, label: slot, value: content });
  });
  return Prompt({ children: [persona, ...placed] });
}

/**
 * Weave the standard persona with the app's own slots, in the table's fixed
 * order — {@link instructionsPrompt} rendered to its text. Kept for callers
 * that want the string (the corpus, a host showing "what the model reads");
 * the session itself keeps the prompt and compiles it with the tool brief.
 */
export function weaveInstructions(slots: PromptSlots = {}): string {
  return renderPrompt(instructionsPrompt(slots)).text;
}

/**
 * The greeting as a prompt — the per-response instructions the session
 * sends right after connecting (see `OracleConfig.greeting` for why a
 * greeting exists at all: echo-canceller priming, not decoration).
 *
 * A plain string is the PRIMING form: the model is told to say exactly it
 * and nothing else, so the line is predictable and disposable — the frame is
 * the oracle's contribution, the line the app's, and the record keeps them
 * apart. The object form hands the model a brief instead. Nothing to say
 * (undefined, or an empty string either way) is `undefined`: no greeting is
 * sent, and the echo window keeps its no-greeting rules.
 */
export function greetingPrompt(greeting: Greeting | undefined): PromptNode | undefined {
  if (greeting === undefined) {
    return undefined;
  }
  if (typeof greeting === "string") {
    if (greeting === "") {
      return undefined;
    }
    return Join({
      separator: "",
      label: "greeting",
      children: [
        Text({
          value: 'Open the conversation by saying exactly: "',
          origin: origin("greeting frame"),
        }),
        Text({ value: greeting, origin: origin("config.greeting") }),
        Text({ value: '". Say nothing else.', origin: origin("greeting frame") }),
      ],
    });
  }
  if (greeting.instructions === "") {
    return undefined;
  }
  return Text({
    value: greeting.instructions,
    label: "greeting",
    origin: origin("config.greeting.instructions"),
  });
}
