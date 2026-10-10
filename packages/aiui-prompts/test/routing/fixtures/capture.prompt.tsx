/** @jsxImportSource @habemus-papadum/aiui-prompts */
// biome-ignore-all lint/complexity/noUselessFragments: This fixture tests shorthand fragment provenance.
import * as P from "@habemus-papadum/aiui-prompts";
import { Text as Leaf, type PromptValue } from "@habemus-papadum/aiui-prompts";

export function exercise() {
  const effects: string[] = [];
  // Non-BMP source before every captured range catches byte/UTF-16 confusion.
  const __aiuiPromptOrigin = "💫";
  const shared = <Leaf value="shared" />;
  const items: PromptValue[] = [
    <Leaf key="alpha" value="A" />,
    false,
    [<Leaf key="beta" value="B" />, null],
  ];
  const mark = (name: string, value: string) => {
    effects.push(name);
    return value;
  };
  const spread = (): { value: string; key?: string } => {
    effects.push("spread");
    return {
      get value() {
        effects.push("getter");
        return "spread text";
      },
      key: "from-spread",
    };
  };
  const Wrapper = (props: { children?: PromptValue }) => {
    effects.push(`props:${Object.keys(props).join(",")}`);
    return P.Group({ children: props.children ?? null });
  };
  const prompt = (
    <P.Prompt>
      <P.Text value={__aiuiPromptOrigin} />
      <Leaf {...spread()} key={mark("key-after", "after")} />
      <Leaf key={mark("key-before", "before")} {...spread()} />
      <Wrapper>
        {shared}
        <>{shared}</>
        {<>{shared}</>}
        {mark("insertion", "tail")}
      </Wrapper>
      <Wrapper children={shared} />
      <P.Join separator=", ">{items}</P.Join>
      <P.Elide unit="items" limit={1}>
        {items}
      </P.Elide>
    </P.Prompt>
  );
  const record = P.snapshot(prompt);
  return { record, compiled: P.compilePrompt(record), effects };
}
