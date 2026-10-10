/** @jsxImportSource @habemus-papadum/aiui-prompts */
import {
  Case,
  compilePrompt,
  Image,
  Join,
  type Predicate,
  Prompt,
  type PromptValue,
  type SemanticRecord,
  snapshot,
  Text,
} from "@habemus-papadum/aiui-prompts";
import { measurePrompt } from "@habemus-papadum/aiui-prompts/analysis";

const condition = {
  op: "all",
  predicates: [{ op: "eq", path: "ready", value: true }],
} as const satisfies Predicate;
const fragments = [
  <Text value="A" />,
  <Text value="B" />,
] as const satisfies readonly PromptValue[];
const branches = [{ when: condition, value: <Join separator=", ">{fragments}</Join> }] as const;
const asset = {
  id: "figure",
  mimeType: "image/png",
  metadata: { labels: ["axis", "units"] },
} as const;

export const record = snapshot(
  <Prompt>
    <Case name="availability" branches={branches} fallback="Waiting" />
    <Image asset={asset} />
  </Prompt>,
  { context: { ready: true } },
);
export const measurement = measurePrompt(compilePrompt(record));

// These checks deliberately run against emitted declarations in an isolated
// consumer. An unused @ts-expect-error fails the smoke test if readonly regresses.
export function readonlyContract(value: SemanticRecord) {
  // @ts-expect-error stored definitions are immutable
  value.definitions.push(value.definitions[0]);
  // @ts-expect-error captured context cannot be edited in place
  value.context.ready = false;
  // @ts-expect-error schema version cannot be edited in place
  value.schemaVersion = 1;
}
