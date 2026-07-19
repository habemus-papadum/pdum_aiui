import { describe, expect, it } from "vitest";
import { type ParsedStage, parseStageLabel, stageLabel } from "./trace-stages";

// The labels are a PERSISTED on-disk format: traces already written must render
// forever. These golden literals pin every builder output char-for-char — a
// wording change here would silently orphan history, so it must break the test.
describe("stageLabel builders (golden — the persisted strings)", () => {
  it("pins every builder output char-for-char", () => {
    expect(stageLabel.clientContext()).toBe("client context");
    expect(stageLabel.intentConfig()).toBe("intent config");
    expect(stageLabel.promptPreamble()).toBe("prompt preamble");
    expect(stageLabel.inputFrame({ n: 0 })).toBe("frame 0");
    expect(stageLabel.inputFrame({ n: 0, fin: true })).toBe("frame 0 (fin)");
    expect(stageLabel.inputFrame({ n: 0, chunk: "events" })).toBe("frame 0 events");
    expect(stageLabel.inputFrame({ n: 1, chunk: "audio" })).toBe("frame 1 audio");
    expect(stageLabel.inputFrame({ n: 2, chunk: "attachment", id: "shot_1" })).toBe(
      "frame 2 attachment shot_1",
    );
    expect(stageLabel.inputFrame({ n: 3, chunk: "attachment", id: "seg_1", fin: true })).toBe(
      "frame 3 attachment seg_1 (fin)",
    );
    expect(stageLabel.inputFrame({ n: 4, chunk: "context" })).toBe("frame 4 context");
    expect(stageLabel.inputFrame({ n: 5, chunk: "control" })).toBe("frame 5 control");
    expect(stageLabel.composedSpeculative()).toBe("composed (speculative)");
    expect(stageLabel.loweredPromptSpans()).toBe("lowered prompt spans");
    expect(stageLabel.mergedEvents()).toBe("merged events");
    expect(stageLabel.finCompose()).toBe("fin compose");
    expect(stageLabel.composedIntent()).toBe("composed intent");
    expect(stageLabel.conditioned()).toBe("conditioned");
    expect(stageLabel.loweredPrompt()).toBe("lowered prompt");
    expect(stageLabel.condition("seg_1", "silenceTrim")).toBe("condition seg_1 (silenceTrim)");
    expect(stageLabel.condition("shot_1", "imageDownscale")).toBe(
      "condition shot_1 (imageDownscale)",
    );
    expect(stageLabel.attachment("seg_1")).toBe("attachment seg_1");
    expect(stageLabel.attachment("shot_1")).toBe("attachment shot_1");
    expect(stageLabel.realtimeCommit(1)).toBe("realtime commit seg_1");
    expect(stageLabel.realtimeDiscard(2)).toBe("realtime discard seg_2");
    expect(stageLabel.audioOutOfOrder("seg_3")).toBe("audio seg_3 out-of-order");
    expect(stageLabel.sttPartial(3)).toBe("stt partial seg_3");
    expect(stageLabel.sttFinal(4)).toBe("stt final seg_4");
    expect(stageLabel.sttDiagnostic({ kind: "vendor-commit", segment: 2 })).toBe(
      "stt vendor commit seg_2",
    );
    expect(stageLabel.sttDiagnostic({ kind: "config-echo" })).toBe("stt config-echo");
    expect(stageLabel.sttDiagnostic({ kind: "config-mismatch" })).toBe("stt config-mismatch");
    expect(stageLabel.sttDiagnostic({ kind: "orphan-result" })).toBe("stt orphan-result");
    expect(stageLabel.sttDiagnostic({ kind: "unhandled" })).toBe("stt unhandled");
    expect(stageLabel.cost("tts ack")).toBe("cost: tts ack");
    expect(stageLabel.speech("ack_0")).toBe("speech ack_0");
    expect(stageLabel.appSelection()).toBe("app selection");
    expect(stageLabel.appSelectionDropped()).toBe("app selection dropped");
    expect(stageLabel.codeSelection()).toBe("code selection");
    expect(stageLabel.codeSelectionDropped()).toBe("code selection dropped");
    expect(stageLabel.linterOpen()).toBe("linter open");
    expect(stageLabel.linterDisabled()).toBe("linter disabled");
    expect(stageLabel.linterNote()).toBe("linter note");
    expect(stageLabel.linterToolCall("read_file")).toBe("linter tool call read_file");
    expect(stageLabel.linterToolResult()).toBe("linter tool result");
    expect(stageLabel.linterTranscript(2)).toBe("linter transcript seg_2");
    expect(stageLabel.linterLabel("shot_1")).toBe("linter label shot_1");
    expect(stageLabel.linterSelection()).toBe("linter selection");
    expect(stageLabel.linterSelectionRetracted()).toBe("linter selection retracted");
    expect(stageLabel.linterTurnEnd()).toBe("linter turn end");
    expect(stageLabel.linterInterrupted()).toBe("linter interrupted");
    expect(stageLabel.linterGoAway()).toBe("linter go-away");
    expect(stageLabel.linterError()).toBe("linter error");
    expect(stageLabel.linterClose()).toBe("linter close");
    expect(stageLabel.linterControl()).toBe("linter control");
    expect(stageLabel.userText()).toBe("user text");
  });
});

