import { describe, expect, it } from "vitest";
import { type SpeechAudioElement, SpeechPlayer } from "./speech";

/** A scriptable fake audio element: records src + play/pause, and lets the test
 * fire `ended`/`error` to advance the queue (jsdom can't actually play audio). */
function fakeAudio() {
  const created: Array<{
    src: string;
    play: () => void;
    pause: () => void;
    end: () => void;
    error: () => void;
    played: boolean;
    paused: boolean;
  }> = [];
  const factory = (src: string): SpeechAudioElement => {
    const listeners: Record<string, () => void> = {};
    const rec = {
      src,
      played: false,
      paused: false,
      play: () => {},
      pause: () => {},
      end: () => listeners.ended?.(),
      error: () => listeners.error?.(),
    };
    const element: SpeechAudioElement = {
      play: () => {
        rec.played = true;
      },
      pause: () => {
        rec.paused = true;
      },
      addEventListener: (type, listener) => {
        listeners[type] = listener;
      },
    };
    rec.play = () => element.play();
    rec.pause = () => element.pause();
    created.push(rec);
    return element;
  };
  return { factory, created };
}

const clip = (id: string, label?: string) => ({
  id,
  mime: "audio/wav",
  data: btoa(id),
  ...(label !== undefined ? { label } : {}),
});

describe("SpeechPlayer", () => {
  it("plays one clip and reports its label; clears on end", () => {
    const audio = fakeAudio();
    const labels: Array<string | undefined> = [];
    let idle = 0;
    const player = new SpeechPlayer({
      createAudio: audio.factory,
      onSpeak: (l) => labels.push(l),
      onIdle: () => idle++,
    });
    player.enqueue(clip("ack_0", "sent"));
    expect(audio.created).toHaveLength(1);
    expect(audio.created[0].src).toBe(`data:audio/wav;base64,${btoa("ack_0")}`);
    expect(audio.created[0].played).toBe(true);
    expect(labels).toEqual(["sent"]);
    expect(player.active).toBe(true);

    audio.created[0].end();
    expect(idle).toBe(1);
    expect(player.active).toBe(false);
  });

  it("serializes the queue: the next clip plays only after the previous ends", () => {
    const audio = fakeAudio();
    const player = new SpeechPlayer({ createAudio: audio.factory });
    player.enqueue(clip("a"));
    player.enqueue(clip("b"));
    // Only the first has started; the second waits.
    expect(audio.created).toHaveLength(1);
    audio.created[0].end();
    expect(audio.created).toHaveLength(2);
    expect(audio.created[1].src).toContain(btoa("b"));
  });

  it("barge-in stops the current clip, drops the queue, and ignores its late end", () => {
    const audio = fakeAudio();
    const player = new SpeechPlayer({ createAudio: audio.factory });
    player.enqueue(clip("a"));
    player.enqueue(clip("b"));
    player.bargeIn();
    expect(audio.created[0].paused).toBe(true);
    expect(player.active).toBe(false);
    // A late `ended` from the stopped clip must NOT resurrect the dropped queue.
    audio.created[0].end();
    expect(audio.created).toHaveLength(1);
  });

  it("advances past a clip whose play() throws (no wedged queue)", () => {
    const throwingFactory = (): SpeechAudioElement => ({
      play: () => {
        throw new Error("autoplay blocked");
      },
      pause: () => {},
      addEventListener: () => {},
    });
    const player = new SpeechPlayer({ createAudio: throwingFactory });
    // The first clip's play throws; the player must still drain (not stay active).
    player.enqueue(clip("a"));
    expect(player.active).toBe(false);
  });
});
