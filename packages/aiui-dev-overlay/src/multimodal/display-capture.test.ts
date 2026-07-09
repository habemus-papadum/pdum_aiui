// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDisplayCapture, type DisplayCaptureDeps, paintFrameSource } from "./display-capture";

/** A MediaStream stub good enough for the broker (one video track, endable). */
function fakeStream(): MediaStream & { end(): void } {
  const listeners: Array<() => void> = [];
  const track = {
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    stop: vi.fn(),
  };
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    end: () => {
      for (const fn of listeners) {
        fn();
      }
    },
  } as unknown as MediaStream & { end(): void };
}

/** jsdom's <video> can't play; the broker awaits play() before publishing. */
beforeEach(() => {
  HTMLMediaElement.prototype.play = async () => {};
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

function broker(overrides: DisplayCaptureDeps = {}) {
  return createDisplayCapture({
    policy: () => "auto",
    userActivation: () => true,
    getDisplayMedia: async () => fakeStream(),
    ...overrides,
  });
}

describe("createDisplayCapture: one grant per document", () => {
  it("asks the browser exactly once, however many consumers acquire", async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream());
    const capture = broker({ getDisplayMedia });

    // The shot tool, the video sampler and the paint host, all at once.
    const outcomes = await Promise.all([capture.acquire(), capture.acquire(), capture.acquire()]);
    // And one more after the grant is live.
    outcomes.push(await capture.acquire());

    expect(outcomes).toEqual(["active", "active", "active", "active"]);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(capture.active()).toBe(true);
  });

  it("re-asks after the user hits Chrome's 'Stop sharing'", async () => {
    const stream = fakeStream();
    const getDisplayMedia = vi.fn(async () => stream);
    const capture = broker({ getDisplayMedia });

    await capture.acquire();
    stream.end(); // the track's "ended" event
    expect(capture.active()).toBe(false);

    await capture.acquire();
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it("keeps the failure verbatim — a picker dismissal reads differently from a broken environment", async () => {
    const capture = broker({
      getDisplayMedia: async () => {
        throw new DOMException("Could not start video source", "NotReadableError");
      },
    });
    expect(await capture.acquire()).toBe("denied");
    expect(capture.lastError()).toBe("NotReadableError: Could not start video source");
  });

  it("reports denied, not a crash, where getDisplayMedia does not exist", async () => {
    const capture = createDisplayCapture({
      policy: () => "auto",
      userActivation: () => true,
      getDisplayMedia: undefined,
    });
    // jsdom really has no navigator.mediaDevices, so the default lookup applies.
    expect(await capture.acquire()).toBe("denied");
    expect(capture.active()).toBe(false);
  });
});

describe("createDisplayCapture: the gesture policy", () => {
  it("does not open a picker nobody asked for — no activation, no call", async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream());
    const capture = broker({
      policy: () => "gesture",
      userActivation: () => false,
      getDisplayMedia,
    });

    expect(await capture.acquire()).toBe("needsGesture");
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("acquires behind a real click", async () => {
    const capture = broker({ policy: () => "gesture", userActivation: () => true });
    expect(await capture.acquire()).toBe("active");
  });

  it("prewarm is inert under gesture — the whole point of the launch marker", async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream());
    const capture = broker({
      policy: () => "gesture",
      userActivation: () => true,
      getDisplayMedia,
    });

    capture.prewarm();
    await Promise.resolve();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("prewarm takes the grant under auto, and only once", async () => {
    const getDisplayMedia = vi.fn(async () => fakeStream());
    const capture = broker({ getDisplayMedia });

    capture.prewarm();
    capture.prewarm(); // the reconciler asserts this after every dispatch
    await vi.waitFor(() => expect(capture.active()).toBe(true));
    capture.prewarm();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the browser has no userActivation API to judge by", async () => {
    const capture = broker({
      userActivation: () => undefined,
      getDisplayMedia: async () => {
        throw new Error("nope");
      },
    });
    expect(await capture.acquire()).toBe("needsGesture");
  });
});

describe("createDisplayCapture: self-inflicted blur", () => {
  it("claims the blur for the whole call and a grace period after it", async () => {
    let now = 1000;
    let release: (s: MediaStream) => void = () => {};
    const capture = broker({
      now: () => now,
      getDisplayMedia: () => new Promise<MediaStream>((resolve) => (release = resolve)),
    });

    expect(capture.blurIsSelfInflicted()).toBe(false); // nothing in flight

    const acquiring = capture.acquire();
    expect(capture.blurIsSelfInflicted()).toBe(true); // the call's own blur

    now = 60_000; // a slow picker doesn't expire the claim
    expect(capture.blurIsSelfInflicted()).toBe(true);

    release(fakeStream());
    await acquiring;

    expect(capture.blurIsSelfInflicted()).toBe(true); // the trailing focus/blur pair
    now += 751;
    expect(capture.blurIsSelfInflicted()).toBe(false); // now it's the user leaving
  });

  it("does not claim a blur when the grant is already held (no call, no blur)", async () => {
    let now = 1000;
    const capture = broker({ now: () => now });
    await capture.acquire();
    now += 5000;

    await capture.acquire(); // instant — hands back the held grant
    expect(capture.blurIsSelfInflicted()).toBe(false);
  });
});

describe("paintFrameSource", () => {
  it("streams from the grant the shots hold, and never ends it", async () => {
    const capture = broker();
    const toJpeg = vi.fn(async () => new Uint8Array([0xff, 0xd8]));
    const frames = paintFrameSource(capture, toJpeg);

    // A viewer joins: a network event, no gesture. Under the launch marker this
    // is where the "Share screen with iPad" button used to have to appear.
    expect(await frames.start()).toBe("active");
    expect(frames.stream()).toBeDefined();

    const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const saved = canvas.getContext;
    canvas.getContext = () => new Proxy({}, { get: () => () => {} });
    try {
      expect(await frames.capture()).toEqual(new Uint8Array([0xff, 0xd8]));
    } finally {
      canvas.getContext = saved;
    }

    // The paint host stops its frame source when it closes. The document's
    // grant must survive — the shot tool is still holding it.
    frames.stop();
    expect(capture.active()).toBe(true);

    capture.dispose();
    expect(capture.active()).toBe(false);
  });

  it("skips frames rather than throwing when the grant is lost mid-stream", async () => {
    const stream = fakeStream();
    const capture = broker({ getDisplayMedia: async () => stream });
    const frames = paintFrameSource(capture, async () => new Uint8Array([1]));

    await frames.start();
    stream.end();
    expect(await frames.capture()).toBeUndefined();
  });
});
