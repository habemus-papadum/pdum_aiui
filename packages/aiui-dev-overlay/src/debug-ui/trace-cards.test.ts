import { describe, expect, it } from "vitest";
import type { IntentEvent } from "../intent-pipeline";
import type { TraceStageLike } from "./sources";
import {
  buildCards,
  cardVisible,
  classifyStage,
  clip,
  correctionLines,
  costLine,
  defaultEnabledCategories,
  eventTypesSummary,
  formatDuration,
  formatUsd,
  isImageFile,
  isPartialLabel,
  isPlayableAudioFile,
  liveOpenLine,
  liveResolvedSummary,
  liveToolSegments,
  loweredPromptText,
  noPromptMessage,
  parsePatchLines,
  parseShotBlocks,
  previousPartialText,
  savedFrameFiles,
  shotBlobName,
  speculativePromptText,
  splitLoweredPrompt,
  traceDurationMs,
  traceOutcome,
} from "./trace-cards";

const stage = (over: Partial<TraceStageLike>): TraceStageLike => ({
  label: "",
  kind: "info",
  ...over,
});

describe("classifyStage", () => {
  it("routes the story frame (context/config/preamble)", () => {
    expect(classifyStage(stage({ label: "client context", kind: "info" }))).toMatchObject({
      direction: "in",
      category: "context",
    });
    expect(classifyStage(stage({ label: "intent config" }))).toMatchObject({ category: "config" });
    expect(classifyStage(stage({ label: "prompt preamble" }))).toMatchObject({
      category: "context",
    });
  });

  it("routes input frames to the in lane by kind of chunk", () => {
    // Raw event-frame receipts are wire-bucket (blob pointers; the decoded
    // story is the merged-events card) and coalesce like audio.
    expect(classifyStage(stage({ label: "frame 0 events", kind: "input" }))).toMatchObject({
      direction: "in",
      category: "wire",
      coalesceKey: "wire-events",
    });
    const audio = classifyStage(stage({ label: "frame 7 audio", kind: "input" }));
    expect(audio).toMatchObject({ direction: "in", category: "audio", coalesceKey: "audio-in" });
    expect(
      classifyStage(stage({ label: "frame 4 attachment shot_1", kind: "input" })),
    ).toMatchObject({ direction: "in", category: "media", title: "shot_1 uploaded" });
    expect(classifyStage(stage({ label: "frame 9 (fin)", kind: "input" }))).toMatchObject({
      category: "events",
      title: "fin — commit",
    });
  });

  it("routes IR stages to internal, coalescing only speculative composes", () => {
    expect(classifyStage(stage({ label: "composed (speculative)", kind: "ir" }))).toMatchObject({
      direction: "internal",
      category: "compose",
      coalesceKey: "spec",
    });
    expect(classifyStage(stage({ label: "attachment shot_1", kind: "ir" }))).toMatchObject({
      category: "media",
      title: "shot_1 · screenshot",
    });
    expect(classifyStage(stage({ label: "attachment seg_3", kind: "ir" }))).toMatchObject({
      category: "audio",
    });
    expect(classifyStage(stage({ label: "merged events", kind: "ir" }))).toMatchObject({
      category: "events",
      title: "merged events",
    });
  });

  it("routes pushes to the out lane", () => {
    // The lowered prompt leaves the pipeline entirely — its own agent lane.
    expect(classifyStage(stage({ label: "lowered prompt", kind: "output" }))).toMatchObject({
      direction: "agent",
      category: "lowered",
    });
    expect(classifyStage(stage({ label: "speech ack_0", kind: "info" }))).toMatchObject({
      direction: "out",
      category: "speech",
    });
    expect(classifyStage(stage({ label: "voice reply", kind: "info" }))).toMatchObject({
      category: "speech",
    });
  });

  it("flags failures as errors (red) regardless of nominal lane", () => {
    expect(classifyStage(stage({ label: "correction failed" }))).toMatchObject({
      category: "errors",
      error: true,
    });
    expect(classifyStage(stage({ label: "transcription failed seg_2" }))).toMatchObject({
      category: "errors",
      error: true,
    });
    expect(classifyStage(stage({ label: "audio seg_2 out-of-order" }))).toMatchObject({
      error: true,
    });
  });

  it("classifies both selection kinds and their drops onto the in lane, always shown", () => {
    // Selections are context riding the turn ("did my selection make it in?")
    // — the always-shown context bucket, arriving from the browser.
    expect(classifyStage(stage({ label: "app selection", kind: "ir" }))).toMatchObject({
      direction: "in",
      category: "context",
      icon: "⌖",
      title: "app selection",
      error: false,
    });
    expect(classifyStage(stage({ label: "app selection dropped", kind: "ir" }))).toMatchObject({
      direction: "in",
      category: "context",
      title: "app selection dropped",
    });
    expect(classifyStage(stage({ label: "code selection", kind: "ir" }))).toMatchObject({
      direction: "in",
      category: "context",
      icon: "⧉",
      title: "code selection",
    });
    expect(classifyStage(stage({ label: "code selection dropped", kind: "ir" }))).toMatchObject({
      direction: "in",
      category: "context",
      title: "code selection dropped",
    });
  });

  it("falls through unknown labels to a generic card by kind (never drops)", () => {
    expect(classifyStage(stage({ label: "brand new stage", kind: "ir" }))).toMatchObject({
      direction: "internal",
      title: "brand new stage",
      error: false,
    });
  });

  it("routes realtime video frames to their own coalescing bucket", () => {
    expect(classifyStage(stage({ label: "frame 12 video", kind: "input" }))).toMatchObject({
      direction: "in",
      category: "video",
      title: "video stream",
      coalesceKey: "video-in",
    });
  });

  it("classifies the realtime live-session labels onto the model↔us lanes", () => {
    // Session config, always-shown like intent config, but the live 🛰 glyph.
    expect(classifyStage(stage({ label: "live open", kind: "info" }))).toMatchObject({
      direction: "internal",
      category: "config",
      icon: "🛰",
    });
    // A shot shown to the model flows TO it → in lane, media bucket, id kept.
    expect(classifyStage(stage({ label: "live label shot_3", kind: "info" }))).toMatchObject({
      direction: "in",
      category: "media",
      icon: "🏷",
      title: "shot_3 shown to model",
    });
    // Our nudge (in/blue ←) vs. the model's tool call (out/green →).
    expect(classifyStage(stage({ label: "live nudge", kind: "info" }))).toMatchObject({
      direction: "in",
      icon: "🔔",
    });
    expect(classifyStage(stage({ label: "live tool call", kind: "ir" }))).toMatchObject({
      direction: "out",
      icon: "🧩",
    });
    // The resolved prompt leaves for Claude → agent lane, beside the hero.
    expect(classifyStage(stage({ label: "live resolved", kind: "ir" }))).toMatchObject({
      direction: "agent",
      category: "lowered",
      icon: "🚀",
    });
    expect(classifyStage(stage({ label: "live reply", kind: "info" }))).toMatchObject({
      direction: "out",
      category: "speech",
      icon: "🗣",
    });
    // The ladder fallback is a degradation → errors bucket, warning (not ❌).
    expect(classifyStage(stage({ label: "live fallback", kind: "info" }))).toMatchObject({
      category: "errors",
      error: true,
      icon: "⚠",
    });
  });
});

