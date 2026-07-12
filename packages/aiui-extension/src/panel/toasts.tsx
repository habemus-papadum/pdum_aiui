/**
 * The panel's toast column — the TEXTUAL feedback channel of the 2026-07-12
 * advisory redesign. Two rules:
 *
 *  - toasts are for a user act that indicates a MISUNDERSTANDING or a real
 *    failure that blocks one (the canonical case: a shot on a tab the
 *    invocation gate hasn't blessed). Used sparingly — routine narration
 *    goes to the console (log.ts) at the panel's logLevel; inline advisory
 *    text in panes is retired outright (teaching the system is a future,
 *    separate concern);
 *  - dismissible and deduped (repeats bump a ×N counter, the overlay's toast
 *    convention) — a repeated mistake must not stack unboundedly.
 */
import { createSignal, For } from "solid-js";

export interface ToastEntry {
  id: number;
  text: string;
  count: number;
}

const [toasts, setToasts] = createSignal<ToastEntry[]>([]);
let seq = 0;

/** Surface one misuse/failure message (deduped by exact text). */
export function toast(text: string): void {
  setToasts((list) => {
    if (list.some((t) => t.text === text)) {
      return list.map((t) => (t.text === text ? { ...t, count: t.count + 1 } : t));
    }
    seq += 1;
    return [...list, { id: seq, text, count: 1 }];
  });
}

export function dismissToast(id: number): void {
  setToasts((list) => list.filter((t) => t.id !== id));
}

/**
 * The column — a FIXED overlay at the panel's bottom-right (a real popup:
 * never reflows the panel; the side panel is an ordinary document, so fixed
 * positioning works, clipped to the panel's own viewport). Each toast is a
 * card: translucent light header (label + ×N + dismiss) over the message.
 */
export function Toasts() {
  return (
    <div class="toasts">
      <For each={toasts()}>
        {(t) => (
          <div class="toast">
            <div class="toast-head">
              <span>aiui</span>
              {t.count > 1 ? <span class="toast-count">×{t.count}</span> : null}
              <button type="button" class="toast-x" onClick={() => dismissToast(t.id)}>
                ✕
              </button>
            </div>
            <div class="toast-body">{t.text}</div>
          </div>
        )}
      </For>
    </div>
  );
}
