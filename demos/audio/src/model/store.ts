import { type AudioHub, createAudioHub } from "@habemus-papadum/aiui-audio";
import { standardScribeConnectUrl } from "@habemus-papadum/aiui-cf-creds/stt";
import { OracleSession, standardKeySources, webRtcTransport } from "@habemus-papadum/aiui-oracle";
import { createStt, scribeTransport } from "@habemus-papadum/aiui-stt";
import { scope } from "@habemus-papadum/aiui-viz";
import { choice, createModeEngine } from "@habemus-papadum/aiui-viz/modal";

export const appScope = scope("audio-demo");
export const fallbackAudio = () => appScope.durable("standalone-audio", () => createAudioHub());
export const current = appScope.durableSignal<ReturnType<typeof createDemo> | undefined>(
  "current",
  undefined,
);
const instances = appScope.durable(
  "instances",
  () => new WeakMap<AudioHub, ReturnType<typeof createDemo>>(),
);

function createDemo(hub: AudioHub) {
  const draft = appScope.durableSignal("draft", "");
  const partial = appScope.durableSignal("partial", "");
  const state = appScope.durableSignal("state", "idle");
  const error = appScope.durableSignal("error", "");
  const transcript = hub.pcmInput({ id: "dictation", label: "Dictation", icon: "✍" });
  const editor = hub.streamInput({ id: "editor", label: "Text editor", icon: "🔮" });
  const playback = hub.output({ id: "editor", label: "Text editor", icon: "🔮" });
  const mode = createModeEngine(
    {
      regions: { phase: choice(["idle", "dictating", "editing"]) },
      commands: {
        idle: () => ({ phase: "idle" }),
        dictate: () => ({ phase: "dictating" }),
        edit: () => ({ phase: "editing" }),
      },
    },
    { context: {} },
  );
  mode.subscribe((next) => state.set(next.phase as string));
  let finalText = draft.get();
  let restore: ReturnType<AudioHub["temporarilyRouteInput"]> | undefined;
  const stt = createStt({
    transport: scribeTransport({ connectUrl: () => standardScribeConnectUrl() }),
    audio: transcript,
    callbacks: {
      onDelta: (_id, text) => partial.set(text),
      onFinal: (_id, result) => {
        finalText = [finalText, result.text].filter(Boolean).join(" ");
        draft.set(finalText);
        partial.set("");
      },
      onError: (message) => {
        error.set(message);
        partial.set("");
      },
    },
  });
  const oracle = new OracleSession({
    keySource: standardKeySources(),
    transport: webRtcTransport({ input: editor, output: playback }),
    config: {
      instructions:
        "You edit dictated text. The user supplies a draft, then speaks changes. Apply edits with replace_text, preserving unmentioned content. Reply briefly after applying an edit.",
      tools: [
        {
          name: "replace_text",
          description: "Replace the entire draft with the edited text.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          execute(args: Record<string, unknown>) {
            if (typeof args.text !== "string") throw new Error("text must be a string");
            finalText = args.text;
            draft.set(finalText);
            return { text: finalText };
          },
        },
      ],
    },
  });
  const model = {
    hub,
    draft,
    partial,
    state,
    error,
    stt,
    oracle,
    async dictate() {
      error.set("");
      if (mode.state().phase === "dictating") return;
      if (restore) {
        oracle.park();
        await restore.release();
        restore = undefined;
      }
      if (hub.snapshot().capture !== "active") await hub.startMicrophone();
      await stt.connect();
      await hub.selectInput(transcript.id);
      await hub.resumeInput();
      stt.beginSegment();
      mode.dispatch("dictate");
    },
    async finish() {
      if (mode.state().phase === "dictating") {
        await stt.endSegment();
        const pending = await stt.drain();
        if (pending.length)
          throw new Error("Still waiting for the final transcript. Try finishing again.");
      }
      mode.dispatch("idle");
    },
    async edit() {
      error.set("");
      await model.finish();
      if (hub.snapshot().capture !== "active") await hub.startMicrophone();
      restore = hub.temporarilyRouteInput(editor.id);
      hub.selectOutput(playback.id);
      if (oracle.state().status === "parked") oracle.resume();
      else if (oracle.state().status !== "live") await oracle.start();
      if (oracle.state().status !== "live") {
        await restore.release();
        restore = undefined;
        throw new Error("Could not connect the text editor. Check the OpenAI key.");
      }
      oracle.sendText(`Current draft:\n${finalText}\nWait for my spoken edits.`);
      mode.dispatch("edit");
    },
    async returnToDictation() {
      oracle.park();
      await restore?.release();
      restore = undefined;
      await stt.connect();
      stt.beginSegment();
      mode.dispatch("dictate");
      // Deliberately preserve a park requested while the editor was active.
    },
    async park() {
      await hub.parkInput();
    },
    async close() {
      stt.close();
      oracle.close();
      await restore?.release();
      restore = undefined;
      mode.dispatch("idle");
    },
    setDraft(text: string) {
      finalText = text;
      draft.set(text);
    },
  };
  return model;
}
export function demoFor(hub: AudioHub) {
  let model = instances.get(hub);
  if (!model) {
    model = createDemo(hub);
    instances.set(hub, model);
  }
  const selected = model;
  queueMicrotask(() => current.set(selected));
  return model;
}
