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
import type { IntentHost } from "./transport";

/** The session surface we drive — HostSession's, narrowed to what we fake. */
export interface PencilHostSession {
  connect(): void;
  refresh(): void;
  dispose(): void;
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
  dispose(): void;
}

/** A default plane until the real viewport is queried — a sane aspect beats
 * zero (which would collapse every `fromNorm` to the origin). */
const DEFAULT_PLANE: Surface = { width: 1280, height: 720 };

export function createPencilHost(opts: PencilHostOptions): PencilHost {
  let size: Surface = DEFAULT_PLANE;

  const forward = (payload: Record<string, unknown>): void => {
    const tab = opts.tab();
    if (tab !== undefined) {
      void opts.host.transport.requestPage(tab, "pencil", payload).catch(() => {});
    }
  };

  // The proxy surface: only the fire-and-forget calls RemoteHost makes, each
  // forwarded to the in-page surface. Cast because we deliberately implement a
  // sliver of PencilSurface — the exact sliver the remote host touches.
  const proxy = {
    remoteBegin: (id: string, init: { tool: Tool; params: PencilParams; point: PenSample }) =>
      forward({ op: "rbegin", id, init }),
    remotePoint: (id: string, point: PenSample) => forward({ op: "rpoint", id, point }),
    remoteEnd: (id: string, point?: PenSample) =>
      forward({ op: "rend", id, ...(point !== undefined ? { point } : {}) }),
    remoteCancel: (id: string) => forward({ op: "rcancel", id }),
    undo: () => forward({ op: "undo" }),
    clear: () => forward({ op: "clear" }),
  } as unknown as PencilSurface;

  const refreshSize = (): void => {
    const tab = opts.tab();
    if (tab === undefined) {
      return;
    }
    void opts.host.transport
      .requestPage(tab, "pencil", { op: "size" })
      .then((got) => {
        const s = got as { width?: number; height?: number } | undefined;
        if (s?.width !== undefined && s.width > 0 && s?.height !== undefined && s.height > 0) {
          size = { width: s.width, height: s.height };
        }
      })
      .catch(() => {});
  };

  const factory = opts.sessionFactory ?? ((o: HostSessionOptions) => new HostSession(o));
  const session = factory({
    url: `ws://127.0.0.1:${opts.port}/pencil/host`,
    label: opts.label,
    surface: () => proxy,
    size: () => size,
    stream: opts.stream,
    ...(opts.streamHint ? { streamHint: opts.streamHint } : {}),
    ...(opts.onScroll ? { onScroll: opts.onScroll } : {}),
    ...(opts.onZoom ? { onZoom: opts.onZoom } : {}),
    ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
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
    dispose: () => {
      offTab();
      session.dispose();
    },
  };
}
