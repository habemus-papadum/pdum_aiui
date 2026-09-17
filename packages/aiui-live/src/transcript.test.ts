import { describe, expect, it } from "vitest";
import { groupUtterances, interleave, joinFragments, TranscriptTrack } from "./transcript";

describe("transcript", () => {
  it("joins fragments, adding a space only between word characters", () => {
    expect(joinFragments(["Please set", " the frequency", "to five", "."])).toBe(
      "Please set the frequency to five.",
    );
  });

  it("groups fragments by silence gap", () => {
    const utterances = groupUtterances(
      [
        { text: "set the", startMs: 1000, endMs: 1400, t: 10 },
        { text: " frequency", startMs: 1450, endMs: 1900, t: 12 },
        { text: "and the", startMs: 4000, endMs: 4300, t: 30 },
        { text: " damping", startMs: 4350, endMs: 4800, t: 31 },
      ],
      800,
    );
    expect(utterances.map((u) => u.text)).toEqual(["set the frequency", "and the damping"]);
    expect(utterances[0]).toMatchObject({ startMs: 1000, endMs: 1900, t: 10, tEnd: 12 });
  });

  it("interleaves two tracks chronologically, user first on ties", () => {
    const user = [{ text: "hi", startMs: 0, endMs: 500, t: 0, tEnd: 0 }];
    const assistant = [
      { text: "hello", startMs: 0, endMs: 600, t: 1, tEnd: 1 },
      { text: "later", startMs: 900, endMs: 1200, t: 5, tEnd: 5 },
    ];
    expect(interleave(user, assistant).map((line) => `${line.role}:${line.text}`)).toEqual([
      "user:hi",
      "assistant:hello",
      "assistant:later",
    ]);
  });

  it("answers since(t) with utterances whose first fragment arrived after t", () => {
    const track = new TranscriptTrack(800);
    track.push({ text: "first", startMs: 0, endMs: 400, t: 5 });
    track.push({ text: "second", startMs: 3000, endMs: 3400, t: 40 });
    expect(track.since(10).map((u) => u.text)).toEqual(["second"]);
    expect(track.tail(1)).toBe("second");
    expect(track.text()).toBe("first second");
  });
});
