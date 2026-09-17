/**
 * key.tsx — the paste-key box, sharing the oracle's localStorage slot so one
 * paste serves every voice front on the origin. Standalone chrome: a
 * composing shell renders one for the whole document.
 */

import { createSignal } from "solid-js";
import { PASTED_KEY_STORAGE_KEY } from "../brokers";

export interface LiveKeyProps {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  placeholder?: string;
}

export function LiveKey(props: LiveKeyProps) {
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
    <div class="aiui-live-keybox">
      <input
        class="aiui-live-key"
        type="password"
        placeholder={
          props.placeholder ?? "OpenAI project key (sk-…) — optional; the dev server has one"
        }
        value={value()}
        onInput={(event) => save(event.currentTarget.value)}
      />
      <button type="button" disabled={value() === ""} onClick={() => save("")}>
        clear
      </button>
      <span class="aiui-live-key-hint">
        {value() === ""
          ? "blank — dev key / server broker apply"
          : "your pasted key goes straight to the vendor"}
      </span>
    </div>
  );
}
