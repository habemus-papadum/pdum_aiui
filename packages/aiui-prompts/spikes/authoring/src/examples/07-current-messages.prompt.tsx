import { compilePrompt, Paragraph, prepareRequest, renderTurn } from "../index.ts";

export function example() {
  const turn = renderTurn({
    instructions: compilePrompt(<Paragraph>Preserve units and lexical precision.</Paragraph>),
    beforeInput: [
      { role: "user", prompt: compilePrompt(<Paragraph>Reference example: 4.500 eV.</Paragraph>) },
      {
        role: "assistant",
        prompt: compilePrompt(<Paragraph>Four significant digits; units are eV.</Paragraph>),
      },
    ],
    input: compilePrompt(<Paragraph>Now interpret 0.1180 eV.</Paragraph>),
  });
  return {
    turn,
    prepared: prepareRequest(turn),
    note: "These few-shot messages are authored for THIS invocation, not replayed history. Order is beforeInput → input → afterInput. Instructions are a separate current contribution, with no implied provider role or server persistence policy.",
  };
}
