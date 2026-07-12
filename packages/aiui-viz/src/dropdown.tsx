/**
 * A refresh-aware dropdown button.
 *
 * The widget owns exactly ONE behavior — the popup lifecycle: the trigger
 * button toggles it, outside-pointerdown and Escape close it, and every OPEN
 * fires `onOpen` — the *refresh hook*. A list that must be current at the
 * moment it is looked at re-queries there (bump a tick a cell depends on,
 * kick an action, refetch — the widget knows nothing about what refreshing
 * means). Both the trigger content and the popup body are arbitrary JSX; the
 * body receives `close()` so item clicks can dismiss the popup themselves.
 *
 * Deliberately unstyled beyond geometry: the wrapper is `aiui-dropdown`, the
 * popup `aiui-dropdown-pop` (positioned under the trigger) — the HOST styles
 * surfaces, borders, and type; the trigger button takes `class` verbatim so
 * it can be the host's own chip/pill. Born in the aiui browser extension's
 * connection chip (channel list that rescans on open); extracted here because
 * "a dropdown that refreshes itself when asked" is a shape, not an app
 * feature.
 *
 * Solid 2.0 notes: no `onMount` (listeners attach in the component body,
 * removed via `onCleanup`); aria values are strings.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";

export function Dropdown(props: {
  /** Always-visible trigger content, rendered inside the toggle button. */
  trigger: JSX.Element;
  /** Fires on every OPEN — the refresh hook. */
  onOpen?: () => void;
  /** Popup body — arbitrary JSX; `close` dismisses the popup. */
  children: (close: () => void) => JSX.Element;
  /** Class for the trigger button (style it as the host's own chip/pill). */
  class?: string;
  /** Accessible name for the trigger button. */
  label?: string;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const close = (): void => {
    setOpen(false);
  };
  const toggle = (): void => {
    const next = !open();
    setOpen(next);
    if (next) {
      props.onOpen?.();
    }
  };

  // Outside-click and Escape, document-level while mounted (cheap: both
  // check `open()` first). Capture phase so a host that stops propagation
  // inside its own panes can't strand an open popup.
  const onDocPointer = (event: PointerEvent): void => {
    if (open() && root !== undefined && !event.composedPath().includes(root)) {
      close();
    }
  };
  const onDocKey = (event: KeyboardEvent): void => {
    if (open() && event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onDocKey, true);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onDocKey, true);
  });

  return (
    <div
      class="aiui-dropdown"
      ref={(el: HTMLDivElement) => {
        root = el;
      }}
      style="position: relative; display: inline-flex;"
    >
      <button
        type="button"
        class={props.class}
        aria-expanded={open() ? "true" : "false"}
        aria-haspopup="true"
        aria-label={props.label}
        onClick={toggle}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <div
          class="aiui-dropdown-pop"
          style="position: absolute; top: 100%; left: 0; z-index: 40; min-width: 100%; margin-top: 0.25rem;"
        >
          {props.children(close)}
        </div>
      </Show>
    </div>
  );
}
