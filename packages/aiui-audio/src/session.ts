import type { AudioOutput, StreamInput } from "./types";

const owners = new WeakMap<object, object>();
/** Each connection borrows the endpoints. A late close cannot disable its replacement. */
export function claimSessionAudio(input: StreamInput, output: AudioOutput) {
  const owner = {};
  owners.set(input, owner);
  owners.set(output, owner);
  input.setEnabled(false);
  output.detach();
  const currentInput = () => owners.get(input) === owner;
  const currentOutput = () => owners.get(output) === owner;
  return {
    input: {
      ...input,
      setEnabled(on: boolean) {
        if (currentInput()) input.setEnabled(on);
      },
    },
    output: {
      ...output,
      attach(stream: MediaStream, element?: HTMLAudioElement) {
        if (currentOutput()) output.attach(stream, element);
      },
    },
    release() {
      if (currentInput()) {
        input.setEnabled(false);
        owners.delete(input);
      }
      if (currentOutput()) {
        output.detach();
        owners.delete(output);
      }
    },
  };
}
