import { compilePrompt, Paragraph, Prompt, prepareRequest, renderTurn, Text } from "../index.ts";

/** Python demo_01: interpolation, nesting, and ordinary application control flow. */
export function greeting(name: string, concise: boolean) {
  return (
    <Prompt label="greeting">
      <Paragraph>
        Hello, <Text value={name} source={{ label: "name argument", origin: "caller" }} />!
      </Paragraph>
      {concise ? <Paragraph>Keep your answer concise.</Paragraph> : null}
    </Prompt>
  );
}
export function example() {
  const authored = greeting("Ada", true);
  const compiled = compilePrompt(authored);
  const turn = renderTurn({ input: compiled });
  return { authored, compiled, turn, prepared: prepareRequest(turn) };
}
