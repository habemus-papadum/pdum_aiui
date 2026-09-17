/**
 * fake.ts — backends with no brain, for measuring the voice side alone: how
 * long a delegation takes to arrive, how long an append takes to be spoken,
 * what a progress line sounds like at 3 s vs 9 s. Every number in the wire
 * lab comes from these before any real model is involved.
 */

import type { DelegationRequest, Delegator } from "../types";

export interface ScriptedDelegatorOptions {
  /** Wall time before the reply. Default 1500. */
  delayMs?: number;
  /** The reply, or a function of the request. */
  reply?: string | ((req: DelegationRequest) => string);
  /** Optional quiet notes at these offsets (ms) while waiting. */
  notesAt?: Array<{ atMs: number; text: string; spoken?: boolean }>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });

/** Wait, optionally narrate, then answer. */
export function scriptedDelegator(options: ScriptedDelegatorOptions = {}): Delegator {
  const delayMs = options.delayMs ?? 1500;
  return {
    name: "scripted",
    describe: () => `scripted (${delayMs} ms)`,
    async handle(req) {
      req.log(`waiting ${delayMs} ms`);
      let elapsed = 0;
      for (const note of [...(options.notesAt ?? [])].sort((a, b) => a.atMs - b.atMs)) {
        if (note.atMs >= delayMs) {
          break;
        }
        await sleep(note.atMs - elapsed, req.signal);
        elapsed = note.atMs;
        await (note.spoken ? req.say(note.text) : req.note(note.text));
      }
      await sleep(delayMs - elapsed, req.signal);
      const reply = options.reply ?? ((r: DelegationRequest) => `Done. You asked: ${r.text}`);
      return typeof reply === "function" ? reply(req) : reply;
    },
  };
}

/** Answers instantly with what it heard — the round-trip floor. */
export function echoDelegator(): Delegator {
  return {
    name: "echo",
    async handle(req) {
      return req.text === ""
        ? "I heard you, but the transcript is empty."
        : `You said: ${req.text}`;
    },
  };
}
