/**
 * report.ts — the page→panel REPORT wire contract, shared by BOTH hosts. The
 * CDP bootstrap (cdp/page-script.ts) speaks it through the `__aiuiIntentReport`
 * binding; the MV3 content script (ext/content.ts) speaks the same union. It
 * lives under src/page/ — the tier-shared page-side home, next to driver-watch.ts
 * / pencil-mount.ts — so the extension tier no longer imports its protocol from
 * a cdp/ implementation file.
 *
 * Types + one binding-name const only. No runtime code the bootstrap would
 * stringify: cdp/page-script.ts re-exports these names, so the injected source
 * (and its fingerprint) is byte-identical to before the move.
 */
import type { PageTabRecord } from "@habemus-papadum/aiui-intent-runtime/instrumentation";

/** One page tool as it travels page→panel: the MCP-shaped subset of viz's
 * `AiuiPageTool` (no `run`). Structurally the channel's `PageToolDescriptor`,
 * which the tools-link test pins. */
export type PageToolDescriptorReport = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

/** What one instrumented document reports — the page→panel contract, shared by
 * BOTH hosts (the extension's content script speaks it too; see ext/protocol). */
export type PageReport =
  | { kind: "hello"; url: string; title: string; visible: boolean; focused: boolean; aiui: boolean }
  | { kind: "focus"; visible: boolean; focused: boolean }
  | { kind: "selection"; present: boolean }
  | { kind: "interaction" }
  | {
      kind: "navigation";
      from: string;
      to: string;
      navKind: "push" | "replace" | "traverse" | "hash";
      /** The DESTINATION's canonical tab record (`pageTabRecord`), when built. */
      tab?: PageTabRecord;
    }
  | { kind: "key"; key: string; phase: "down" | "up"; repeat: boolean }
  /** A completed region drag (the armed `a` gesture): rect + viewport in CSS
   * px, the pointerup wall-clock, and located components when the page is
   * aiui-instrumented (the evaluated bundle's locator). */
  | {
      kind: "region";
      rect: { x: number; y: number; w: number; h: number };
      viewport: { w: number; h: number };
      takenAt: number;
      components?: unknown[];
    }
  | { kind: "stroke"; points: number }
  /** A jump pick finished — committed (VS Code opens) or cancelled (Esc /
   * click-away). Auto-exits jump mode (owner, 2026-07-16). */
  | { kind: "jumpDone" }
  /** The page's `__AIUI__.tools` registry — full current set, descriptors only. */
  | {
      kind: "tools";
      registrations: Array<{ ns: string; tools: PageToolDescriptorReport[] }>;
    }
  /** A `toolsCall` capability's answer, correlated by callId. */
  | { kind: "toolsResult"; callId: string; ok: boolean; value?: unknown; error?: string };

/** The `Runtime.addBinding` name the CDP page reports through. */
export const PAGE_REPORT_BINDING = "__aiuiIntentReport";
