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
import type { LaneContext } from "./types";

export function createCaptureLanes(ctx: LaneContext): ClaimLaneOptions {
  const { host, engine, wire, status, toast, pencilTabs } = ctx;

  // ── the video frame pump (the real videoSample applier) ───────────────────
  // Smart mode's gate: page interaction pings arm one frame (read-and-clear).
  let pageInteracted = false;
  host.transport.onPageEvent((event) => {
    if (event.kind === "regionDrag") {
      // The armed `a` drag completed: crop the region (host-native — CDP clip
      // or the warm stream's canvas), then into the turn exactly like a shot.
      void (async () => {
        try {
          const shot =
            host.capture.grabRegion !== undefined
              ? await host.capture.grabRegion(event.tab, event.rect, event.viewport)
              : await host.capture.grabShot(event.tab); // degraded: full frame
          if (shotFlash.get() === true) {
            void host.transport.requestPage(event.tab, "flash", { kind: "shot" }).catch(() => {});
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
    } else if (event.kind === "navigation") {
      // Same-tab navigation: context riding the turn (the engine no-ops
      // without an open thread), rendered into the prompt by composeIntent.
      // The destination's tab record rides along when the reporter built one.
      engine.navigation(event.from, event.to, event.navKind, event.tabRecord);
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

  return {
    pencilFadeSec: () => (pencilVanish.get() === true ? (pencilFade.get() as number) : 0),
    onPencilEngaged: (tab) => pencilTabs.add(tab),
    videoSampler: {
      start: async (desire) => {
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
          intervalMs: () =>
            desire.mode === "smart" ? 1000 : (videoPeriodSec.get() as number) * 1000,
          shouldCapture: () => {
            if (desire.mode !== "smart") {
              return true;
            }
            const had = pageInteracted;
            pageInteracted = false;
            return had;
          },
          rearm: () => {
            pageInteracted = true; // the tick consumed the gate, delivered nothing
          },
        });
        sampler.start();
        return () => sampler.stop();
      },
    },
  };
}