// Every buildable variant survives a build → parse round-trip: the parser is the
// exact inverse of the builders (they are the one channel↔trace-ui contract).
describe("parseStageLabel ∘ stageLabel round-trip", () => {
  const cases: Array<[string, ParsedStage]> = [
    [stageLabel.clientContext(), { t: "client-context" }],
    [stageLabel.intentConfig(), { t: "intent-config" }],
    [stageLabel.promptPreamble(), { t: "prompt-preamble" }],
    [stageLabel.inputFrame({ n: 0 }), { t: "input-frame", n: 0, fin: false }],
    [stageLabel.inputFrame({ n: 9, fin: true }), { t: "input-frame", n: 9, fin: true }],
    [
      stageLabel.inputFrame({ n: 0, chunk: "events" }),
      { t: "input-frame", n: 0, chunk: "events", fin: false },
    ],
    [
      stageLabel.inputFrame({ n: 1, chunk: "audio" }),
      { t: "input-frame", n: 1, chunk: "audio", fin: false },
    ],
    [
      stageLabel.inputFrame({ n: 2, chunk: "video" }),
      { t: "input-frame", n: 2, chunk: "video", fin: false },
    ],
    [
      stageLabel.inputFrame({ n: 3, chunk: "context" }),
      { t: "input-frame", n: 3, chunk: "context", fin: false },
    ],
    [
      stageLabel.inputFrame({ n: 4, chunk: "control" }),
      { t: "input-frame", n: 4, chunk: "control", fin: false },
    ],
    [
      stageLabel.inputFrame({ n: 5, chunk: "attachment", id: "shot_1" }),
      { t: "input-frame", n: 5, chunk: "attachment", media: "shot", id: "shot_1", fin: false },
    ],
    [
      stageLabel.inputFrame({ n: 6, chunk: "attachment", id: "seg_2" }),
      { t: "input-frame", n: 6, chunk: "attachment", media: "seg", id: "seg_2", fin: false },
    ],
    [stageLabel.composedSpeculative(), { t: "composed-speculative" }],
    [stageLabel.loweredPromptSpans(), { t: "lowered-prompt-spans" }],
    [stageLabel.mergedEvents(), { t: "merged-events" }],
    [stageLabel.finCompose(), { t: "fin-compose" }],
    [stageLabel.composedIntent(), { t: "composed-intent" }],
    [stageLabel.conditioned(), { t: "conditioned" }],
    [stageLabel.loweredPrompt(), { t: "lowered-prompt" }],
    [
      stageLabel.condition("seg_1", "silenceTrim"),
      { t: "condition", id: "seg_1", kind: "silenceTrim" },
    ],
    [
      stageLabel.condition("shot_1", "imageDownscale"),
      { t: "condition", id: "shot_1", kind: "imageDownscale" },
    ],
    [stageLabel.attachment("seg_1"), { t: "attachment", id: "seg_1", media: "seg" }],
    [stageLabel.attachment("shot_1"), { t: "attachment", id: "shot_1", media: "shot" }],
    [stageLabel.realtimeCommit(1), { t: "realtime-commit", segment: 1 }],
    [stageLabel.realtimeDiscard(2), { t: "realtime-discard", segment: 2 }],
    [stageLabel.audioOutOfOrder("seg_3"), { t: "audio-out-of-order", id: "seg_3" }],
    [stageLabel.sttPartial(3), { t: "stt-partial", segment: 3 }],
    [stageLabel.sttFinal(4), { t: "stt-final", segment: 4 }],
    [
      stageLabel.sttDiagnostic({ kind: "vendor-commit", segment: 2 }),
      { t: "stt-vendor-commit", segment: 2 },
    ],
    [stageLabel.sttDiagnostic({ kind: "config-echo" }), { t: "stt-config-echo" }],
    [stageLabel.sttDiagnostic({ kind: "config-mismatch" }), { t: "stt-config-mismatch" }],
    [stageLabel.sttDiagnostic({ kind: "orphan-result" }), { t: "stt-orphan-result" }],
    [stageLabel.sttDiagnostic({ kind: "unhandled" }), { t: "stt-unhandled" }],
    [stageLabel.cost("tts ack"), { t: "cost", what: "tts ack" }],
    [
      stageLabel.cost("realtime transcription seg_1"),
      { t: "cost", what: "realtime transcription seg_1" },
    ],
    [stageLabel.speech("ack_0"), { t: "speech", id: "ack_0" }],
    [stageLabel.appSelection(), { t: "app-selection" }],
    [stageLabel.appSelectionDropped(), { t: "app-selection-dropped" }],
    [stageLabel.codeSelection(), { t: "code-selection" }],
    [stageLabel.codeSelectionDropped(), { t: "code-selection-dropped" }],
    [stageLabel.linterOpen(), { t: "linter-open" }],
    [stageLabel.linterDisabled(), { t: "linter-disabled" }],
    [stageLabel.linterNote(), { t: "linter-note" }],
    [stageLabel.linterToolCall("read_file"), { t: "linter-tool-call", tool: "read_file" }],
    [stageLabel.linterToolResult(), { t: "linter-tool-result" }],
    [stageLabel.linterTranscript(2), { t: "linter-transcript", segment: 2 }],
    [stageLabel.linterLabel("shot_1"), { t: "linter-label", id: "shot_1" }],
    [stageLabel.linterSelection(), { t: "linter-selection" }],
    [stageLabel.linterSelectionRetracted(), { t: "linter-selection-retracted" }],
    [stageLabel.linterTurnEnd(), { t: "linter-turn-end" }],
    ["linter turn merged", { t: "linter-turn-merged" }], // legacy reader-only (overhear retired)
    [stageLabel.linterInterrupted(), { t: "linter-interrupted" }],
    [stageLabel.linterGoAway(), { t: "linter-go-away" }],
    ["linter transcript timeout", { t: "linter-transcript-timeout" }], // legacy reader-only
    [stageLabel.linterError(), { t: "linter-error" }],
    [stageLabel.linterClose(), { t: "linter-close" }],
    [stageLabel.linterControl(), { t: "linter-control" }],
    [stageLabel.userText(), { t: "user-text" }],
  ];

  it.each(cases)("%s round-trips", (label, expected) => {
    expect(parseStageLabel(label)).toEqual(expected);
  });
});

