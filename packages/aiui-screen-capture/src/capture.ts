import { browserScreenCaptureDriver } from "./browser";
import { targetLabel } from "./model";
import { elementCaptureIssue, targetUnavailableReason } from "./targets";
import type {
  CaptureOptions,
  CaptureSnapshot,
  CaptureTarget,
  ScreenCapture,
  ScreenCaptureDriver,
} from "./types";

interface Session {
  stream: MediaStream;
  track: MediaStreamTrack;
  target: CaptureTarget | null;
  cleanup(): void;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const release = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

/** Own one capture. Widgets and downstream consumers borrow it; only the controller releases it. */
export function createScreenCapture(options: { driver?: ScreenCaptureDriver } = {}): ScreenCapture {
  const driver = options.driver ?? browserScreenCaptureDriver();
  let state: CaptureSnapshot = { state: "idle", requesting: false, cropping: false, muted: false };
  let current: Session | undefined;
  let acquiring: MediaStream | undefined;
  let generation = 0;
  let disposed = false;
  let queue = Promise.resolve();
  let pendingCrops = 0;
  const listeners = new Set<(state: CaptureSnapshot) => void>();
  function emit(update: Partial<CaptureSnapshot>) {
    const next = { ...state, ...update };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const listener of listeners) listener(state);
  }
  function read(session: Session) {
    if (current !== session) return;
    const settings = session.track.getSettings();
    const unavailableReason = session.target ? targetUnavailableReason(session.target) : undefined;
    emit({
      muted: session.track.muted,
      source: { label: session.track.label, surface: settings.displaySurface },
      settings: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
      crop: session.target
        ? {
            mode: session.target.mode ?? "region",
            label: targetLabel(session.target),
            available: !unavailableReason,
            unavailableReason,
          }
        : undefined,
    });
  }
  function retire() {
    const old = current;
    current = undefined;
    old?.cleanup();
    if (old) release(old.stream);
  }
  function stop() {
    generation++;
    if (acquiring) release(acquiring);
    acquiring = undefined;
    retire();
    pendingCrops = 0;
    queue = Promise.resolve();
    emit({
      state: "idle",
      cropping: false,
      muted: false,
      source: undefined,
      settings: undefined,
      crop: undefined,
      error: undefined,
    });
  }
  function validate(target: CaptureTarget | null) {
    if (!target) return;
    if (!target.element.isConnected)
      throw new Error("The capture target is no longer on the page.");
    const mode = target.mode ?? "region";
    if (mode === "element") {
      const issue = elementCaptureIssue(target.element);
      if (issue) throw new Error(issue);
    }
    if (!driver.capabilities()[mode])
      throw new Error(
        `${mode === "region" ? "Region" : "Element"} capture is unavailable in this browser.`,
      );
  }
  function live() {
    if (disposed) throw new Error("This screen capture has been disposed.");
  }
  const api: ScreenCapture = {
    async start(opts: CaptureOptions = {}) {
      live();
      if (state.requesting) throw new Error("A screen selection is already pending.");
      if (state.cropping)
        throw new Error("Wait for the crop change to finish before choosing a new screen.");
      const target = opts.target ? { ...opts.target } : null;
      const ticket = ++generation;
      let stream: MediaStream | undefined;
      emit({ state: "requesting", requesting: true, error: undefined });
      try {
        validate(target);
        if (
          opts.frameRate !== undefined &&
          (!Number.isFinite(opts.frameRate) || opts.frameRate <= 0)
        )
          throw new Error("Frame rate must be a positive number.");
        stream = await driver.acquire(opts);
        if (disposed || ticket !== generation) {
          release(stream);
          return undefined;
        }
        acquiring = stream;
        const track = stream.getVideoTracks()[0];
        if (track?.readyState !== "live")
          throw new Error("The source did not provide a live video track.");
        // This package is video-only, including when supplied by a custom driver.
        for (const extra of stream.getTracks())
          if (extra !== track) {
            extra.stop();
            stream.removeTrack(extra);
          }
        if (target) await driver.applyTarget(track, target);
        if (disposed || ticket !== generation) {
          release(stream);
          return undefined;
        }
        if (track.readyState !== "live")
          throw new Error("Screen sharing ended while capture was starting.");
        track.enabled = true;
        retire();
        const session: Session = { stream, track, target, cleanup: () => {} };
        current = session;
        const ended = () => {
          if (current === session) stop();
        };
        const changed = () => read(session);
        track.addEventListener("ended", ended);
        track.addEventListener("mute", changed);
        track.addEventListener("unmute", changed);
        const timer = setInterval(changed, 500);
        session.cleanup = () => {
          clearInterval(timer);
          track.removeEventListener("ended", ended);
          track.removeEventListener("mute", changed);
          track.removeEventListener("unmute", changed);
        };
        acquiring = undefined;
        emit({ state: "active", error: undefined });
        read(session);
        return stream;
      } catch (error) {
        if (stream) release(stream);
        if (disposed || ticket !== generation) return undefined;
        emit({ state: current ? "active" : "error", error: message(error) });
        throw error;
      } finally {
        acquiring = undefined;
        emit({ requesting: false });
      }
    },
    stream: () => current?.stream,
    target: () => (current?.target ? { ...current.target } : undefined),
    snapshot: () => state,
    capabilities: () => driver.capabilities(),
    setTarget(value) {
      try {
        live();
        if (!current) throw new Error("Start screen capture before selecting a crop.");
        if (state.requesting)
          throw new Error("Finish choosing the screen before changing its crop.");
        validate(value);
      } catch (error) {
        if (!disposed) emit({ error: message(error) });
        return Promise.reject(error);
      }
      const session = current as Session;
      const target = value ? { ...value } : null;
      const ticket = generation;
      pendingCrops++;
      emit({ cropping: true, error: undefined });
      const operation = queue.then(async () => {
        if (current !== session || ticket !== generation) return;
        try {
          validate(target);
          await driver.applyTarget(
            session.track,
            target,
            session.target?.mode ?? (session.target ? "region" : undefined),
          );
          if (current !== session || ticket !== generation) return;
          if (session.track.readyState !== "live")
            throw new Error("Screen sharing ended while cropping.");
          session.target = target;
          read(session);
        } catch (error) {
          if (current !== session || ticket !== generation) return;
          // A failed native transition must never silently widen the published capture.
          stop();
          emit({ state: "error", error: `Capture stopped: ${message(error)}` });
          throw error;
        } finally {
          if (ticket === generation) {
            pendingCrops--;
            emit({ cropping: pendingCrops > 0 });
          }
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listeners.clear();
    },
  };
  return api;
}
