/**
 * realtime-adapter.ts — the oracle's own lowering of a session config to
 * the OpenAI Realtime wire, as a consumer adapter of the prompt toolkit.
 *
 * Why the oracle owns one: the toolkit's `openai-realtime/1` profile lowers
 * an instructions-only `session.update`, and `verifyWire` compares the whole
 * event exactly — no ignored fields. The oracle's update carries more than
 * instructions (the audio block with the echo guard's suppression, the tool
 * schemas, the output-token limit, the reasoning effort) and its baked
 * config carries the model and the voice too. So the complete event is
 * derived HERE from recorded inputs: the instructions as a semantic binding,
 * everything else as plain parameters the session already holds at send
 * time — captured, not read back at replay. A reader with the operation
 * record and this adapter reproduces the event that left; a reader with the
 * wire record alone can at least see it.
 *
 * Versioned with the protocol it emits. A change to the event's shape is a
 * new version beside this one; stored records name the version they were
 * lowered with, and the session supplies every retained implementation.
 */

import type { JsonObject, JsonValue } from "@habemus-papadum/aiui-prompts";
import { PromptError } from "@habemus-papadum/aiui-prompts";
import type {
  AdapterIdentity,
  ConsumerAdapter,
  DeliveryMap,
} from "@habemus-papadum/aiui-prompts/operations";

/** The identity stored records name. Bump the version with any change to the payload shape. */
export const ORACLE_REALTIME_ADAPTER_IDENTITY: AdapterIdentity = Object.freeze({
  name: "aiui-oracle/realtime-session",
  version: "1",
});

/**
 * The two things the oracle puts on the wire that carry its instructions:
 *
 *  - `session.update` — the client event `{ type, event_id, session }`, the
 *    session block a `session.update` may carry (never voice or model);
 *  - `connect` — the baked config a session is minted and connected with:
 *    the same block plus `model` and the output `voice`, with no event
 *    envelope.
 *
 * Both take the same parameters: `session`, the fields OTHER than
 * instructions exactly as the session built them (the audio block, the tool
 * schemas, limits), and for the event, `eventId`, the id the session
 * stamped. The instructions arrive as the binding named `instructions`; an
 * update without one (a tools-only or audio-only patch) has no binding and
 * emits no `instructions` field.
 */
export type OracleRealtimeAction = "session.update" | "connect";

const ACTIONS: readonly OracleRealtimeAction[] = ["session.update", "connect"];

function params(input: JsonObject, action: string): { session: JsonObject; eventId?: string } {
  const session = input.session;
  if (session === null || typeof session !== "object" || Array.isArray(session)) {
    throw new PromptError("ORACLE_SESSION_PARAMS", `${action} needs a session object parameter.`);
  }
  // Narrowed above: a non-null, non-array object is a JsonObject.
  const block = session as JsonObject;
  if ("instructions" in block) {
    throw new PromptError(
      "ORACLE_SESSION_PARAMS",
      "Instructions travel as the binding, never as a session parameter.",
    );
  }
  const eventId = input.eventId;
  if (action === "session.update" && typeof eventId !== "string") {
    throw new PromptError("ORACLE_SESSION_PARAMS", "session.update needs the stamped eventId.");
  }
  return { session: block, ...(typeof eventId === "string" ? { eventId } : {}) };
}

/** Version 1: the shapes `OracleSession` sends today. */
const adapterV1: ConsumerAdapter = {
  identity: ORACLE_REALTIME_ADAPTER_IDENTITY,
  capabilities: Object.freeze({
    actions: ACTIONS,
    content: ["text"] as const,
    assets: [] as const,
  }),
  lower({ operation, bindings }) {
    if (!ACTIONS.includes(operation.action as OracleRealtimeAction)) {
      throw new PromptError(
        "ORACLE_SESSION_ACTION",
        `This version lowers ${ACTIONS.join(" and ")} only.`,
      );
    }
    const action = operation.action as OracleRealtimeAction;
    const { session, eventId } = params(operation.params, action);
    const mappings: DeliveryMap[] = [];
    // The session block's path inside the payload: under `session` for the
    // event, the payload itself for the baked config.
    const sessionPath: (string | number)[] = action === "session.update" ? ["session"] : [];
    const binding = bindings.find((candidate) => candidate.key === "instructions");
    if (bindings.length > 1 || (bindings.length === 1 && binding === undefined)) {
      throw new PromptError(
        "ORACLE_SESSION_BINDING",
        "The only binding this adapter takes is `instructions`.",
      );
    }
    let instructions: string | undefined;
    if (binding !== undefined) {
      instructions = "";
      for (const part of binding.compiled.parts) {
        if (part.type !== "text") {
          throw new PromptError("ORACLE_SESSION_CONTENT", "Instructions are text only.");
        }
        const start = instructions.length;
        instructions += part.text;
        mappings.push({
          path: [...sessionPath, "instructions"],
          binding: binding.key,
          record: binding.record,
          part: part.id,
          start,
          end: instructions.length,
          relation: "copy",
        });
      }
    }
    const block: JsonObject = {
      type: "realtime",
      ...session,
      ...(instructions !== undefined ? { instructions } : {}),
    };
    const payload: JsonValue =
      action === "session.update"
        ? { type: "session.update", event_id: eventId as string, session: block }
        : block;
    return {
      payload,
      mappings,
      decisions: [
        {
          kind: "oracle-realtime-session",
          action,
          // Which fields rode as captured parameters — so a reader knows what
          // the record reproduces from data rather than derives from content.
          parameters: Object.keys(session).sort(),
          instructions: instructions !== undefined,
        },
      ],
    };
  },
};
export const oracleRealtimeAdapter: ConsumerAdapter = Object.freeze(adapterV1);

/** Every retained implementation, for lowering and replay. Append; never replace. */
export const ORACLE_REALTIME_ADAPTERS: readonly ConsumerAdapter[] = Object.freeze([
  oracleRealtimeAdapter,
]);
