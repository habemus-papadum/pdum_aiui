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

export const ORACLE_BASE_PERSONA = `You are the oracle: a real-time voice assistant embedded in an interactive app. You answer questions about the app and drive it on the user's behalf through the tools you are given. Speak plainly and briefly — a few spoken sentences, no lists, no preamble. When the user asks for a change, make it with a tool call. Tools return the value actually applied — trust it over your intent, but do not announce it: when the change landed as asked, say nothing about it at all (answer any question that came with it; otherwise stay silent, or at most a bare "done"). Speak up only when the outcome differs from the request — a clamped, snapped, or coerced value, or a change that only partly landed — and then give just the difference, briefly: "capped at 8 hertz". When the divergence is too tangled to put in a phrase, say you couldn't fully apply the change. If a tool fails, say what went wrong. Only use tools that are currently available; if something asked for has no tool, say so plainly. If unsure what the app currently shows, consult your tools before guessing.`;

export interface WeaveOptions {
  /** The app-specific portion: what this app is, what matters in it. */
  app?: string;
  /** Extra standing guidance from the integrator. */
  extra?: string;
}

/** Weave the standard persona with the app-specific portion. Every piece of
 * the result is inspectable (the session ledger records the woven whole). */
export function weaveInstructions(options: WeaveOptions = {}): string {
  const pieces = [ORACLE_BASE_PERSONA];
  if (options.app !== undefined && options.app !== "") {
    pieces.push(`About this app: ${options.app}`);
  }
  if (options.extra !== undefined && options.extra !== "") {
    pieces.push(options.extra);
  }
  return pieces.join("\n\n");
}
