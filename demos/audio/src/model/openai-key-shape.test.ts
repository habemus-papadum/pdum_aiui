/**
 * openai-key-shape.test.ts — aiui-cf-creds' `OpenAIKeySource` is the oracle's
 * `KeySource` by SHAPE: cf-creds is public and depends on nothing of the oracle
 * (internal scaffolding), so the two declarations are pinned equal here, in
 * the one package that already has both. A drift on either side fails this
 * demo's `pnpm typecheck`; the runtime test is a no-op.
 */
import type { OpenAICredential, OpenAIKeySource } from "@habemus-papadum/aiui-cf-creds/openai";
import type { KeySource, OracleCredential } from "@habemus-papadum/aiui-oracle";
import { describe, expectTypeOf, it } from "vitest";

describe("aiui-cf-creds/openai against the oracle's key seam", () => {
  it("the federated key source is a KeySource, and a KeySource is one of ours", () => {
    expectTypeOf<OpenAIKeySource>().toExtend<KeySource>();
    expectTypeOf<KeySource>().toExtend<OpenAIKeySource>();
    expectTypeOf<OpenAICredential>().toExtend<OracleCredential>();
    expectTypeOf<OracleCredential>().toExtend<OpenAICredential>();
  });
});
