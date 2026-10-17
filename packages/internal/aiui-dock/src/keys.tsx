import {
  devVendorKey,
  type KeyStorage,
  onVendorKeysChange,
  pastedVendorKey,
  setPastedVendorKey,
} from "@habemus-papadum/aiui-viz/vendor-keys";
import { createSignal, For, onCleanup } from "solid-js";

const PROVIDERS = [
  { id: "openai", label: "OpenAI key", placeholder: "sk-…", use: "Oracle and live voice sessions" },
  {
    id: "motherduck",
    label: "MotherDuck token",
    placeholder: "Read-scaling token",
    use: "Cloud data demos",
  },
  { id: "elevenlabs", label: "ElevenLabs key", placeholder: "API key", use: "Speech demos" },
] as const;

export interface VendorKeyInputProps {
  provider: (typeof PROVIDERS)[number]["id"];
  storage?: KeyStorage;
}

/** The same field in the dock and a demo's onboarding; one slot per origin/provider. */
export function VendorKeyInput(props: VendorKeyInputProps) {
  const spec = PROVIDERS.find((p) => p.id === props.provider);
  if (spec === undefined) throw new Error(`Unknown key provider: ${props.provider}`);
  const [value, setValue] = createSignal(pastedVendorKey(props.provider, props.storage) ?? "");
  const [saved, setSaved] = createSignal(true);
  onCleanup(
    onVendorKeysChange(() => setValue(pastedVendorKey(props.provider, props.storage) ?? "")),
  );
  const save = (next: string) => {
    setValue(next);
    setSaved(setPastedVendorKey(props.provider, next, props.storage));
  };
  return (
    <div class="aiui-dock-keybox" data-aiui-chrome="">
      <label>
        <span>{spec.label}</span>
        <input
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder={spec.placeholder}
          value={value()}
          onInput={(event) => save(event.currentTarget.value)}
        />
      </label>
      <button type="button" disabled={value() === ""} onClick={() => save("")}>
        clear
      </button>
      <p class="aiui-dock-note" role="status">
        {!saved()
          ? "Could not save: browser storage is unavailable."
          : value().trim() !== ""
            ? "Saved in this browser."
            : devVendorKey(props.provider) !== undefined
              ? "Dev key available — no paste needed."
              : spec.use}
      </p>
    </div>
  );
}

export function VendorKeys() {
  return (
    <>
      <For each={PROVIDERS}>{(provider) => <VendorKeyInput provider={provider.id} />}</For>
      <p class="aiui-dock-note">
        Saved keys are shared across demos on this site and used to connect directly to their
        providers. Clear a field to forget it. Reconnect a running session to use a changed key.
      </p>
    </>
  );
}
