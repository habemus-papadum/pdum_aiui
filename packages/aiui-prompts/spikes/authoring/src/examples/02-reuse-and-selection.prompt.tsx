import { Choice, compilePrompt, Paragraph, Prompt, Section } from "../index.ts";

// One immutable definition appears at two depths. Each occurrence has its own parent and output ranges.
export const evidence = (
  <Section
    title="Evidence"
    source={{ label: "reusable evidence", file: "02-reuse-and-selection.prompt.tsx" }}
  >
    <Paragraph>The observed value is 4.500 eV.</Paragraph>
  </Section>
);
export const investigation = (
  <Prompt>
    {evidence}
    <Section title="Independent check">{evidence}</Section>
    <Choice name="background" short={<Paragraph>Use the Morse model.</Paragraph>}>
      <Section title="Background">
        <Paragraph>
          The Morse model captures anharmonic vibration and a dissociation limit.
        </Paragraph>
      </Section>
    </Choice>
  </Prompt>
);
export function example() {
  return {
    authored: investigation,
    full: compilePrompt(investigation),
    short: compilePrompt(investigation, { selection: { background: "short" } }),
    omitted: compilePrompt(investigation, { selection: { background: "omit" } }),
    note: "Authored alternatives, not an automatic optimizer. Choosing again never mutates the input.",
  };
}
