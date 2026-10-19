import { createMemo, For, Show } from "solid-js";
import type { TargetedDiagnostic } from "../semantic/diagnostics";

/** The domain supplies findings and resolves references; this view knows no document schema. */
export function TargetedDiagnostics(props: {
  items: TargetedDiagnostic[];
  label: (ref: string) => string;
  select: (ref: string) => void;
  class?: string;
}) {
  return (
    <Show when={props.items.length > 0}>
      <div class={`svg-targeted-diagnostics ${props.class ?? ""}`}>
        <For each={props.items.map((item) => item.id)}>
          {(id) => {
            const item = createMemo(() => {
              const value = props.items.find((item) => item.id === id);
              if (!value) throw new Error("Diagnostic no longer exists.");
              return value;
            });
            return (
              <div class="svg-targeted-diagnostic" data-diagnostic={id}>
                <strong>{item().title}.</strong> {item().detail}
                <div class="svg-targeted-refs">
                  <For each={item().refs}>
                    {(ref) => (
                      <button
                        class="svg-targeted-ref"
                        type="button"
                        data-ref={ref}
                        onClick={() => props.select(ref)}
                      >
                        {props.label(ref)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
