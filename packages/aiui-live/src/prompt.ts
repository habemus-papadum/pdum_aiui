/**
 * prompt.ts — the live prompt, composed from slots in the vendor's own
 * template order (live-prompting guide): personality, backchannel policy,
 * interruption policy, delegation policy with its three labelled lists, and
 * the closing rule about not guessing.
 *
 * Why slots and not one string: the oracle's lesson. `app` is standing and
 * never changes; `stance` is per conversation; the three delegation slots
 * are what an integrator actually tunes. Anything else is `extra`.
 *
 * Since the prompt toolkit (docs/proposals/structured-prompts-review.md,
 * stage 2) the composition is a prompt VALUE — `livePromptValue` — of
 * authored nodes: every slot a keyed placement with its origin, the
 * capability list the toolkit's `CapabilityList` projection of the tool
 * snapshot, and the string functions below its compiled text. The session
 * stores the record; the text on the wire is byte-for-byte what the string
 * functions always produced.
 *
 * Measured (2026-09-15): the voice model PARAPHRASES commentary — "Frequency
 * set to 5 hertz." came out as "Done." — and it narrates a thinking append
 * only when the prompt tells it to. Wording that must survive goes through
 * an instructions append, not commentary.
 */

import {
  CapabilityList,
  Group,
  Join,
  Prompt,
  type PromptNode,
  type PromptValue,
  Text,
  Use,
} from "@habemus-papadum/aiui-prompts";
import { renderPrompt, toolSnapshot } from "@habemus-papadum/aiui-viz/tool-brief";
import type { LivePromptSlots } from "./types.ts";

export const LIVE_BASE_PERSONA = `You are the oracle: a calm, brief voice embedded in a scientific visualization app.
You speak plainly, in short sentences, no lists, no preamble. You are a colleague at the bench, not a narrator.
You never read numbers as long decimals; round to what matters.`;

export const DEFAULT_BACKCHANNEL_POLICY =
  "Use light backchannels. Acknowledge naturally without competing with the main response.";

export const DEFAULT_INTERRUPTION_POLICY =
  "Stop speaking when the user interrupts. Listen to what they say. Do not restart what you were saying unless asked.";

export const DEFAULT_BACKEND_TOOLS = `- App control: read the app's current settings and change them.
- Analysis: investigate questions about the app's behaviour by reading its code and state; this can take a while.`;

export const DEFAULT_DELEGATE_WHEN = `- The user asks to change a setting, or asks what a setting currently is.
- The user asks why the app behaves some way, or anything that needs careful reasoning or reading code.`;

export const DEFAULT_DONT_DELEGATE_WHEN = `- The user greets you, thanks you, or asks you to repeat a result already provided.
- The user is thinking aloud and has not asked for anything yet.`;

export const DELEGATION_CLOSING = `Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.
When the backend reports progress, relay it in a few words and keep listening. When it reports a result, give it faithfully; keep the numbers it gave.
If the backend says it could not finish, say so plainly and offer to try again.`;

export interface LivePromptOptions {
  persona?: string;
  backchannel?: string;
  interruption?: string;
  /**
   * The capability list DERIVED from the tool array ({@link backendToolsList}),
   * which the session passes so the voice model reads the list the backend
   * actually has. The authored `backendTools` slot is then its PREFACE —
   * abilities the tool array cannot express, like reading the app's source.
   * Without it the slot (or the default text) stands alone.
   */
  backendToolsList?: PromptValue;
}

/** A node's provenance: which constant or slot of this package authored it. */
const site = (name: string) => ({ site: `aiui-live ${name}` });

/** A fixed text of this package, under its constant's name. */
const fixed = (value: string, name: string): PromptNode =>
  Text({ value, label: name, origin: site(name) });

/** An app-authored slot, trimmed, under the slot's name. */
const authored = (value: string, slot: keyof LivePromptSlots): PromptNode =>
  Text({ value, label: slot, origin: site(`LivePromptSlots.${slot}`) });

/** A label line, then the body on the next line. */
const labelled = (label: string, body: PromptValue): PromptNode =>
  Join({ separator: "\n", children: [Text({ value: label, origin: site("label") }), body] });

