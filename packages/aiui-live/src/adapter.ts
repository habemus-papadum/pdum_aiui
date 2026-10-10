/**
 * adapter.ts — the live session's own delivery protocol as a consumer-owned,
 * versioned adapter for the prompt toolkit (`aiui-live/session@1`).
 *
 * The toolkit's utility `live-session/1` profile covers the APPENDS; the
 * connect config is this package's protocol: the whole `session` object
 * handed to a transport (`session.start` over WebSocket, the POST body over
 * WebRTC). The adapter derives that object COMPLETELY from recorded inputs —
 * the instructions binding, the hosted backend's instructions binding, the
 * re-seed preface binding, and plain-JSON params (model, audio, delegation,
 * the hosted tool schemas, the seed history) — so `verifyWire` can compare
 * the whole payload exactly, which is the toolkit's rule: no ignored fields.
 *
 * Keep every retained version importable: a ledger holding an
 * `aiui-live/session@1` operation can only be verified by this very code.
 */

import type { CompiledPrompt, JsonObject, JsonValue } from "@habemus-papadum/aiui-prompts";
import type {
  ConsumerAdapter,
  ConsumerAdapterInput,
  DeliveryMap,
} from "@habemus-papadum/aiui-prompts/operations";
import type {
  LiveAudioConfig,
  LiveBackendTool,
  LiveDelegationConfig,
  LiveInputMessage,
  LiveSessionConfig,
} from "./protocol.ts";

export const LIVE_SESSION_ADAPTER_IDENTITY = Object.freeze({
  name: "aiui-live/session",
  version: "1",
});

/** The binding keys the `connect` action reads. */
export const LIVE_CONNECT_BINDINGS = Object.freeze({
  /** The session instructions (required). */
  instructions: "instructions",
  /** The hosted Responses backend's instructions — present when the session
   * manages the hosted backend's tool config. */
  backendInstructions: "backend-instructions",
  /** The developer message that prefaces a re-seeded transcript; compiles to
   * nothing when the session is not re-seeding. */
  reseedPreface: "reseed-preface",
  /** The re-seeded transcript itself: every line a keyed text with its role,
   * under a tail elision by token budget — which lines made it is the
   * record's decision, and the messages derive through its maps. */
  seed: "seed",
});

/** A line of the seed record: its message role rides on the text's origin. */
const ROLE = { user: "user", assistant: "assistant" } as const;

/**
 * The seed's messages, derived from the compiled record through its maps —
 * never by parsing text: each occurrence keyed `line:N` is one line, its
 * contribution the exact range in the text part, its definition origin the
 * role. Used by the adapter to build `input`, and by the session to say what
 * a re-seeded start would send.
 */
export function seedMessages(compiled: CompiledPrompt): LiveInputMessage[] {
  const lines: { start: number; message: LiveInputMessage; occurrence: string }[] = [];
  for (const occurrence of compiled.occurrences) {
    if (occurrence.key === undefined || !occurrence.key.startsWith("line:")) continue;
    const contribution = compiled.contributions.find(
      (item) => item.occurrence === occurrence.id && item.start !== undefined,
    );
    const part = compiled.parts.find((item) => item.id === contribution?.part);
    if (
      contribution?.start === undefined ||
      contribution.end === undefined ||
      part?.type !== "text"
    )
      continue;
    const role = occurrence.definitionOrigin?.role;
    const text = part.text.slice(contribution.start, contribution.end);
    lines.push({
      start: contribution.start,
      occurrence: occurrence.id,
      message:
        role === ROLE.assistant
          ? { role: "assistant", content: [{ type: "output_text", text }] }
          : { role: "user", content: [{ type: "input_text", text }] },
    });
  }
  return lines.sort((a, b) => a.start - b.start).map((line) => line.message);
}

/** The `connect` action's recorded parameters — everything in the wire
 * config that is not prompt content. Plain JSON acquired by the host. */
export interface LiveConnectParams {
  model: string;
  audio: LiveAudioConfig;
  /** The delegation config as authored, WITHOUT the hosted `tools` and
   * `instructions` the session manages (those come from `backendTools` and
   * the `backend-instructions` binding). */
  delegation: LiveDelegationConfig;
  /** The hosted backend's function tools, when the session manages them. */
  backendTools?: LiveBackendTool[];
  store?: boolean;
  /** An explicit `config.input`: opaque seed messages the host supplied, in
   * order, after any re-seeded lines. A re-seeded transcript is not here —
   * it is the `seed` binding, a record. */
  history?: LiveInputMessage[];
}

/** The recorded parameters, read back (the adapter never re-validates
 * beyond what the operation boundary did; shape errors surface as thrown
 * TypeErrors the framework reports). */
function params(input: ConsumerAdapterInput): LiveConnectParams {
  return input.operation.params as unknown as LiveConnectParams;
}

/**
 * The live session adapter, version 1: one action, `connect`, text content
 * only, no media. The payload is the exact `LiveSessionConfig` the session
 * hands its transport.
 */
