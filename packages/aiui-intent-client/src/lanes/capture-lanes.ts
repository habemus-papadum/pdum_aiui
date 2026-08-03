/**
 * capture-lanes.ts — the host-facing capture wing over a LaneContext: the
 * page-event pump (region-drag crop, the smart-mode interaction gate, same-tab
 * navigation), the tab-switch boundary tracker, and the claim hooks (ink fade
 * + the video frame pump). `pageInteracted` (the smart gate) and
 * `lastActiveTab` (the boundary tracker's memory) stay private closure state
 * here — their writers and readers all live in this module.
 */

import { VideoSampler } from "@habemus-papadum/aiui-intent-runtime/video";
import type { ClaimLaneOptions } from "../claims";
import { pencilFade, pencilVanish, shotFlash, videoPeriodSec } from "../config";
import { sendShotToOracle } from "./oracle-contributions";
import type { LaneContext } from "./types";

/** Smart mode's decision tick — every tick DECIDES against the activity
 * ledger; few become frames. Fast enough that the settle frame lands within
 * ~¼s of quiescence elapsing. */
const SMART_TICK_MS = 250;
/** Activity that stayed quiet this long earns the settle frame — the shot of
 * the FINISHED stroke. Must exceed the page's ping throttle (250ms), or a
 * continuous stroke's ping gaps would read as quiescence mid-stroke. */
const QUIESCE_MS = 1000;

