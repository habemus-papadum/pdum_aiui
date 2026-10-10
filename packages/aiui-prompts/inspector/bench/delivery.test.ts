import { describe, expect, it } from "vitest";
import { snapshot } from "../../src/record.ts";
import { prepareExampleDelivery } from "./delivery.ts";
import { exampleRecord, textOnlyPrompt } from "./fixtures.ts";

describe("workbench delivery examples", () => {
  it("prepares three consumers from the same stored multimodal record", () => {
    const record = exampleRecord();
    const session = prepareExampleDelivery(record, "realtime");
    const channel = prepareExampleDelivery(record, "channel");
    const response = prepareExampleDelivery(record, "responses");
    expect(session.operation.operation.kind).toBe("session");
    expect(channel.operation.operation.kind).toBe("channel");
    expect(response.operation.operation.kind).toBe("response");
    for (const result of [session, channel, response]) {
      expect(Object.keys(result.operation.records)).toEqual([record.fingerprint]);
      expect(result.delivery.status).toBe("prepared-not-sent");
    }
    expect(JSON.stringify(channel.delivery.payload)).toContain("located at /tmp/prompt-assets/");
    expect(JSON.stringify(session.delivery.payload)).toContain("data:image/png;base64,iVBORw0KGgo");
    expect(JSON.stringify(session.delivery.payload)).not.toContain("https://example.invalid");
    expect(JSON.stringify(record)).not.toContain("base64");
    expect(JSON.stringify(response.delivery.payload)).toContain('"input_image"');
    expect(JSON.stringify(response.delivery.payload)).toContain("https://example.invalid/assets/");
    expect(JSON.stringify(response.delivery.payload)).toContain("resp_example");
    expect(channel.delivery.decisions.some((decision) => decision.kind === "asset-reference")).toBe(
      true,
    );
  });

  it("requires text for instruction replacement and live appends", () => {
    const record = snapshot(textOnlyPrompt);
    expect(prepareExampleDelivery(record, "replace").delivery.payload).toMatchObject({
      type: "session.update",
    });
    expect(prepareExampleDelivery(record, "append").delivery.payload).toMatchObject({
      type: "session.commentary.append",
    });
    expect(() => prepareExampleDelivery(exampleRecord(), "replace")).toThrow(/requires text/);
  });
});