/**
 * The voice model's `Backend tools:` capability list as a prompt NODE — the
 * toolkit's `CapabilityList` projection of the tool snapshot: the brief's
 * first sentence as `- App: …`, then one sentence per tool (the vendor's
 * template: "what the backend can do"). One sentence each because the voice
 * model decides WHETHER to delegate; the procedure (clamping, re-reads,
 * retries) is the backend's reading — on seismos the full descriptions ran
 * to 5.9 KB, a manual, not a capability list (measured 2026-10-08). Renders
 * to nothing with nothing to say.
 */
export function backendToolsList(
  tools: ReadonlyArray<{ name: string; description: string }>,
  brief?: string,
): PromptNode {
  return CapabilityList({
    snapshot: toolSnapshot([{ ns: "app", ...(brief !== undefined ? { brief } : {}), tools }]),
    label: "backend-tools",
  });
}

/**
 * The capability list as text ({@link backendToolsList} compiled), or
 * undefined with nothing to say (the default text applies). The
 * hand-maintained copy this replaced drifted from the tool array; this one
 * cannot.
 */
export function backendToolsFromTools(
  tools: ReadonlyArray<{ name: string; description: string }>,
  brief?: string,
): string | undefined {
  const text = renderPrompt(backendToolsList(tools, brief)).text;
  return text === "" ? undefined : text;
}

/**
 * The session instructions as a prompt VALUE: the persona, the app's slots in
 * the template's fixed order, the policies, the delegation block. Every slot
 * is a keyed placement (`persona`, `app`, `stance`, `backchannel`,
 * `interruption`, `delegation`, `extra`), so the record says which slot a
 * line came from. Prompt children are separated by a blank line; an absent
 * or empty slot leaves nothing behind.
 */
export function livePromptValue(
  slots: LivePromptSlots = {},
  options: LivePromptOptions = {},
): PromptNode {
  const trimmed = (slot: "app" | "stance" | "extra"): string | undefined => {
    const value = slots[slot];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  };
  const app = trimmed("app");
  const stance = trimmed("stance");
  const extra = trimmed("extra");
  const preface = slots.backendTools === undefined ? undefined : slots.backendTools.trim();
  const backendTools: PromptValue =
    options.backendToolsList !== undefined
      ? Join({
          separator: "\n",
          children: [
            preface === undefined || preface === "" ? null : authored(preface, "backendTools"),
            options.backendToolsList,
          ],
        })
      : preface === undefined
        ? fixed(DEFAULT_BACKEND_TOOLS, "DEFAULT_BACKEND_TOOLS")
        : authored(preface, "backendTools");
  const policy = (label: string, value: string | undefined, fallback: string, name: string) =>
    Group({
      children: [
        Text({ value: `${label}: `, origin: site("label") }),
        value === undefined
          ? fixed(fallback, name)
          : Text({ value, origin: site(`LivePromptOptions.${name}`) }),
      ],
    });
  return Prompt({
    children: [
      Use({
        key: "persona",
        value:
          options.persona === undefined
            ? fixed(LIVE_BASE_PERSONA, "LIVE_BASE_PERSONA")
            : Text({ value: options.persona, origin: site("LivePromptOptions.persona") }),
      }),
      app === undefined
        ? null
        : Use({ key: "app", value: labelled("About this app:", authored(app, "app")) }),
      stance === undefined
        ? null
        : Use({
            key: "stance",
            value: labelled("For this conversation:", authored(stance, "stance")),
          }),
      Use({
        key: "backchannel",
        value: policy(
          "Backchannel policy",
          options.backchannel,
          DEFAULT_BACKCHANNEL_POLICY,
          "DEFAULT_BACKCHANNEL_POLICY",
        ),
      }),
      Use({
        key: "interruption",
        value: policy(
          "Interruption policy",
          options.interruption,
          DEFAULT_INTERRUPTION_POLICY,
          "DEFAULT_INTERRUPTION_POLICY",
        ),
      }),
      Use({
        key: "delegation",
        value: Join({
          separator: "\n\n",
          children: [
            Join({
              separator: "\n",
              children: [
                Text({ value: "Delegation policy:", origin: site("label") }),
                Text({ value: "Backend tools:", origin: site("label") }),
                backendTools,
              ],
            }),
            labelled(
              "Delegate to the backend when:",
              slots.delegateWhen === undefined
                ? fixed(DEFAULT_DELEGATE_WHEN, "DEFAULT_DELEGATE_WHEN")
                : authored(slots.delegateWhen.trim(), "delegateWhen"),
            ),
            labelled(
              "Do not delegate to the backend when:",
              slots.dontDelegateWhen === undefined
                ? fixed(DEFAULT_DONT_DELEGATE_WHEN, "DEFAULT_DONT_DELEGATE_WHEN")
                : authored(slots.dontDelegateWhen.trim(), "dontDelegateWhen"),
            ),
            fixed(DELEGATION_CLOSING, "DELEGATION_CLOSING"),
          ],
        }),
      }),
      extra === undefined ? null : Use({ key: "extra", value: authored(extra, "extra") }),
    ],
  });
}