describe("buildCards", () => {
  it("coalesces consecutive audio frames and speculative composes into one card each", () => {
    const stages: TraceStageLike[] = [
      { label: "frame 0 events", kind: "input" },
      { label: "frame 1 audio", kind: "input" },
      { label: "frame 2 audio", kind: "input" },
      { label: "frame 3 audio", kind: "input" },
      { label: "composed (speculative)", kind: "ir", data: { transcript: "a", prompt: "a" } },
      { label: "composed (speculative)", kind: "ir", data: { transcript: "ab", prompt: "ab" } },
      { label: "merged events", kind: "ir", data: [] },
    ];
    const cards = buildCards(stages);
    // event frames / audio×3 / spec×2 / merged = 4 cards.
    expect(cards.map((c) => c.title)).toEqual([
      "event frames",
      "audio stream",
      "speculative compose",
      "merged events",
    ]);
    const audio = cards[1];
    expect(audio.count).toBe(3);
    expect(audio.indices).toEqual([1, 2, 3]);
    // The representative is the run's *last* stage (freshest snapshot).
    expect(cards[2].count).toBe(2);
    expect((cards[2].stage.data as { transcript: string }).transcript).toBe("ab");
  });

  it("does not coalesce across a break in the run", () => {
    const cards = buildCards([
      { label: "frame 1 audio", kind: "input" },
      { label: "frame 2 events", kind: "input" },
      { label: "frame 3 audio", kind: "input" },
    ]);
    expect(cards).toHaveLength(3);
    expect(cards.every((c) => c.count === 1)).toBe(true);
  });

  it("coalesces a video-frame run into one card", () => {
    const cards = buildCards([
      { label: "frame 0 video", kind: "input" },
      { label: "frame 1 video", kind: "input", file: "vid_1_0.jpg" },
      { label: "frame 2 video", kind: "input" },
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "video stream", category: "video", count: 3 });
    expect(cards[0].indices).toEqual([0, 1, 2]);
  });

  it("keeps audio and video runs distinct when they interleave (audio/video/audio)", () => {
    // Separate coalesce keys (audio-in vs video-in) mean an interleave splits
    // into distinct cards rather than merging — the ordering stays legible.
    const cards = buildCards([
      { label: "frame 0 audio", kind: "input" },
      { label: "frame 1 audio", kind: "input" },
      { label: "frame 2 video", kind: "input" },
      { label: "frame 3 video", kind: "input" },
      { label: "frame 4 video", kind: "input" },
      { label: "frame 5 audio", kind: "input" },
    ]);
    expect(cards.map((c) => [c.category, c.count])).toEqual([
      ["audio", 2],
      ["video", 3],
      ["audio", 1],
    ]);
  });

  it("returns [] for a missing stage array", () => {
    expect(buildCards(undefined)).toEqual([]);
  });
});

