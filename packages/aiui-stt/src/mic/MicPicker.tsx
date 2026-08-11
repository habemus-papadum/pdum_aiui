/**
 * MicPicker.tsx — the device-picker widget over {@link listMicrophones} +
 * {@link micAudioSource}: pick an input, get an {@link AudioSource} for it.
 *
 * Device labels are EMPTY until the page holds mic permission (the
 * platform's privacy rule), so the picker shows "Microphone N" fallbacks
 * and re-enumerates on `devicechange` — the first `getUserMedia` grant
 * (typically the first `beginSegment`) fires that event and the labels
 * fill in on their own.
 */

import { createSignal, For, onCleanup } from "solid-js";
import type { AudioSource } from "../types";
import { listMicrophones, type MicrophoneInfo, micAudioSource } from "./index";

export interface MicPickerProps {
  /** Receives a fresh source for the picked device (and once at mount for
   * the default device, unless `deferInitial`). */
  onSource(source: AudioSource, device: MicrophoneInfo | undefined): void;
  /** Skip the mount-time default-device callback. */
  deferInitial?: boolean;
  class?: string;
}

/** A `<select>` of audio inputs; each pick hands back a fresh mic source. */
export function MicPicker(props: MicPickerProps) {
  const [devices, setDevices] = createSignal<MicrophoneInfo[]>([]);

  const refresh = async (): Promise<void> => {
    setDevices(await listMicrophones());
  };

  // Solid 2.0 has no `onMount` — the component body runs once, so mount work
  // lives here and its teardown in `onCleanup` (the dropdown's pattern).
  void refresh();
  if (!props.deferInitial) {
    props.onSource(micAudioSource(), undefined);
  }
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (media?.addEventListener) {
    const onChange = (): void => void refresh();
    media.addEventListener("devicechange", onChange);
    onCleanup(() => media.removeEventListener("devicechange", onChange));
  }

  const pick = (deviceId: string): void => {
    const device = devices().find((d) => d.deviceId === deviceId);
    props.onSource(micAudioSource(deviceId === "" ? {} : { deviceId }), device);
  };

  return (
    <select
      class={props.class}
      aria-label="microphone"
      onChange={(event) => pick(event.currentTarget.value)}
    >
      <option value="">Default microphone</option>
      <For each={devices()}>
        {(device, index) => (
          <option value={device.deviceId}>
            {device.label !== "" ? device.label : `Microphone ${index() + 1}`}
          </option>
        )}
      </For>
    </select>
  );
}
