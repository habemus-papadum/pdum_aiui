/**
 * app.tsx — `<PencilRemoteApp/>`: the whole remote pencil client, composed.
 *
 * This is the paved road (owner, 2026-07-17): ONE client app served to every
 * host application, whose per-app differences arrive as the joined session's
 * {@link RemotePresentation} — never as a fork of this code. A host that
 * needs *more* than presentation can compose its own page from the same kit
 * pieces (`RemoteView`, `SessionPicker`, `PencilStrip`, `bindPenInput`,
 * `createPlaneTracker`) — the full-control escape hatch.
 *
 * What lives where (the split of the old lab client, kept verbatim in each
 * module):
 *
 *   plane.ts       the video CONTENT box (letterboxing!) tracked from the
 *                  video element's own resize events
 *   pen-input.ts   pencil-mode latch, palm rejection, two-finger navigation —
 *                  earned on a real iPad
 *   view.tsx       stage + video + plane + preview (`PencilSurface`,
 *                  `localInput: false`, the D3 crossfade sized from measured
 *                  link delays)
 *   strip.tsx      the tune strip, rendered FROM the presentation
 *   picker.tsx     the session list
 *
 * The command bar (`aiui-remote-bar`) rides its own socket (D5) and is
 * already per-application — the host publishes its caps.
 */

import {
  createRemoteBarClient,
  REMOTE_BAR_STYLES,
  RemoteBar,
} from "@habemus-papadum/aiui-remote-bar";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { ClientSession } from "../client-session";
import { clientRelayUrl } from "../host-session";
import { type PencilMode, resolveParams } from "../pencil";
import type { SessionInfo, StrokeOverrides } from "../protocol";
import type { LinkStats } from "../remote";
import type { Tool } from "../surface";
import { SessionPicker } from "./picker";
import { FULL_PRESENTATION, type ResolvedPresentation, resolvePresentation } from "./presentation";
import { PencilStrip } from "./strip";
import { REMOTE_APP_CSS } from "./styles";
import { RemoteView } from "./view";

export type Phase = "connecting" | "picking" | "viewing" | "lost";

export interface PencilRemoteAppOptions {
  /** The relay endpoint; defaults to same-origin `/pencil/client`. */
  url?: string;
}