describe("cardVisible", () => {
  const card = (over: Partial<ReturnType<typeof classifyStage>>) => ({
    ...classifyStage(stage({ label: "merged events", kind: "ir" })),
    indices: [0],
    stage: stage({}),
    count: 1,
    ...over,
  });

  it("always shows frame categories (context/config/lowered), gated only by direction", () => {
    const enabled = new Set<never>() as Set<import("./trace-cards").CardCategory>;
    const ctx = card({ category: "context", direction: "in" });
    expect(cardVisible(ctx, "all", enabled)).toBe(true);
    expect(cardVisible(ctx, "in", enabled)).toBe(true);
    expect(cardVisible(ctx, "out", enabled)).toBe(false);
  });

  it("gates togglable categories on the enabled set", () => {
    const enabled = defaultEnabledCategories();
    expect(cardVisible(card({ category: "events" }), "all", enabled)).toBe(true);
    // audio + video + compose are hidden by default.
    expect(cardVisible(card({ category: "audio" }), "all", enabled)).toBe(false);
    expect(cardVisible(card({ category: "video" }), "all", enabled)).toBe(false);
    expect(cardVisible(card({ category: "compose" }), "all", enabled)).toBe(false);
  });
});

describe("realtime submode helpers", () => {
  it("liveOpenLine: vendor · model · video capability, defensive on partials", () => {
    expect(
      liveOpenLine({
        vendor: "gemini",
        model: "gemini-3.1-flash-live-preview",
        capabilities: { video: true },
      }),
    ).toBe("gemini · gemini-3.1-flash-live-preview · video ✓");
    expect(liveOpenLine({ vendor: "openai", capabilities: { video: false } })).toBe(
      "openai · video ✗",
    );
    expect(liveOpenLine(undefined)).toBe("video ✗");
  });

  it("liveToolSegments: parses submit_intent {segments} into ordered prose + image refs", () => {
    expect(
      liveToolSegments({
        segments: [
          { text: "make " },
          { image: "shot_2" },
          { text: " the legend bigger" },
          { image: "shot_3" },
        ],
      }),
    ).toEqual([
      { kind: "text", text: "make " },
      { kind: "image", marker: "shot_2" },
      { kind: "text", text: " the legend bigger" },
      { kind: "image", marker: "shot_3" },
    ]);
    // Non-array / empty payloads yield nothing (drops empty strings too).
    expect(liveToolSegments({ segments: [{ text: "" }, {}, 3] })).toEqual([]);
    expect(liveToolSegments(undefined)).toEqual([]);
  });

  it("liveResolvedSummary: body snippet + resolved/unresolved ref counts", () => {
    expect(
      liveResolvedSummary({
        body: "the opacity slider",
        refs: [
          { marker: "shot_2", path: "/a/shot_2.png" },
          { marker: "shot_9", resolved: false },
        ],
      }),
    ).toEqual({ body: "the opacity slider", resolved: 1, unresolved: 1 });
    // The plain-list shape is also accepted.
    expect(liveResolvedSummary({ body: "x", resolved: ["shot_1"], unresolved: [] })).toMatchObject({
      resolved: 1,
      unresolved: 0,
    });
    expect(liveResolvedSummary(undefined)).toEqual({ body: "", resolved: 0, unresolved: 0 });
  });

  it("savedFrameFiles: keeps only the persisted image keyframes, in order", () => {
    expect(
      savedFrameFiles([
        { label: "frame 0 video", kind: "input" },
        { label: "frame 10 video", kind: "input", file: "vid_1_10.jpg" },
        { label: "frame 11 video", kind: "input" },
        { label: "frame 20 video", kind: "input", file: "vid_1_20.jpg" },
        { label: "frame 21 video", kind: "input", file: "notes.pcm" },
      ]),
    ).toEqual(["vid_1_10.jpg", "vid_1_20.jpg"]);
  });
});

