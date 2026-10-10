import {
  Choice,
  compilePrompt,
  type History,
  Paragraph,
  Prompt,
  prepareRequest,
  renderTurn,
} from "../index.ts";

export const current = (
  <Prompt>
    <Paragraph>Explain the newly measured spectrum.</Paragraph>
    <Choice name="background" short={<Paragraph>Use the previous model.</Paragraph>}>
      <Paragraph>
        Repeat the derivation of the Morse model before interpreting the new data.
      </Paragraph>
    </Choice>
  </Prompt>
);
export const history: History = {
  kind: "messages",
  messages: [
    { role: "user", parts: [{ type: "text", text: "Use a Morse potential with D_e = 4.500 eV." }] },
    { role: "assistant", parts: [{ type: "text", text: "I will keep that parameter fixed." }] },
  ],
};
export function example() {
  const fullTurn = renderTurn({ input: compilePrompt(current) });
  const selectedTurn = renderTurn({
    input: compilePrompt(current, { selection: { background: "omit" } }),
  });
  return {
    full: prepareRequest(fullTurn, { history }),
    selected: prepareRequest(selectedTurn, { history }),
    remote: prepareRequest(selectedTurn, {
      history: {
        kind: "remote",
        provider: "example-provider",
        reference: { kind: "conversation", id: "conversation-42" },
      },
    }),
    providerReplay: prepareRequest(selectedTurn, {
      history: {
        kind: "provider-items",
        protocol: "example-provider/replay-v1",
        items: [
          { type: "function_call", call_id: "call-1", name: "measure", arguments: "{}" },
          { type: "function_call_output", call_id: "call-1", output: "4.500 eV" },
        ],
      },
    }),
    note: "Only the current prompt is selected. Replay order and IDs remain unchanged; remote state stays opaque and its size unknown. A future provider adapter decides how this envelope becomes wire data.",
  };
}
