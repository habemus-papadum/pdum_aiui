/**
 * pencil-host.ts — the panel's half of the REMOTE pencil: an iPad draws on a
 * video of the tab, and its strokes land on the in-page pencil surface next to
 * the local stylus (Phase 2 of the pencil integration).
 *
 * The pencil's `HostSession` owns the relay socket and the WebRTC lifecycle;
 * an integrator hands it a surface, a video stream, and a plane size. Ours is
 * the awkward-but-clean case the library was built to allow: the surface is in
 * the TARGET page, across the transport, while the session runs in the panel
 * where the video stream lives. So `surface()` is a **proxy** — `RemoteHost`
 * only ever calls fire-and-forget methods on it (remote.ts:
 * remoteBegin/Point/End/Cancel, undo, clear), so we forward each as a `pencil`
 * capability op to the page, where the real surface consumes it. `PencilParams`
 * is pure data, so the `remoteBegin` payload serializes cleanly.
 *
 * The video and the plane size come from the tier (the panel supplies them):
 * MV3 warms a `tabCapture` MediaStream (ext/capture.ts); the CDP tier
 * synthesizes one from a screencast (cdp/screencast.ts). The plane SIZE must
 * equal the captured frame — we query the page's own surface size (CSS px) and
 * cache it, re-querying on a tab switch.
 *
 * One persistent host per panel: it registers a session the iPad can join any
 * time, and its getters follow the tab in view — strokes forward to the active
 * tab, video is whatever stream is warm (a turn), size is that tab's viewport.
 */

import {
  HostSession,
  type HostSessionOptions,
  type HostSessionStatus,
  type PencilParams,
  type PencilSurface,
  type PenSample,
  type Surface,
  type Tool,
} from "@habemus-papadum/aiui-pencil";
import { letterboxFit } from "./ext/capture";
import { MARKUP } from "./page/pencil-mount";
import type { IntentHost, PencilOp } from "./transport";

/** The session surface we drive — HostSession's, narrowed to what we fake. */
export interface PencilHostSession {
  connect(): void;
  refresh(): void;
  dispose(): void;
  /** Rename the session live (re-registers). Optional: test fakes may omit it. */
  setName?(name: string): void;
  /** Re-push videoStatus (the plane rider) without re-offering. Optional. */
  announce?(): void;
}

export interface PencilHostOptions {
  host: IntentHost;
  /** The channel port — the relay is on it; the host dials it LOOPBACK. */
  port: number;
  /** The tab remote strokes forward to (the tab in view). */
  tab: () => number | undefined;
  /** The tier's video of that tab (MV3 tabCapture / CDP screencast). */
  stream: () => MediaStream | undefined;
  /** Why there is no stream yet (shown on the iPad as videoStatus detail). */
  streamHint?: () => string | undefined;
  /** The session label the iPad sees in its list. */
  label: string;
  /** The human-visible session name ("courageous-beaver") the picker leads with. */
  name?: string;
  /** A viewer scrolled/zoomed — forward to the page (the app decides meaning). */
  onScroll?: (du: number, dv: number) => void;
  onZoom?: (centerU: number, centerV: number, scale: number) => void;
  onStatus?: (status: HostSessionStatus) => void;
  /** Test seam: build the session (default: a real HostSession). */
  sessionFactory?: (options: HostSessionOptions) => PencilHostSession;
}

export interface PencilHost {
  connect(): void;
  /** Re-query the plane size and re-offer video (after a tab switch). */
  refresh(): void;
  /** Re-push videoStatus without re-offering — for facts that change the
   * MESSAGE but not the stream (the grant landing; the plane moving). */
  announce(): void;
  /** Rename the session live — the iPad's picker updates without a reconnect. */
  setName(name: string): void;
  dispose(): void;
}

/** A default plane until the real viewport is queried — a sane aspect beats
 * zero (which would collapse every `fromNorm` to the origin). */
const DEFAULT_PLANE: Surface = { width: 1280, height: 720 };

/** How often the plane is re-queried while an iPad is connected. Resize and
 * zoom move the viewport with no tab switch — the only signals the host used
 * to re-query on — and a stale plane skews every remote stroke linearly
 * (found live 2026-07-25, the A2 ladder's Suspect A). */
const PLANE_POLL_MS = 1000;

/**
 * Map a remote sample from FRAME space onto the page's CSS plane. The iPad
 * normalizes against the video frame it sees; RemoteHost denormalized that
 * against OUR plane, assuming frame ≡ plane (D2). After a resize the frame
 * stops matching the tab — the stream keeps its hold-time size box and Chrome
 * re-fits the new tab shape inside it, bars INSIDE the picture — so that
 * assumption lands every stroke offset and scaled (measured live 2026-07-25:
 * plane 2230×1190 against a 1556×1182 track). This is the same letterbox belt
 * the shot path wears (ext/capture.ts); identity when the frame matches the
 * plane's aspect. Pure — exported for tests.
 */
export function correctRemotePoint(
  point: PenSample,
  plane: Surface,
  frame: { width: number; height: number } | undefined,
): PenSample {
  if (
    frame === undefined ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    plane.width <= 0 ||
    plane.height <= 0
  ) {
    return point;
  }
  const fit = letterboxFit(
    { w: frame.width, h: frame.height },
    { w: plane.width, h: plane.height },
  );
  if (fit.scale <= 0) {
    return point;
  }
  const u = point.x / plane.width;
  const v = point.y / plane.height;
  return {
    ...point,
    x: (u * frame.width - fit.offX) / fit.scale,
    y: (v * frame.height - fit.offY) / fit.scale,
  };
}