describe("traceOutcome", () => {
  it("sent wins even when the socket later dropped", () => {
    expect(
      traceOutcome({ status: "abandoned", stages: [{ label: "lowered prompt", kind: "output" }] }),
    ).toMatchObject({ state: "sent", glyph: "✓" });
  });
  it("reads cancelled off the conditioned stage", () => {
    expect(
      traceOutcome({
        status: "completed",
        stages: [{ label: "conditioned", data: { cancelled: true } }],
      }),
    ).toMatchObject({ state: "cancelled" });
  });
  it("abandoned with no prompt", () => {
    expect(traceOutcome({ status: "abandoned", stages: [] })).toMatchObject({ state: "abandoned" });
  });
  it("completed but empty", () => {
    expect(traceOutcome({ status: "completed", stages: [] })).toMatchObject({ state: "empty" });
  });
  it("live when unfinished", () => {
    expect(traceOutcome({ stages: [] })).toMatchObject({ state: "live", glyph: "●" });
  });
  it("has a placeholder line for each non-sent state", () => {
    expect(noPromptMessage("cancelled")).toContain("cancelled");
    expect(noPromptMessage("live")).toBe("composing…");
  });
});

describe("loweredPromptText + splitLoweredPrompt", () => {
  it("reads a plain-string or { text } output stage", () => {
    expect(loweredPromptText({ data: "hi" })).toBe("hi");
    expect(loweredPromptText({ data: { text: "hi", meta: {} } })).toBe("hi");
    expect(loweredPromptText(undefined)).toBe("");
  });

  it("splits the preamble from the body at the --- rule", () => {
    const text = "intro\n\nsource line\n\nThe user's prompt follows.\n\n---\n\nmake it wider";
    const { preamble, body } = splitLoweredPrompt(text);
    expect(preamble).toContain("The user's prompt follows.");
    expect(body).toBe("make it wider");
  });

  it("treats a bare-client prompt (no wrapping) as all body", () => {
    expect(splitLoweredPrompt("just the body")).toEqual({ preamble: "", body: "just the body" });
  });
});

describe("parseShotBlocks + shotBlobName", () => {
  it("splits prose from self-closing and paired screenshot blocks", () => {
    const body = [
      "before ",
      '<screenshot path="a/shot_1.png" view="full-viewport"/>',
      " middle ",
      '<screenshot path=".aiui-cache/x/shot_2.png">',
      '  <element name="Legend"/>',
      "</screenshot>",
      " after",
    ].join("");
    const segments = parseShotBlocks(body);
    const shots = segments.filter((s) => s.kind === "shot");
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({ path: "a/shot_1.png" });
    expect(shots[1]).toMatchObject({ path: ".aiui-cache/x/shot_2.png" });
    expect(segments[0]).toEqual({ kind: "text", text: "before " });
  });

  it("resolves a shot path to its stable blob basename", () => {
    expect(shotBlobName(".aiui-cache/traces/t/shot_1.png")).toBe("shot_1.png");
    expect(shotBlobName("/abs/shot_12.PNG")).toBe("shot_12.PNG");
    expect(shotBlobName("not-a-shot.txt")).toBeUndefined();
  });
});