export function createCaptureLanes(ctx: LaneContext): ClaimLaneOptions {
  const { host, engine, wire, status, toast, pencilTabs, pauseGate } = ctx;

  // ── the video frame pump (the real videoSample applier) ───────────────────
  // Smart mode's activity ledger: interaction pings (pointer/keys/wheel, pencil
  // strokes local AND remote — the page throttles them to ≤1 per 250ms) mark
  // unphotographed activity and stamp its wall-clock. The gate below turns the
  // ledger into frames.
  let pageInteracted = false;
  let lastActivityAt = 0;
  host.transport.onPageEvent((event) => {
    if (event.kind === "regionDrag") {
      // Route by SINK, and drop only when there is none (O3d). This used to
      // test `pauseGate.paused`, which was right while the turn was the only
      // destination — but the oracle taking the sink SETS that gate, so the
      // old guard would have swallowed exactly the drags the oracle is
      // supposed to receive. No sink at all still drops: a stray late report
      // after the mode cleared (`area-needs-a-sink`) must land nowhere.
      const drag = ctx.sink?.();
      if (drag === undefined) {
        return;
      }
      // The armed `a` drag completed: crop the region (host-native — CDP clip
      // or the warm stream's canvas), then into the SINK exactly like a shot.
      void (async () => {
        try {
          const shot =
            host.capture.grabRegion !== undefined
              ? await host.capture.grabRegion(event.tab, event.rect, event.viewport)
              : await host.capture.grabShot(event.tab); // degraded: full frame
          if (shotFlash.get() === true) {
            void host.transport.requestPage(event.tab, "flash", { kind: "shot" }).catch(() => {});
          }
          // The same fork the manual shot takes (O3d) — and the area drag is
          // the one that most wants it: framing a thing is how you ask the
          // oracle about that thing. The located elements ride along, so the
          // caption carries the same element/cell block the prompt would.
          if (drag === "oracle") {
            sendShotToOracle(ctx.oracle, {
              bytes: shot.bytes,
              mime: shot.mime,
              rect: event.rect,
              components: (event.components ?? []) as never,
              area: true,
            });
            status(
              `area sent to the oracle (${Math.round(event.rect.w)}×${Math.round(event.rect.h)})`,
            );
            return;
          }
          const marker = engine.shotDone(
            event.rect,
            (event.components ?? []) as never,
            shot.thumb ?? "",
            undefined,
            false,
            event.takenAt,
          );
          await wire.uploadAttachment(marker, shot.mime, shot.bytes);
          status(
            `${marker} captured (region ${Math.round(event.rect.w)}×${Math.round(event.rect.h)})`,
          );
        } catch (err) {
          toast(`region shot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }
    if (event.kind === "interaction") {
      pageInteracted = true;
      lastActivityAt = Date.now();
    } else if (event.kind === "navigation") {
      // Same-tab navigation: context riding the turn (the engine no-ops
      // without an open thread), rendered into the prompt by composeIntent.
      // The destination's tab record rides along when the reporter built one.
      // SUPPRESSED while paused (owner, 2026-07-30): where the user wandered
      // during a pause is nobody's business — the resume compare below emits
      // at most one boundary for the whole gap.
      if (!pauseGate.paused) {
        engine.navigation(event.from, event.to, event.navKind, event.tabRecord);
      }
    }
  });

  // ── tab boundaries: switching WHICH tab you look at mid-turn is its own
  // boundary — a `tab-switch` event, distinct from a same-tab navigation, so
  // the prompt says "you switched tabs" and carries both tab identities (the
  // retired panel conflated the two into one navigation; the split is owner,
  // 2026-07-16). Identity via tabInfo, not chrome.tabs.
  let lastActiveTab: { id: number; url?: string } | undefined;
  const seedTab = host.targeting.activeTab();
  if (seedTab !== undefined) {
    void host.targeting.tabInfo?.(seedTab).then((info) => {
      lastActiveTab ??= { id: seedTab, url: info?.url };
    });
  }
  host.targeting.onActiveTabChange((tab) => {
    void (async () => {
      const prev = lastActiveTab;
      if (tab === undefined) {
        return;
      }
      const to = await host.targeting.tabInfo?.(tab);
      lastActiveTab = { id: tab, url: to?.url };
      if (prev === undefined || prev.id === tab) {
        return;
      }
      // Mid-pause switches are SUPPRESSED (owner, 2026-07-30) — the tracker
      // above still followed, so the resume compare (and the post-resume
      // boundaries) stay grounded in where the user actually is.
      if (pauseGate.paused) {
        return;
      }
      // `from` re-read at boundary time: the tab may have navigated since it
      // was last active; the boundary names where the user actually left, and
      // the two tab handles ride along. The destination's canonical record is
      // assembled from whatever the host's tabInfo contributed (its own id
      // namespace included) — the lowering renders it as the <tab> element.
      const from = (await host.targeting.tabInfo?.(prev.id))?.url ?? prev.url;
      const record = to?.url !== undefined ? { ...to, url: to.url } : undefined;
      engine.tabSwitch(from ?? "", to?.url ?? "", prev.id, tab, record);
    })();
  });

  // ── the pause snapshot + the resume compare (owner, 2026-07-30) ───────────
  // Boundaries across a pause collapse to a comparison: snapshot the tab in
  // view at pause; at resume, a different tab emits ONE tab-switch, the same
  // tab on a different URL emits ONE navigation (kind unknown), unchanged
  // emits nothing. The boundary is stamped at resume time and lands after the
  // `turn-resume` bracket (verbs.ts orders the calls) — its position is the
  // attribution. Best-effort async: the URL re-reads ride tabInfo, so a word
  // spoken in the first instant after resume can land before the boundary
  // (the accepted-race family, like the lint-final race).
  let pausedAt: { id: number; url?: string } | undefined;
  pauseGate.onPause = () => {
    const id = host.targeting.activeTab();
    if (id === undefined) {
      pausedAt = undefined;
      return;
    }
    // Seed from the tracker (may be stale if the tab navigated since its last
    // switch), then let the authoritative re-read land over it.
    const snapshot: { id: number; url?: string } = {
      id,
      url: lastActiveTab?.id === id ? lastActiveTab.url : undefined,
    };
    pausedAt = snapshot;
    void host.targeting.tabInfo?.(id).then((info) => {
      if (pausedAt === snapshot && info?.url !== undefined) {
        snapshot.url = info.url;
      }
    });
  };
  pauseGate.onResume = () => {
    const snapshot = pausedAt;
    pausedAt = undefined;
    void (async () => {
      const tab = host.targeting.activeTab();
      if (snapshot === undefined || tab === undefined) {
        return;
      }
      const to = await host.targeting.tabInfo?.(tab);
      const record = to?.url !== undefined ? { ...to, url: to.url } : undefined;
      if (tab !== snapshot.id) {
        engine.tabSwitch(snapshot.url ?? "", to?.url ?? "", snapshot.id, tab, record);
      } else if (to?.url !== undefined && snapshot.url !== undefined && to.url !== snapshot.url) {
        // Same tab, different page: a navigation with no attributable kind —
        // we were deliberately not watching how it got there.
        engine.navigation(snapshot.url, to.url, undefined, record);
      }
    })();
  };

  return {
    pencilFadeSec: () => (pencilVanish.get() === true ? (pencilFade.get() as number) : 0),
    onPencilEngaged: (tab) => pencilTabs.add(tab),
    videoSampler: {
      start: async (desire) => {
        // The gate's frame ledger: when it last granted a frame, and the value
        // to roll back to when a granted tick delivers nothing (rearm).
        let lastFrameAt = 0;
        let prevFrameAt = 0;
        const sampler = new VideoSampler({
          captureFrame: async () => {
            try {
              // Sampled frames keep a CAPPED thumb (owner, 2026-07-16): a full-res
              // thumb rides every frame, so it would bloat the events + the trace.
              // Manual/area shots (infrequent) leave it full-res for a crisp peek.
              // 1024 carries over the retired dev-overlay's sampled-frame cap.
              return await host.capture.grabShot(desire.tab, { thumbMaxPx: 1024 });
            } catch {
              return undefined; // no warm stream right now — the tick owes nothing
            }
          },
          sendFrame: (_frame, shot) => {
            const marker = engine.shotDone(
              { x: 0, y: 0, w: shot.width, h: shot.height },
              [],
              shot.thumb ?? "",
              undefined,
              false, // sampled, not manual — no flash, quieter preview
              Date.now(),
            );
            void wire.uploadAttachment(marker, shot.mime, shot.bytes);
          },
          // Smart mode ticks FAST and captures rarely: every tick is a cheap
          // decision against the activity ledger; the gate below says which
          // ticks become frames. Constant mode ticks exactly at the cadence.
          intervalMs: () =>
            desire.mode === "smart" ? SMART_TICK_MS : (videoPeriodSec.get() as number) * 1000,
          // Smart mode's gate (owner, 2026-08-03). Three rules, from the
          // activity ledger:
          //  - sustained activity (drawing, dragging) → a frame every
          //    videoPeriodSec, the SAME slider constant mode reads;
          //  - activity that then went quiet for QUIESCE_MS → one settle
          //    frame, so the END of every stroke is photographed (pings keep
          //    re-arming the flag after a mid-stroke frame);
          //  - no activity → no frames, however long the share sits.
          shouldCapture: () => {
            if (desire.mode !== "smart") {
              return true;
            }
            if (!pageInteracted) {
              return false;
            }
            const now = Date.now();
            const settled = now - lastActivityAt >= QUIESCE_MS;
            const due = now - lastFrameAt >= (videoPeriodSec.get() as number) * 1000;
            if (!settled && !due) {
              return false;
            }
            pageInteracted = false;
            prevFrameAt = lastFrameAt;
            lastFrameAt = now;
            return true;
          },
          rearm: () => {
            // The tick consumed the gate but delivered nothing: hand back the
            // flag AND the cadence slot it claimed, or the retry waits a full
            // period for a frame it already earned.
            pageInteracted = true;
            lastFrameAt = prevFrameAt;
          },
        });
        sampler.start();
        return () => sampler.stop();
      },
    },
  };
}
