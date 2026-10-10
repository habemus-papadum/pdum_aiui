import { rehydrate } from "../../src/compile.ts";
import type { SemanticRecord } from "../../src/model.ts";
import {
  type AssetBindings,
  channelPush,
  lowerOperation,
  responseOperation,
  sessionOperation,
} from "../../src/operations.ts";

export type ExampleConsumer = "realtime" | "replace" | "append" | "channel" | "responses";

// A valid 1 × 1 RGBA PNG generated as a transport fixture, separate from the preview chart.
const realtimeImageFixture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";

/** Real lowering with explicit demonstration bindings. No transport exists in this bench. */
export function prepareExampleDelivery(record: SemanticRecord, consumer: ExampleConsumer) {
  const assets = Object.fromEntries(
    rehydrate(record).parts.flatMap((part) =>
      part.type === "image"
        ? [
            [
              part.asset.id,
              {
                kind: consumer === "channel" ? "path" : "url",
                value:
                  consumer === "channel"
                    ? `/tmp/prompt-assets/${encodeURIComponent(part.asset.id)}.png`
                    : consumer === "realtime"
                      ? realtimeImageFixture
                      : `https://example.invalid/assets/${encodeURIComponent(part.asset.id)}.png`,
              },
            ],
          ]
        : [],
    ),
  ) as AssetBindings;
  const operation =
    consumer === "channel"
      ? channelPush(record, { kind: "prompt-example" })
      : consumer === "responses"
        ? responseOperation({
            input: record,
            history: {
              kind: "remote",
              provider: "openai",
              reference: { kind: "previous-response", id: "resp_example" },
            },
          })
        : sessionOperation(record, {
            action:
              consumer === "replace"
                ? "replace-instructions"
                : consumer === "append"
                  ? "append-commentary"
                  : "input",
            sessionId: "session_example",
            eventId: "event_example",
          });
  const delivery = lowerOperation(
    operation,
    consumer === "channel"
      ? { kind: "claude-channel/1" }
      : consumer === "responses"
        ? { kind: "openai-responses/1", model: "configured-by-host" }
        : consumer === "append"
          ? { kind: "live-session/1" }
          : { kind: "openai-realtime/1" },
    assets,
  );
  return { operation, delivery };
}