describe("parsePatchLines", () => {
  it("classifies a real V4A correction patch into diff lines", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: transcript",
      "@@",
      "-Here's another chunk of text.",
      "+Here's another piece of text.",
      "*** End Patch",
    ].join("\n");
    const lines = parsePatchLines(patch);
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "meta"]);
    expect(lines[3]).toEqual({ kind: "del", text: "Here's another chunk of text." });
    expect(lines[4]).toEqual({ kind: "add", text: "Here's another piece of text." });
  });

  it("strips the leading space from context lines", () => {
    expect(parsePatchLines(" kept line")).toEqual([{ kind: "context", text: "kept line" }]);
  });
});

describe("eventTypesSummary + correctionLines", () => {
  const events: IntentEvent[] = [
    { at: 1, type: "thread-open", trigger: "talk" },
    { at: 2, type: "talk-start", segment: 1 },
    { at: 3, type: "transcript-final", segment: 1, text: "a", latencyMs: 1, model: "m" },
    { at: 4, type: "transcript-final", segment: 2, text: "b", latencyMs: 1, model: "m" },
    { at: 5, type: "correction", via: "typed", original: "beat", instruction: "vite" },
  ];
  it("summarizes types in first-seen order with ×N repeats", () => {
    expect(eventTypesSummary(events)).toBe(
      "thread-open · talk-start · transcript-final ×2 · correction",
    );
  });
  it("shows correction instructions, flagging whole-transcript ones", () => {
    expect(correctionLines(events)).toEqual(["“beat” → “vite”"]);
    expect(
      correctionLines([
        { at: 1, type: "correction", via: "typed", original: "", instruction: "x" },
      ]),
    ).toEqual(["whole transcript → “x”"]);
  });
});

describe("formatting helpers", () => {
  it("formats durations across scales", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(6932)).toBe("6.9s");
    expect(formatDuration(72000)).toBe("1m 12s");
    expect(formatDuration(-1)).toBe("");
  });
  it("computes trace duration to endedAt or now", () => {
    expect(
      traceDurationMs({
        startedAt: "2026-07-06T18:00:00.000Z",
        endedAt: "2026-07-06T18:00:06.900Z",
      }),
    ).toBe(6900);
    expect(traceDurationMs({}, 0)).toBeUndefined();
  });
  it("clips and flattens whitespace", () => {
    expect(clip("a  b\nc", 80)).toBe("a b c");
    expect(clip("abcdef", 4)).toBe("abc…");
  });
  it("recognizes image and playable-audio blobs", () => {
    expect(isImageFile("shot_1.png")).toBe(true);
    expect(isPlayableAudioFile("seg_1.webm")).toBe(true);
    expect(isPlayableAudioFile("seg_1.pcm")).toBe(false);
  });
});

describe("cost accounting in the view", () => {
  it("classifies cost stages into their own 💰 bucket on the internal lane", () => {
    const c = classifyStage({ kind: "info", label: "cost: transcription seg_1", data: {} });
    expect(c.category).toBe("cost");
    expect(c.direction).toBe("internal");
    expect(c.icon).toBe("💰");
    expect(c.title).toBe("transcription seg_1");
  });

  it("formatUsd keeps sub-cent spends legible and cents money-like", () => {
    expect(formatUsd(0.000455)).toBe("$0.0005");
    expect(formatUsd(0.02724)).toBe("$0.03");
    expect(formatUsd(0)).toBe("$0");
  });

  it("costLine: price + model + token shape; honest when unpriced; ~ for estimates", () => {
    expect(
      costLine({
        usd: 0.000455,
        model: "gpt-4o-mini-transcribe",
        usage: { input_tokens: 120, output_tokens: 19, input_audio_tokens: 120 },
      }),
    ).toBe("$0.0005 · gpt-4o-mini-transcribe · 120→19 tok (120 audio)");
    expect(costLine({ model: "gpt-realtime-whisper", usage: { input_tokens: 300 } })).toBe(
      "usage recorded · no price data · gpt-realtime-whisper · 300→0 tok",
    );
    expect(costLine({ usd: 0.001, estimated: true, model: "gpt-4o-mini-tts" })).toBe(
      "~$0.0010 · gpt-4o-mini-tts",
    );
  });
});