export const LIVE_SESSION_ADAPTER: ConsumerAdapter = {
  identity: LIVE_SESSION_ADAPTER_IDENTITY,
  capabilities: { actions: ["connect"], content: ["text"], assets: [] },
  lower(input) {
    if (input.operation.action !== "connect") {
      throw new Error(`aiui-live/session@1 lowers connect only, not ${input.operation.action}`);
    }
    const p = params(input);
    const mappings: DeliveryMap[] = [];
    const bound = new Map(input.bindings.map((binding) => [binding.key, binding]));
    /** The one text part of a binding, mapped to `path` as a whole copy. */
    const text = (key: string, path: (string | number)[]): string => {
      const binding = bound.get(key);
      if (binding === undefined) return "";
      let out = "";
      for (const part of binding.compiled.parts) {
        if (part.type !== "text") throw new Error("the live session config carries text only");
        mappings.push({
          path,
          binding: key,
          record: binding.record,
          part: part.id,
          start: out.length,
          end: out.length + part.text.length,
          relation: "copy",
        });
        out += part.text;
      }
      return out;
    };
    const instructions = text(LIVE_CONNECT_BINDINGS.instructions, ["instructions"]);
    let delegation: LiveDelegationConfig = p.delegation;
    if (p.backendTools !== undefined) {
      if (delegation.type !== "responses") {
        throw new Error("hosted backend tools need a responses delegation");
      }
      const backend = text(LIVE_CONNECT_BINDINGS.backendInstructions, [
        "delegation",
        "responses",
        "instructions",
      ]);
      delegation = {
        type: "responses",
        responses: {
          ...delegation.responses,
          tools: p.backendTools,
          ...(backend !== "" ? { instructions: backend } : {}),
        },
      };
    }
    const preface = text(LIVE_CONNECT_BINDINGS.reseedPreface, ["input", 0, "content", 0, "text"]);
    const prefaced: LiveInputMessage[] =
      preface === ""
        ? []
        : [{ role: "developer", content: [{ type: "input_text", text: preface }] }];
    // The re-seeded lines, each mapped to the message it became. A copy map
    // must cover a whole text part, so a line (a range of the seed's one
    // part) is a generated field that names its occurrence.
    const seed = bound.get(LIVE_CONNECT_BINDINGS.seed);
    const seeded = seed === undefined ? [] : seedMessages(seed.compiled);
    if (seed !== undefined) {
      const part = seed.compiled.parts.find((item) => item.type === "text");
      let index = prefaced.length;
      for (const occurrence of seed.compiled.occurrences) {
        if (occurrence.key === undefined || !occurrence.key.startsWith("line:")) continue;
        const contribution = seed.compiled.contributions.find(
          (item) => item.occurrence === occurrence.id && item.start !== undefined,
        );
        if (contribution === undefined || part === undefined) continue;
        // Bounds are the addressed field's (the whole message text); where
        // the line sits in the seed's text part rides on the origin.
        mappings.push({
          path: ["input", index, "content", 0, "text"],
          binding: LIVE_CONNECT_BINDINGS.seed,
          record: seed.record,
          part: part.id,
          start: 0,
          end: (contribution.end ?? 0) - (contribution.start ?? 0),
          relation: "generated",
          origin: {
            occurrence: occurrence.id,
            start: contribution.start ?? 0,
            end: contribution.end ?? 0,
          },
        });
        index++;
      }
    }
    const input_: LiveInputMessage[] | undefined =
      seeded.length === 0 && p.history === undefined
        ? undefined
        : [...prefaced, ...seeded, ...(p.history ?? [])];
    const payload: LiveSessionConfig = {
      model: p.model,
      instructions,
      audio: p.audio,
      delegation,
      ...(p.store !== undefined ? { store: p.store } : {}),
      ...(input_ !== undefined ? { input: input_ } : {}),
    };
    // A mapping may only address a field that exists: an absent preface or
    // backend text has no path to point at.
    const present = mappings.filter((map) => addressed(payload as unknown as JsonValue, map.path));
    const decisions: JsonObject[] = [
      {
        kind: "live-session/connect",
        hostedTools: p.backendTools?.length ?? 0,
        seedMessages: input_?.length ?? 0,
        // The seed's own cut (the tail elision's decision), as the record made it.
        ...(seed !== undefined
          ? {
              seed: (seed.compiled.decisions.find((d) => d.kind === "elide")?.detail ??
                {}) as JsonObject,
            }
          : {}),
      },
    ];
    return { payload: payload as unknown as JsonValue, mappings: present, decisions };
  },
};

function addressed(value: JsonValue, path: readonly (string | number)[]): boolean {
  let at: JsonValue = value;
  for (const segment of path) {
    if (at === null || typeof at !== "object") return false;
    if (Array.isArray(at)) {
      if (typeof segment !== "number" || segment >= at.length) return false;
      at = at[segment] as JsonValue;
    } else {
      if (typeof segment !== "string" || !Object.hasOwn(at, segment)) return false;
      at = (at as JsonObject)[segment] as JsonValue;
    }
  }
  return true;
}