/** Compose the session instructions as text — {@link livePromptValue}
 * compiled. Deterministic: the same slots always weave the same text, so a
 * prompt can be diffed across sessions. */
export function livePrompt(slots: LivePromptSlots = {}, options: LivePromptOptions = {}): string {
  return renderPrompt(livePromptValue(slots, options)).text;
}

export interface BackendPromptOptions {
  /** What the app is, for the backend. */
  app?: string;
  /** The backend's task instructions. */
  task?: string;
  /** Extra return-format guidance. */
  returnFormat?: string;
}

export const DEFAULT_BACKEND_TASK =
  "Use the available tools to do what the user asked. Read before you change. Do not invent a successful action.";

export const DEFAULT_BACKEND_RETURN_FORMAT =
  "Return the relevant facts in one or two short spoken sentences, using the values the tools actually applied. No markdown, no lists.";

/**
 * The vendor's recommended three-section backend prompt for a Responses (or
 * any text) backend, as a prompt VALUE: voice context, task, return format.
 * The headings are authored `## ` lines, not toolkit Sections: a Section's
 * depth comes from its placement, and at the root that is `#`.
 */
export function backendPromptValue(options: BackendPromptOptions = {}): PromptNode {
  const section = (title: string, body: PromptValue, key: string): PromptNode =>
    Use({
      key,
      value: Join({
        separator: "\n",
        children: [Text({ value: `## ${title}`, origin: site("label") }), body],
      }),
    });
  return Prompt({
    children: [
      section(
        "Voice conversation context",
        Group({
          children: [
            Text({
              value: "You are helping an assistant in a live voice conversation",
              origin: site("backendPrompt"),
            }),
            options.app === undefined
              ? null
              : Group({
                  children: [
                    Text({ value: " about ", origin: site("backendPrompt") }),
                    Text({
                      value: options.app.trim(),
                      label: "app",
                      origin: site("BackendPromptOptions.app"),
                    }),
                  ],
                }),
            Text({
              value: ". Transcripts can contain mistakes. Use the latest context.",
              origin: site("backendPrompt"),
            }),
          ],
        }),
        "context",
      ),
      section(
        "Task instructions",
        options.task === undefined
          ? fixed(DEFAULT_BACKEND_TASK, "DEFAULT_BACKEND_TASK")
          : Text({
              value: options.task.trim(),
              label: "task",
              origin: site("BackendPromptOptions.task"),
            }),
        "task",
      ),
      section(
        "Return the result",
        options.returnFormat === undefined
          ? fixed(DEFAULT_BACKEND_RETURN_FORMAT, "DEFAULT_BACKEND_RETURN_FORMAT")
          : Text({
              value: options.returnFormat.trim(),
              label: "returnFormat",
              origin: site("BackendPromptOptions.returnFormat"),
            }),
        "return",
      ),
    ],
  });
}

/** The backend prompt as text — {@link backendPromptValue} compiled. */
export function backendPrompt(options: BackendPromptOptions = {}): string {
  return renderPrompt(backendPromptValue(options)).text;
}