describe("parseStageLabel (reader-only legacy + totality)", () => {
  it("parses the reader-only legacy labels (no living writer)", () => {
    expect(parseStageLabel("correction request")).toEqual({ t: "correction-request" });
    expect(parseStageLabel("correction patch")).toEqual({ t: "correction-patch" });
    expect(parseStageLabel("correction failed")).toEqual({ t: "correction-failed" });
    expect(parseStageLabel("voice reply")).toEqual({ t: "voice-reply" });
    expect(parseStageLabel("transcription failed seg_2")).toEqual({ t: "transcription-failed" });
    expect(parseStageLabel("video vid_1 #7")).toEqual({ t: "video-legacy" });
    expect(parseStageLabel("live open")).toEqual({ t: "live-open" });
    expect(parseStageLabel("live label shot_3")).toEqual({ t: "live-label", id: "shot_3" });
    expect(parseStageLabel("live nudge")).toEqual({ t: "live-nudge" });
    expect(parseStageLabel("live tool call")).toEqual({ t: "live-tool-call" });
    expect(parseStageLabel("live resolved")).toEqual({ t: "live-resolved" });
    expect(parseStageLabel("live reply")).toEqual({ t: "live-reply" });
    expect(parseStageLabel("live fallback")).toEqual({ t: "live-fallback" });
  });

  it("keys frame precedence exactly (chunk kinds before fin, fin before bare)", () => {
    // An events chunk WITH a fin still reads as an events frame (kind wins over
    // fin) — the ladder order classifyStage relies on.
    expect(parseStageLabel("frame 0 events (fin)")).toEqual({
      t: "input-frame",
      n: 0,
      chunk: "events",
      fin: true,
    });
    // A bare frame with a fin is the commit frame.
    expect(parseStageLabel("frame 7 (fin)")).toEqual({ t: "input-frame", n: 7, fin: true });
  });

  it("is total — anything unrecognized is {t:'unknown'}", () => {
    expect(parseStageLabel("brand new stage")).toEqual({ t: "unknown" });
    expect(parseStageLabel("")).toEqual({ t: "unknown" });
    expect(parseStageLabel("condition")).toEqual({ t: "unknown" });
  });
});
