// @vitest-environment jsdom
/**
 * The CORPUS of the panel oracle's own prompt text, as readable files under
 * ../../corpus/ — a baseline for the prompt-toolkit migration, not a contract
 * (docs/proposals/structured-prompts-review.md). `vitest -u` updates; review the diff.
 */

import { join } from "node:path";
import { weaveInstructions } from "@habemus-papadum/aiui-oracle";
import { describe, expect, it } from "vitest";
import { PANEL_BLURB } from "./oracle";
import { oracleShotCaption } from "./oracle-contributions";
import { fileTools } from "./oracle-tools";

const corpus = (name: string): string => join(__dirname, "../..", "corpus", name);

describe("corpus: the panel oracle", () => {
  it("the panel recipe woven: blurb and tab record", async () => {
    await expect(
      weaveInstructions({
        app: PANEL_BLURB,
        context:
          '<tab url="http://localhost:5173/seismos" title="seismos — aiui demo app" aiui-app="true" chrome-tab-id="42"/>',
      }),
    ).toMatchFileSnapshot(corpus("panel-instructions.txt"));
  });

  it("a shot's caption with its metadata sidecar", async () => {
    await expect(
      oracleShotCaption({
        bytes: new Uint8Array(0),
        mime: "image/png",
        rect: { x: 10, y: 20, w: 300.4, h: 180.6 },
        area: true,
        components: [
          {
            component: "Legend",
            source: "src/Legend.tsx:30:2",
            rect: { x: 0, y: 0, w: 10, h: 10 },
          },
        ],
      }),
    ).toMatchFileSnapshot(corpus("shot-caption.txt"));
  });

  it("the file tools' descriptions", async () => {
    const docs = fileTools({ port: () => 1234 }).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    await expect(JSON.stringify(docs, null, 2)).toMatchFileSnapshot(corpus("file-tools.json"));
  });
});
