// @vitest-environment jsdom
/**
 * speech.unlock.test.ts — the autoplay-policy path: a `NotAllowedError` from
 * `play()` PARKS the clip instead of dropping it, `onBlocked` fires once, and
 * the next user gesture in the document resumes playback. jsdom on purpose
 * (the sibling speech.test.ts runs under node): the unlock listens on
 * `document`, so this is the file that has one.
 */
import { describe, expect, it } from "vitest";
import { type SpeechAudioElement, SpeechPlayer } from "./speech";

/** Audio elements whose play() rejects like Chrome's autoplay gate — until
 * `allow()` flips them to succeed (the "user gestured" world). */
function gatedAudio() {
  let allowed = false;
  const created: Array<{ src: string; listeners: Record<string, () => void> }> = [];
  const notAllowed = (): Error => {
    const error = new Error("play() failed because the user didn't interact with the document");
    error.name = "NotAllowedError";
    return error;
  };
  const factory = (src: string): SpeechAudioElement => {
    const listeners: Record<string, () => void> = {};
    created.push({ src, listeners });
    return {
      play: () => (allowed ? Promise.resolve() : Promise.reject(notAllowed())),
      pause: () => {},
      addEventListener: (type, listener) => {
        listeners[type] = listener;
      },
    };
  };
  return { factory, created, allow: () => (allowed = true) };
}

const clip = (id: string, label?: string) => ({
  id,
  mime: "audio/mpeg",
  data: btoa(id),
  ...(label !== undefined ? { label } : {}),
});

const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

const gesture = (): void => {
  document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
};

describe("SpeechPlayer under the autoplay policy", () => {
  it("parks a NotAllowedError clip, says so once, and resumes on the next gesture", async () => {
    const audio = gatedAudio();
    let blocked = 0;
    const labels: Array<string | undefined> = [];
    const player = new SpeechPlayer({
      createAudio: audio.factory,
      onBlocked: () => blocked++,
      onSpeak: (l) => labels.push(l),
    });

    player.enqueue(clip("lint_0", "prefer a stable key"));
    await settle();
    expect(blocked).toBe(1);
    expect(player.active).toBe(false); // parked, not playing

    // A second clip while blocked queues silently — no second element, no
    // second hint.
    player.enqueue(clip("lint_1", "and a unit on the axis"));
    await settle();
    expect(audio.created).toHaveLength(1);
    expect(blocked).toBe(1);

    // The user clicks (anywhere): playback resumes from the PARKED clip.
    audio.allow();
    gesture();
    await settle();
    expect(player.active).toBe(true);
    expect(audio.created).toHaveLength(2);
    expect(audio.created[1].src).toContain(btoa("lint_0")); // head of the line, not dropped
    expect(labels).toEqual(["prefer a stable key", "prefer a stable key"]); // spoke again on resume

    // …and the queue then serializes as normal.
    audio.created[1].listeners.ended?.();
    await settle();
    expect(audio.created[2]?.src).toContain(btoa("lint_1"));
  });

  it("a gesture arriving while still gated re-parks instead of wedging", async () => {
    const audio = gatedAudio();
    let blocked = 0;
    const player = new SpeechPlayer({ createAudio: audio.factory, onBlocked: () => blocked++ });
    player.enqueue(clip("lint_0"));
    await settle();
    expect(blocked).toBe(1);

    // Gesture fires but play() STILL rejects (e.g. a synthetic event that
    // granted nothing): the clip parks again and a later real gesture works.
    gesture();
    await settle();
    expect(blocked).toBe(2);
    expect(player.active).toBe(false);

    audio.allow();
    gesture();
    await settle();
    expect(player.active).toBe(true);
  });

  it("barge-in drops a parked queue — talking over blocked clips discards them", async () => {
    const audio = gatedAudio();
    const player = new SpeechPlayer({ createAudio: audio.factory });
    player.enqueue(clip("lint_0"));
    player.enqueue(clip("lint_1"));
    await settle();

    player.bargeIn();
    audio.allow();
    gesture();
    await settle();
    // Nothing resumes: the queue died with the barge-in.
    expect(audio.created).toHaveLength(1);
    expect(player.active).toBe(false);
  });

  it("a non-autoplay rejection still advances (a broken clip never waits for a gesture)", async () => {
    const decodeFail = (): SpeechAudioElement => ({
      play: () => Promise.reject(new Error("no supported source")),
      pause: () => {},
      addEventListener: () => {},
    });
    let blocked = 0;
    const player = new SpeechPlayer({ createAudio: decodeFail, onBlocked: () => blocked++ });
    player.enqueue(clip("bad"));
    await settle();
    expect(blocked).toBe(0);
    expect(player.active).toBe(false); // drained past it
  });
});
