import {
  compilePrompt,
  Image,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: Math is the prompt JSX component.
  Math,
  Paragraph,
  Prompt,
  Section,
  Text,
  tex,
  Xml,
} from "../index.ts";

export const equation = tex`\begin{aligned}
V(r) &= D_e \left(1 - e^{-a(r-r_e)}\right)^2 \\
\hat{H}\,\psi(r) &= E\,\psi(r)
\end{aligned}`;

// Acquisition is a host concern: prepared values enter synchronous prompt composition.
async function prepareExperiment() {
  return { dissociationEnergy: "4.500", width: "1.900", equilibriumDistance: "0.740" };
}
export async function sciencePrompt() {
  const values = await prepareExperiment();
  return (
    <Prompt label="morse-experiment">
      <Section title="Morse potential">
        <Paragraph>
          Preserve the measured precision: D_e = {values.dissociationEnergy} eV, a = {values.width}{" "}
          Å⁻¹, r_e = {values.equilibriumDistance} Å.
        </Paragraph>
        <Math
          value={equation}
          source={{ label: "Morse and Schrödinger equations", origin: "authored theory" }}
        />
        <Xml tag="measurement" attributes={{ unit: "eV", note: 'precision & "units"' }}>
          <Text
            value={values.dissociationEnergy}
            source={{ label: "dissociation energy", origin: "experiment/run-42" }}
          />
          <Xml tag="condition">A &amp; B &lt; C</Xml>
        </Xml>
        <Paragraph>Inspect the illustrative potential curve:</Paragraph>
        <Image
          asset={{
            id: "morse-curve",
            revision: "fixture-v1",
            uri: "fixture:morse-curve",
            mimeType: "image/svg+xml",
            alt: "Illustrative Morse potential curve; no numerical result is implied.",
            width: 360,
            height: 160,
          }}
        />
        <Paragraph>
          Explain the dissociation limit and compare it with the measured energy.
        </Paragraph>
      </Section>
    </Prompt>
  );
}
export async function example() {
  const authored = await sciencePrompt();
  return {
    authored,
    compiled: compilePrompt(authored),
    note: "The asset descriptor is never fetched. SVG is an inspection fixture, not claimed provider support.",
  };
}
