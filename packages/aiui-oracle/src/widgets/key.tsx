/**
 * key.tsx — key management as its OWN widget, deliberately separate from the
 * control strip. Placement is the composition story: a standalone app renders
 * this in its own chrome; a composing shell (the gallery) renders ONE for the
 * whole document; the mounted page never does. The slot is origin-wide
 * localStorage, so wherever it renders, every oracle on the origin shares
 * what it writes.
 */

import { createSignal } from "solid-js";
import { PASTED_KEY_STORAGE_KEY } from "../keys";

export interface OracleKeyProps {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  placeholder?: string;
}

export function OracleKey(props: OracleKeyProps) {
  const storage = props.storage ?? localStorage;
  const [value, setValue] = createSignal(storage.getItem(PASTED_KEY_STORAGE_KEY) ?? "");

  const save = (next: string) => {
    setValue(next);
    const trimmed = next.trim();
    if (trimmed === "") {
      storage.removeItem(PASTED_KEY_STORAGE_KEY);
    } else {
      storage.setItem(PASTED_KEY_STORAGE_KEY, trimmed);
    }
  };

  return (
    <div class="aiui-oracle-keybox">
      <input
        class="aiui-oracle-key"
        type="password"
        placeholder={props.placeholder ?? "OpenAI key (sk-… or ek_…)"}
        value={value()}
        onInput={(event) => save(event.currentTarget.value)}
      />
      <button type="button" disabled={value() === ""} onClick={() => save("")}>
        clear
      </button>
      <span class="aiui-oracle-key-hint">
        {value() === ""
          ? "blank — the app's other key sources apply"
          : "your pasted key trumps every other source"}
      </span>
    </div>
  );
}
