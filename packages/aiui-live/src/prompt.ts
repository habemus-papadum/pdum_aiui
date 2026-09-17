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
 * Measured (2026-09-15): the voice model PARAPHRASES commentary — "Frequency
 * set to 5 hertz." came out as "Done." — and it narrates a thinking append
 * only when the prompt tells it to. Wording that must survive goes through
 * an instructions append, not commentary.
 */

import type { LivePromptSlots } from "./types";

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
}

/** Compose the session instructions. Deterministic — the same slots always
 * weave the same text, so a prompt can be diffed across sessions. */
export function livePrompt(slots: LivePromptSlots = {}, options: LivePromptOptions = {}): string {
  const parts: string[] = [options.persona ?? LIVE_BASE_PERSONA];
  if (slots.app !== undefined && slots.app.trim() !== "") {
    parts.push(`About this app:\n${slots.app.trim()}`);
  }
  if (slots.stance !== undefined && slots.stance.trim() !== "") {
    parts.push(`For this conversation:\n${slots.stance.trim()}`);
  }
  parts.push(`Backchannel policy: ${options.backchannel ?? DEFAULT_BACKCHANNEL_POLICY}`);
  parts.push(`Interruption policy: ${options.interruption ?? DEFAULT_INTERRUPTION_POLICY}`);
  parts.push(
    [
      "Delegation policy:",
      "Backend tools:",
      (slots.backendTools ?? DEFAULT_BACKEND_TOOLS).trim(),
      "",
      "Delegate to the backend when:",
      (slots.delegateWhen ?? DEFAULT_DELEGATE_WHEN).trim(),
      "",
      "Do not delegate to the backend when:",
      (slots.dontDelegateWhen ?? DEFAULT_DONT_DELEGATE_WHEN).trim(),
      "",
      DELEGATION_CLOSING,
    ].join("\n"),
  );
  if (slots.extra !== undefined && slots.extra.trim() !== "") {
    parts.push(slots.extra.trim());
  }
  return parts.join("\n\n");
}

export interface BackendPromptOptions {
  /** What the app is, for the backend. */
  app?: string;
  /** The backend's task instructions. */
  task?: string;
  /** Extra return-format guidance. */
  returnFormat?: string;
}

/** The vendor's recommended three-section backend prompt for a Responses
 * (or any text) backend: voice context, task, return format. */
export function backendPrompt(options: BackendPromptOptions = {}): string {
  return [
    "## Voice conversation context",
    `You are helping an assistant in a live voice conversation${options.app !== undefined ? ` about ${options.app.trim()}` : ""}. Transcripts can contain mistakes. Use the latest context.`,
    "",
    "## Task instructions",
    (
      options.task ??
      "Use the available tools to do what the user asked. Read before you change. Do not invent a successful action."
    ).trim(),
    "",
    "## Return the result",
    (
      options.returnFormat ??
      "Return the relevant facts in one or two short spoken sentences, using the values the tools actually applied. No markdown, no lists."
    ).trim(),
  ].join("\n");
}
