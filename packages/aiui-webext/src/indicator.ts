/**
 * The minimal in-page indicator: the ONLY page chrome an aiui extension adds.
 *
 * Per the extension proposal §13.6 the page carries exactly what should be
 * capturable — the glowing border and the ink — so this is a viewport ring
 * plus the transient feedback flashes, and nothing else (the old dot/badge
 * anchor pill is gone; every control and hint lives in the side panel).
 *
 * Ring states: `armed` = steady glow (presence — everything still passes
 * through to the page); `turn` = breathing (a turn is open: the keyboard is
 * captured, content is being composed). Both are difference-blended neutrals
 * so they read on any background without sniffing it (a colored source flips
 * hue with the backdrop — measured live; see git history).
 *
 * Dependency-free (no Solid): content scripts stay slim.
 */

/** Stable id for the injected host element; also the double-mount guard. */
const HOST_ID = "aiui-webext-indicator-host";

export interface IndicatorState {
  /** Steady ring: the tool is armed (presence, not capture). */
  armed?: boolean;
  /** Breathing ring: a turn is open (keyboard captured, composing). */
  turn?: boolean;
}

export interface IndicatorHandle {
  /** Update what the indicator shows. Fields not given are unchanged. */
  set(state: IndicatorState): void;
  /**
   * A brief wash over the whole viewport. `miss` (soft pink + blur): "that
   * input wasn't registered" — the in-turn swallowed-typo feedback. `shot`
   * (aiui blue): "the frame was captured" — fired only AFTER the grab
   * returns, camera-style, and never for share-sampled frames (§13.6).
   */
  flash(kind: "miss" | "shot"): void;
  /** Remove the indicator from the page. */
  unmount(): void;
}

const STYLES = `
  :host { all: initial; }
  .ring {
    position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
    /* A soft glow, difference-blended so it reads on ANY background without
       sniffing it. The source is NEUTRAL on purpose: under difference a
       colored source flips hue with the backdrop (the original blue computed
       to an ugly brown on white — rejected live 2026-07-11), while a neutral
       one renders as a dark edge on light pages and a light edge on dark
       ones — the same vignette feel everywhere. Kept tight: the ring marks
       the viewport edge and must not reach into the page. */
    box-shadow: inset 0 0 10px 2px rgba(255, 255, 255, 0.5);
    mix-blend-mode: difference;
    display: none;
  }
  .armed .ring { display: block; }
  /* In a turn the ring breathes — composing must be unmistakable at a
     glance. Brightness modulation at fixed geometry (a radius pulse read as
     blinking annoyance, rejected live). */
  .turn .ring { display: block; animation: aiui-turn-pulse 1.6s ease-in-out infinite; }
  @keyframes aiui-turn-pulse {
    0%, 100% { box-shadow: inset 0 0 10px 2px rgba(255, 255, 255, 0.4); }
    50% { box-shadow: inset 0 0 12px 3px rgba(255, 255, 255, 0.85); }
  }
  /* Full-viewport feedback washes. Above the ring; re-triggered per flash.
     miss = fuzzy pink ("not registered"), shot = aiui blue ("captured"). */
  .flash {
    position: fixed; inset: 0; z-index: 2147483645; pointer-events: none;
    opacity: 0;
  }
  .flash.miss { background: rgba(255, 92, 128, 0.16); backdrop-filter: blur(2px); }
  .flash.shot { background: rgba(138, 180, 248, 0.25); }
  @keyframes aiui-flash-fade {
    from { opacity: 1; }
    to { opacity: 0; }
  }
`;

/**
 * Mount the indicator into the current page. Double-mount safe: a stale host
 * from a torn-down script (HMR) is replaced wholesale.
 */
export function mountIndicator(): IndicatorHandle {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.remove();
  }
  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLES;

  const root = document.createElement("div");
  const ring = document.createElement("div");
  ring.className = "ring";
  const flash = document.createElement("div");
  flash.className = "flash";
  root.append(ring, flash);
  shadow.append(style, root);
  document.documentElement.append(host);

  return {
    set(state) {
      if (state.armed !== undefined) {
        root.classList.toggle("armed", state.armed);
      }
      if (state.turn !== undefined) {
        root.classList.toggle("turn", state.turn);
      }
    },
    flash(kind) {
      flash.className = `flash ${kind}`;
      // Restarting the animation needs a reflow between "none" and re-set —
      // the standard retrigger dance, so rapid flashes each get a fresh blink.
      flash.style.animation = "none";
      void flash.offsetWidth;
      flash.style.animation = `aiui-flash-fade ${kind === "shot" ? 240 : 280}ms ease-out`;
    },
    unmount() {
      host.remove();
    },
  };
}
