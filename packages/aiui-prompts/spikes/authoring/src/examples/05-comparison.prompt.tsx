import { compilePrompt, Image, Paragraph, Prompt, Section } from "../index.ts";

function revision(revised: boolean) {
  return (
    <Prompt>
      <Section title="Analysis" source={{ label: "analysis instruction" }}>
        <Paragraph>
          {revised
            ? "Report energy in eV and preserve all four significant digits."
            : "Report the energy."}
        </Paragraph>
        <Image
          asset={{
            id: "measurement-plot",
            revision: revised ? "pixels-b" : "pixels-a",
            uri: "fixture:measurement-plot",
            mimeType: "image/png",
            alt: "Measurement plot",
            width: 320,
            height: 200,
          }}
        />
      </Section>
    </Prompt>
  );
}
export function example() {
  const before = compilePrompt(revision(false));
  const after = compilePrompt(revision(true));
  return {
    before,
    after,
    expectedComparison: {
      text: "The instruction changed; its source label stayed the same.",
      image: "Asset revision changed despite equal dimensions, alt text, and URI.",
      implementation:
        "No diff algorithm in this spike. Both complete inputs are available to the independent UI fixture.",
    },
  };
}
