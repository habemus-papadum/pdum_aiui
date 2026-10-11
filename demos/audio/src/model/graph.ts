import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import { appScope, current } from "./store";

export const graph = hotCellGraph(
  appScope.name,
  () => {
    const transcript = cell(
      () => {
        const model = current.get();
        return model
          ? {
              text: [model.draft.get(), model.partial.get()].filter(Boolean).join(" "),
              phase: model.state.get(),
            }
          : undefined;
      },
      (value) => value,
      { scope: appScope },
    );
    /** Start a microphone dictation segment with ElevenLabs. */
    action({ scope: appScope, name: "dictate", run: () => current.get()?.dictate() });
    /** Commit and wait for the final dictated text. */
    action({ scope: appScope, name: "finish", run: () => current.get()?.finish() });
    /** Temporarily route the microphone to the Oracle text editor. */
    action({ scope: appScope, name: "edit", run: () => current.get()?.edit() });
    /** Restore dictation without clearing a user-requested audio park. */
    action({
      scope: appScope,
      name: "return-to-dictation",
      run: () => current.get()?.returnToDictation(),
    });
    /** Park input without closing either vendor session. */
    action({ scope: appScope, name: "park", run: () => current.get()?.park() });
    /** Read routing and transcript state. Contains no credentials or raw audio. */
    action({
      scope: appScope,
      name: "audio-state",
      kind: "read",
      run: () => {
        const model = current.get();
        return model
          ? {
              audio: model.hub.snapshot(),
              phase: model.state.get(),
              transcript: model.draft.get(),
              stt: model.stt.status(),
              oracle: model.oracle.state().status,
            }
          : { mounted: false };
      },
    });
    return { transcript };
  },
  import.meta.hot,
);
export type AppGraph = ReturnType<typeof graph>;
const kit = agentToolkit(appScope.name, {
  brief:
    "Shared audio routing with ElevenLabs dictation and an Oracle text editor. Dictate, finish, edit, and return-to-dictation use one microphone. Park gates input without closing sessions. Read audio-state to inspect the actual route.",
});
registerStandardTools(kit);
