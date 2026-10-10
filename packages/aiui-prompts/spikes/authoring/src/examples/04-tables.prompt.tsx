import { compilePrompt, Join, Prompt, Section, Text } from "../index.ts";

// Python demo_04, rebuilt with ordinary TS functions and arrays. No special loop DSL.
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
const row = (values: readonly string[]) => `| ${values.map(cell).join(" | ")} |`;
export function tablePrompt() {
  const regionalRows = [
    ["Region A", "45", "18"],
    ["Region B", "38", "22"],
  ];
  return (
    <Prompt>
      <Section title="Table fixtures">
        <Section title="Dynamic cell">
          <Join separator={"\n"}>
            {row(["Metric", "Value"])}
            {"| --- | --- |"}
            {row(["Static", "100"])}
            {/* biome-ignore lint/complexity/noUselessFragments: Join separates rows; the fragment keeps one row together. */}
            <>
              <Text value="| Dynamic | " />
              <Text value="42" source={{ label: "dynamic cell", origin: "run-42" }} />
              <Text value=" |" />
            </>
          </Join>
        </Section>
        <Section title="Multiple dynamic rows">
          <Join separator={"\n"}>
            {row(["Segment", "Trials", "Conversions"])}
            {"| --- | --- | --- |"}
            {row(["Organic", "52", "21"])}
            {regionalRows.map((values) => (
              <Text
                key={values[0]}
                value={row(values)}
                source={{ label: values[0], origin: "regional-summary" }}
              />
            ))}
            {row(["Paid", "61", "28"])}
          </Join>
        </Section>
      </Section>
    </Prompt>
  );
}
export function example() {
  const authored = tablePrompt();
  return {
    authored,
    compiled: compilePrompt(authored),
    note: "The preview must parse the whole assembled table. Dynamic-cell attribution survives text coalescing; table semantic types are future work.",
  };
}
