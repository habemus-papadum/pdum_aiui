/**
 * content-main.ts — the extension's foothold in the page's OWN world, because
 * that is the only place `window.__AIUI__` exists.
 *
 * A content script runs in an isolated world: it shares the DOM but not the
 * JavaScript realm, so the page's globals are invisible to it. Three jobs live
 * here, all relayed to `content.ts` over `postMessage`:
 *
 *  1. **The instrumented-page fact** — `__AIUI__` exists → shout it (the
 *     `aiui` pill, `locate`, jump-to-editor's arm gate).
 *  2. **The tools bridge's page half** (T2 of the plugin restructure): watch
 *     `__AIUI__.tools.onChange`, relay DESCRIPTORS ONLY (never functions);
 *     execute `toolsCall`s against the registry and relay the result by
 *     callId. The registry installs whenever the app's agentToolkit first
 *     runs — possibly after us — so a light poll subscribes once it appears,
 *     then stops.
 *  3. **Jump-to-editor** (jump-mode.ts): the picker reads
 *     `__AIUI__.sourceRoot` and `__aiuiCells` — main-world globals — so the
 *     mode arms HERE, on an `aiuiJump` message from the isolated world.
 *
 * Code in the page's realm can be seen — and broken — by the page, so
 * everything here is defensive and small.
 */

import type { AiuiToolsRegistry } from "@habemus-papadum/aiui-viz";
import { armJump, disarmJump } from "../page/jump-mode";

const registry = (): AiuiToolsRegistry | undefined =>
  (window as unknown as { __AIUI__?: { tools?: AiuiToolsRegistry } }).__AIUI__?.tools;

if ((window as unknown as { __AIUI__?: unknown }).__AIUI__ !== undefined) {
  window.postMessage({ aiuiInstrumented: true }, "*");
}

const reportTools = (): void => {
  const r = registry();
  if (r?.list === undefined) {
    return;
  }
  try {
    window.postMessage(
      {
        aiuiTools: r.list().map((entry) => ({
          ns: entry.ns,
          tools: entry.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
          })),
        })),
      },
      "*",
    );
  } catch {
    // never break the host page
  }
};

let watched = false;
const watch = (): void => {
  const r = registry();
  if (watched || r?.onChange === undefined) {
    return;
  }
  watched = true;
  r.onChange(reportTools);
  reportTools();
};
watch();
const poll = setInterval(() => {
  watch();
  if (watched) {
    clearInterval(poll);
  }
}, 2000);

// toolsCall requests arrive from the ISOLATED world (content.ts); results go
// back the same way, correlated by callId.
window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const jump = (event.data as { aiuiJump?: { arm?: boolean } })?.aiuiJump;
  if (jump !== undefined) {
    if (jump.arm === true) {
      // onExit relays the pick's completion back to the isolated world (which
      // reports `jumpDone`) so the panel auto-exits jump mode (owner, 2026-07-16).
      armJump(undefined, () => window.postMessage({ aiuiJumpDone: true }, "*"));
    } else {
      disarmJump();
    }
    return;
  }
  const call = (
    event.data as { aiuiToolsCall?: { ns: string; name: string; args?: unknown; callId: string } }
  )?.aiuiToolsCall;
  if (call === undefined) {
    return;
  }
  const r = registry();
  const respond = (result: { ok: boolean; value?: unknown; error?: string }): void => {
    window.postMessage({ aiuiToolsResult: { callId: call.callId, ...result } }, "*");
  };
  if (r?.call === undefined) {
    respond({ ok: false, error: "no tools registry" });
    return;
  }
  void Promise.resolve()
    .then(() => r.call(call.ns, call.name, call.args))
    .then(
      (value) => respond({ ok: true, value }),
      (err: unknown) =>
        respond({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
});
