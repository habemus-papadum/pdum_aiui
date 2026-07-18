/**
 * cdp-reports.ts — fold one page-script `PageReport` into the AttachedPage's
 * facts and the outbound `PageEvent` stream. Split out of cdp-bus.ts; the
 * session lookup stays in cdp-bus's `bindingCalled` branch, only the per-page
 * mapping lives here. The mutation of the page record is in place, exactly as
 * before.
 *
 * Panel-side only. Never import this from page-script.ts / page-bundle.ts: those
 * are stringified/evaluated INTO arbitrary pages and must stay dependency-free.
 */
import type { PageReport } from "../page/report";
import type { PageEvent } from "../transport";
import type { AttachedPage } from "./cdp-bus";

/** The callbacks the report mapping fans out through: the PageEvent sink, the
 * leader-tab fold, the reload replay, and the log. */
export interface HandleReportIo {
  emit(event: PageEvent): void;
  relead(page: AttachedPage): void;
  replay(page: AttachedPage): void;
  log(message: string): void;
}

export function handleReport(page: AttachedPage, report: PageReport, io: HandleReportIo): void {
  const { emit, relead, replay, log } = io;
  switch (report.kind) {
    case "hello": {
      const reloaded = page.url !== "" && page.url !== report.url;
      // A hello means a document that has just installed the bootstrap —
      // and a fresh document carries none of the page bundle we evaluated
      // into the last one.
      page.bundleInjected = false;
      page.url = report.url;
      page.title = report.title;
      page.visible = report.visible;
      page.focused = report.focused;
      page.aiui = report.aiui;
      emit({ kind: "aiuiSupport", tab: page.tab, supported: report.aiui });
      relead(page);
      // A fresh document (reload or full navigation) lost everything the
      // client had asserted — and the client's desire never changed, so no
      // claim will re-apply. The bus does it.
      replay(page);
      if (reloaded) {
        log(`page ${page.tab} loaded ${report.url}`);
      }
      break;
    }
    case "focus":
      page.visible = report.visible;
      page.focused = report.focused;
      relead(page);
      break;
    case "selection":
      page.selectionPresent = report.present;
      emit({ kind: "selectionPresent", tab: page.tab, present: report.present });
      break;
    case "interaction":
      emit({ kind: "interaction", tab: page.tab });
      break;
    case "navigation":
      emit({
        kind: "navigation",
        tab: page.tab,
        from: report.from,
        to: report.to,
        navKind: report.navKind,
        // The page-built record, enriched with THIS host's id namespace
        // (the CDP target and the driver's tab handle).
        ...(report.tab !== undefined
          ? { tabRecord: { ...report.tab, targetId: page.targetId, driverTab: page.tab } }
          : {}),
      });
      page.url = report.to;
      break;
    case "key":
      emit({
        kind: "keyForward",
        tab: page.tab,
        key: report.key,
        phase: report.phase,
        repeat: report.repeat,
      });
      break;
    case "tools":
      emit({ kind: "pageTools", tab: page.tab, registrations: report.registrations });
      break;
    case "toolsResult":
      emit({
        kind: "toolsResult",
        tab: page.tab,
        callId: report.callId,
        ok: report.ok,
        ...(report.value !== undefined ? { value: report.value } : {}),
        ...(report.error !== undefined ? { error: report.error } : {}),
      });
      break;
    case "region":
      emit({
        kind: "regionDrag",
        tab: page.tab,
        rect: report.rect,
        viewport: report.viewport,
        takenAt: report.takenAt,
        ...(report.components !== undefined ? { components: report.components } : {}),
      });
      break;
    case "jumpDone":
      emit({ kind: "jumpDone", tab: page.tab });
      break;
    case "stroke":
      break; // stroke counts enrich the shot payload later (post-v1)
  }
}
