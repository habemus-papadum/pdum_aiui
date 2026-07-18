/**
 * Server-side transport statistics for the `/ws` channel.
 *
 * The web backend records one entry per websocket frame it handles — size,
 * processing time, outcome — plus connection counts, all in memory. Any local
 * diagnostic page (none in-tree today) can read a point-in-time snapshot over
 * `GET /debug/api/stats`. This is the *server's* half of transport
 * observability; the client's half (ack round-trip latency as the page saw
 * it) is recorded by `aiui-intent-runtime`'s instrumentation and read straight
 * out of the inspected page.
 */

/** One handled frame, as the server saw it. */
export interface FrameStat {
  /** When the frame was handled (ISO timestamp). */
  at: string;
  /** Size of the raw frame in bytes (header + payload). */
  bytes: number;
  /** Time spent decoding + processing the frame, in milliseconds. */
  processMs: number;
  ok: boolean;
  threadId?: string;
  /** True when this frame closed its thread. */
  closed?: boolean;
}

/** A point-in-time view of the transport counters. */
export interface TransportSnapshot {
  /** When the server started counting (ISO timestamp). */
  startedAt: string;
  connections: { total: number; active: number };
  frames: { count: number; bytes: number };
  /** The most recent frames, oldest first (bounded ring). */
  recent: FrameStat[];
}

export interface TransportStats {
  connectionOpened(): void;
  connectionClosed(): void;
  recordFrame(stat: Omit<FrameStat, "at">): void;
  snapshot(): TransportSnapshot;
}

/** How many recent frames the ring keeps. */
const RECENT_LIMIT = 100;

/** Create an in-memory transport counter. */
export function createTransportStats(): TransportStats {
  const startedAt = new Date().toISOString();
  let total = 0;
  let active = 0;
  let frameCount = 0;
  let frameBytes = 0;
  const recent: FrameStat[] = [];

  return {
    connectionOpened() {
      total += 1;
      active += 1;
    },
    connectionClosed() {
      active = Math.max(0, active - 1);
    },
    recordFrame(stat) {
      frameCount += 1;
      frameBytes += stat.bytes;
      recent.push({ at: new Date().toISOString(), ...stat });
      if (recent.length > RECENT_LIMIT) {
        recent.splice(0, recent.length - RECENT_LIMIT);
      }
    },
    snapshot() {
      return {
        startedAt,
        connections: { total, active },
        frames: { count: frameCount, bytes: frameBytes },
        recent: [...recent],
      };
    },
  };
}