describe("linter cards (the 💡 lane)", () => {
  it("classifies the linter's trace labels onto the linter bucket with honest lanes", () => {
    expect(classifyStage({ kind: "info", label: "linter open" })).toMatchObject({
      category: "config",
      icon: "💡",
    });
    expect(classifyStage({ kind: "info", label: "linter note" })).toMatchObject({
      direction: "out",
      category: "linter",
    });
    expect(classifyStage({ kind: "ir", label: "linter tool call read_file" })).toMatchObject({
      direction: "out",
      category: "linter",
      title: "linter → read_file",
    });
    expect(classifyStage({ kind: "ir", label: "linter tool result" })).toMatchObject({
      direction: "in",
      category: "linter",
    });
    expect(classifyStage({ kind: "ir", label: "linter transcript seg_2" })).toMatchObject({
      direction: "in",
      category: "linter",
      title: "transcript seg_2",
    });
    expect(classifyStage({ kind: "info", label: "linter transcript timeout" })).toMatchObject({
      error: true,
    });
    expect(classifyStage({ kind: "info", label: "linter error" })).toMatchObject({
      error: true,
      direction: "out",
    });
  });

  it("keeps the flow chatter coalesced and the persisted share frames on the video bucket", () => {
    expect(classifyStage({ kind: "info", label: "linter turn end" })).toMatchObject({
      coalesceKey: "linter-flow",
    });
    expect(classifyStage({ kind: "info", label: "linter turn merged" })).toMatchObject({
      coalesceKey: "linter-flow",
    });
    expect(classifyStage({ kind: "ir", label: "video vid_1 #7" })).toMatchObject({
      category: "video",
      coalesceKey: "video-in",
    });
  });
});

describe("stt final receipts (the words/logprobs glance)", () => {
  it("classifies per-final stt stages onto the events lane", () => {
    expect(classifyStage({ kind: "info", label: "stt final seg_2" })).toMatchObject({
      category: "events",
      icon: "📝",
      title: "stt final seg_2",
    });
  });
});

describe("streaming transcript partials", () => {
  const partial = (segment: number, text: string): TraceStageLike => ({
    kind: "ir",
    label: `stt partial seg_${segment}`,
    data: { chars: text.length, text },
  });

  it("classifies partials onto the events lane, uncoalesced", () => {
    expect(classifyStage(partial(2, "hello"))).toMatchObject({
      category: "events",
      icon: "✍",
      title: "stt partial seg_2",
      coalesceKey: null,
    });
  });

  it("recognizes partial labels, and not the finals they sit beside", () => {
    expect(isPartialLabel("stt partial seg_10")).toBe(true);
    expect(isPartialLabel("stt final seg_1")).toBe(false);
    expect(isPartialLabel("composed (speculative)")).toBe(false);
  });

  it("finds the previous partial for the same segment, ignoring other segments", () => {
    const stages = [
      partial(1, "one alpha"),
      partial(2, "two alpha"),
      { kind: "input", label: "frame 7 audio" } as TraceStageLike,
      partial(2, "two beta"),
    ];
    expect(previousPartialText(stages, 3)).toBe("two alpha");
    // The segment's first partial has no predecessor — everything reads as added.
    expect(previousPartialText(stages, 1)).toBe("");
    expect(previousPartialText(stages, 0)).toBe("");
  });

  it("is tolerant of missing stages and malformed data", () => {
    expect(previousPartialText(undefined, 0)).toBe("");
    const stages = [
      { kind: "ir", label: "stt partial seg_1", data: { text: 42 } } as TraceStageLike,
      partial(1, "real"),
    ];
    expect(previousPartialText(stages, 1)).toBe("");
  });
});

describe("speculativePromptText (the hero's in-flight fallback)", () => {
  const spec = (transcript: string, prompt: string): TraceStageLike => ({
    kind: "ir",
    label: "composed (speculative)",
    data: { transcript, prompt },
  });

  it("returns the freshest non-empty speculative prompt", () => {
    expect(speculativePromptText([spec("a", "prompt one"), spec("ab", "prompt two")])).toBe(
      "prompt two",
    );
  });

  it("skips the empty prompts a turn opens with", () => {
    expect(speculativePromptText([spec("", ""), spec("a", "real"), spec("a", "")])).toBe("real");
  });

  it("is empty when nothing composed yet", () => {
    expect(speculativePromptText(undefined)).toBe("");
    expect(speculativePromptText([{ kind: "info", label: "intent config" }])).toBe("");
  });
});