/** The full default composition — what `GET /pencil/` serves. */
export function PencilRemoteApp(options: PencilRemoteAppOptions = {}): JSX.Element {
  const [phase, setPhase] = createSignal<Phase>("connecting");
  const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
  const [presentation, setPresentation] = createSignal<ResolvedPresentation>(FULL_PRESENTATION);
  const [videoUp, setVideoUp] = createSignal(false);
  const [videoNote, setVideoNote] = createSignal("waiting for video…");
  const [tool, setTool] = createSignal<Tool>("draw");
  const [mode, setMode] = createSignal<PencilMode>("write");
  /** Latches on the first pen event: after this, only the pencil inks. */
  const [penMode, setPenMode] = createSignal(false);
  // The brush knobs (presentation-gated): undefined = the preset's own value.
  const [color, setColor] = createSignal<string | undefined>(undefined);
  const [size, setSize] = createSignal<number | undefined>(undefined);

  /** What rides each strokeBegin — only knobs the presentation offers. */
  const overrides = (): StrokeOverrides | undefined => {
    const p = presentation();
    const c = p.color ? color() : undefined;
    const s = p.size ? size() : undefined;
    if (c === undefined && s === undefined) {
      return undefined;
    }
    return { ...(c !== undefined ? { color: c } : {}), ...(s !== undefined ? { size: s } : {}) };
  };

  /** The preview's params: the local preset merged with the same overrides. */
  const previewParams = () => {
    const base = resolveParams(mode());
    const o = overrides();
    return o === undefined
      ? base
      : {
          ...base,
          ...(o.color !== undefined ? { color: o.color } : {}),
          ...(o.size !== undefined ? { size: o.size } : {}),
        };
  };

  const session = new ClientSession({
    url: options.url ?? clientRelayUrl(),
    // The surface is supplied by the view once it mounts (the plane tracker
    // owns the content box); until then a 1×1 placeholder is harmless — no
    // strokes can begin before the view exists.
    surface: () => viewSurface(),
    tool,
    mode,
    overrides,
    video: () => videoEl(),
    onSessions: (list) => {
      setSessions(list);
      setPhase((p) => (p === "connecting" ? "picking" : p));
    },
    onJoined: (_host, _label, p) => {
      const resolved = resolvePresentation(p);
      setPresentation(resolved);
      // The presentation constrains the instrument: never leave a tool/mode
      // selected that the strip can no longer show.
      if (!resolved.tools.includes(tool())) {
        setTool(resolved.tools[0] ?? "draw");
      }
      if (!resolved.modes.includes(mode())) {
        setMode(resolved.modes[0] ?? "write");
      }
      setPhase("viewing");
    },
    onJoinRejected: () => setPhase("picking"),
    onHostGone: () => {
      setPhase("lost");
      setVideoUp(false);
    },
    onVideoStatus: (status) => {
      setVideoNote(
        status.state === "active"
          ? "waiting for video…"
          : status.state === "needsGesture"
            ? (status.detail ?? "the host must grant capture — waiting…")
            : status.state === "denied"
              ? `capture denied on the host${status.detail ? ` — ${status.detail}` : ""}`
              : "the host has no capture yet",
      );
    },
    onVideoUp: () => setVideoUp(true),
    onVideoDown: () => setVideoUp(false),
    onClose: () => setPhase("lost"),
  });

  // The bar rides its own socket (D5). Auto-join pairs it with the sole host;
  // when no bar host exists (a Lab without a mode engine), the component shows
  // its own "waiting" note and the pencil works regardless.
  const bar = createRemoteBarClient();

  // Adaptive preview fade (D3's permitted scope): poll the link's stats.
  let linkStats: LinkStats | undefined;
  setInterval(() => {
    void session.stats().then((s) => {
      linkStats = s;
    });
  }, 2000);

  // Wired by RemoteView on mount (the view owns the stage/video/plane DOM).
  let viewSurface: () => { width: number; height: number } = () => ({ width: 1, height: 1 });
  let videoEl: () => HTMLVideoElement | undefined = () => undefined;

  return (
    <main class="remote" style={accentStyle(presentation())}>
      <style>{REMOTE_APP_CSS}</style>
      <style>{REMOTE_BAR_STYLES}</style>
      <Show when={phase() !== "viewing"}>
        <SessionPicker phase={phase()} sessions={sessions()} onJoin={(id) => session.join(id)} />
      </Show>

      <div class="stage-wrap" style={{ display: phase() === "viewing" ? "flex" : "none" }}>
        <RemoteView
          session={session}
          tool={tool}
          params={previewParams}
          navigation={() => presentation().navigation}
          linkStats={() => linkStats}
          videoUp={videoUp()}
          videoNote={videoNote()}
          onPenMode={() => setPenMode(true)}
          expose={(surface, video) => {
            viewSurface = surface;
            videoEl = video;
          }}
        />

        {/* the host's command bar — its own channel (D5), one component */}
        <div class="host-bar">
          <RemoteBar client={bar} />
        </div>

        <PencilStrip
          presentation={presentation()}
          penMode={penMode()}
          tool={tool()}
          onTool={setTool}
          mode={mode()}
          onMode={setMode}
          color={color()}
          onColor={setColor}
          size={size()}
          onSize={setSize}
          onUndo={() => session.undo()}
          onClear={() => session.clear()}
        />
      </div>
    </main>
  );
}

/** The presentation's accent as a CSS custom property (chrome-level theming). */
function accentStyle(p: ResolvedPresentation): Record<string, string> {
  return p.accent !== undefined ? { "--remote-accent": p.accent } : {};
}