export function createPencilHost(opts: PencilHostOptions): PencilHost {
  let size: Surface = DEFAULT_PLANE;

  const forward = (op: PencilOp): void => {
    const tab = opts.tab();
    if (tab !== undefined) {
      void opts.host.transport.requestPage(tab, "pencil", op).catch(() => {});
    }
  };

  /** The held track's actual frame size — the letterbox belt's ground truth. */
  const frameSize = (): { width: number; height: number } | undefined => {
    const settings = opts.stream()?.getVideoTracks()[0]?.getSettings();
    return settings?.width !== undefined &&
      settings.width > 0 &&
      settings?.height !== undefined &&
      settings.height > 0
      ? { width: settings.width, height: settings.height }
      : undefined;
  };
  const fix = (point: PenSample): PenSample => correctRemotePoint(point, size, frameSize());

  // The proxy surface: only the fire-and-forget calls RemoteHost makes, each
  // forwarded to the in-page surface. Cast because we deliberately implement a
  // sliver of PencilSurface — the exact sliver the remote host touches.
  const proxy = {
    // Clamp what the presentation doesn't offer (a stale or foreign client
    // could still send it): draw only, and the intent client's ONE brush — the
    // red MARKUP pencil, the same instrument the local stylus holds
    // (pencil-mount.ts). RemoteHost merged any overrides before we got here,
    // so re-resolving is not enough; force the fields.
    remoteBegin: (id: string, init: { tool: Tool; params: PencilParams; point: PenSample }) =>
      forward({
        op: "rbegin",
        id,
        init: { ...init, tool: "draw", params: MARKUP, point: fix(init.point) },
      }),
    remotePoint: (id: string, point: PenSample) => forward({ op: "rpoint", id, point: fix(point) }),
    remoteEnd: (id: string, point?: PenSample) =>
      forward({ op: "rend", id, ...(point !== undefined ? { point: fix(point) } : {}) }),
    remoteCancel: (id: string) => forward({ op: "rcancel", id }),
    undo: () => forward({ op: "undo" }),
    clear: () => forward({ op: "clear" }),
  } as unknown as PencilSurface;

  const refreshSize = (onChange?: () => void): void => {
    const tab = opts.tab();
    if (tab === undefined) {
      return;
    }
    void opts.host.transport
      .requestPage(tab, "pencil", { op: "size" })
      .then((got) => {
        const s = got as { width?: number; height?: number } | undefined;
        if (s?.width !== undefined && s.width > 0 && s?.height !== undefined && s.height > 0) {
          const changed = s.width !== size.width || s.height !== size.height;
          size = { width: s.width, height: s.height };
          if (changed) {
            onChange?.();
          }
        }
      })
      .catch(() => {});
  };

  // The plane poll: while an iPad is connected, re-query the viewport every
  // second and re-announce on change (resize/zoom happen with no tab switch —
  // the only edges the host used to see). Viewer count rides the session's
  // own status feed, so the poll costs nothing while nobody is watching.
  let poll: ReturnType<typeof setInterval> | undefined;
  const syncPoll = (viewers: number): void => {
    const wanted = viewers > 0;
    if (wanted && poll === undefined) {
      poll = setInterval(() => refreshSize(() => session.announce?.()), PLANE_POLL_MS);
    } else if (!wanted && poll !== undefined) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  const factory = opts.sessionFactory ?? ((o: HostSessionOptions) => new HostSession(o));
  const session = factory({
    url: `ws://127.0.0.1:${opts.port}/pencil/host`,
    label: opts.label,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    // The paved-road customization (owner, 2026-07-17): the intent client's
    // remote is a MARKUP surface, not a paint studio — one tool, one preset,
    // no brush knobs. Navigation stays on (two-finger scroll/zoom forward to
    // the page). undo/clear stay: the iPad should be able to take back a
    // stroke without reaching for the desktop's `c`.
    presentation: {
      title: "aiui intent",
      tools: ["draw"],
      modes: ["write"],
      undo: true,
      clear: true,
      navigation: true,
      color: false,
      size: false,
      // The one brush's color, declared so the iPad's local PREVIEW paints
      // the same red the host inks (the clamp above enforces it wire-side).
      strokeColor: MARKUP.color,
    },
    surface: () => proxy,
    size: () => size,
    stream: opts.stream,
    ...(opts.streamHint ? { streamHint: opts.streamHint } : {}),
    ...(opts.onScroll ? { onScroll: opts.onScroll } : {}),
    ...(opts.onZoom ? { onZoom: opts.onZoom } : {}),
    onStatus: (status) => {
      syncPoll(status.viewers);
      opts.onStatus?.(status);
    },
  });

  // Follow the tab in view: re-query the plane and re-offer the (new) stream.
  const offTab = opts.host.targeting.onActiveTabChange(() => {
    refreshSize();
    session.refresh();
  });

  return {
    connect: () => {
      refreshSize();
      session.connect();
    },
    refresh: () => {
      refreshSize();
      session.refresh();
    },
    announce: () => {
      session.announce?.();
    },
    setName: (name) => {
      session.setName?.(name);
    },
    dispose: () => {
      offTab();
      syncPoll(0);
      session.dispose();
    },
  };
}
