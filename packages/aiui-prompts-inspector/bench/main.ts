import "@habemus-papadum/aiui-design/tokens.css";
import "@habemus-papadum/aiui-design/fonts.css";
import "katex/dist/katex.min.css";
import "../src/style.css";
import "../src/themes/aiui.css";
import "../src/themes/terminal.css";
import "./style.css";
import type { SemanticRecord } from "@habemus-papadum/aiui-prompts";
import { snapshot } from "@habemus-papadum/aiui-prompts";
import {
  type InspectionLoadOptions,
  type MountedInspector,
  mountComparison,
  mountInspector,
  mountPreview,
} from "../src/index.ts";
import { type ExampleConsumer, prepareExampleDelivery } from "./delivery.ts";
import {
  delegationRecord,
  exampleRecord,
  markerSidecarRecord,
  textOnlyPrompt,
} from "./fixtures.ts";
import { bindBenchTheme } from "./theme.ts";

const host = document.querySelector<HTMLDivElement>("#inspector");
const reason = document.querySelector<HTMLSelectElement>("#reason");
const input = document.querySelector<HTMLTextAreaElement>("#record-input");
const download = document.querySelector<HTMLButtonElement>("#download");
const consumer = document.querySelector<HTMLSelectElement>("#consumer");
const deliveryHost = document.querySelector<HTMLDivElement>("#delivery");
const theme = document.querySelector<HTMLSelectElement>("#inspector-theme");
const compactHost = document.querySelector<HTMLDivElement>("#compact-preview");
const themedArea = document.querySelector<HTMLDivElement>("#inspection-area");
const operationInput = document.querySelector<HTMLTextAreaElement>("#operation-input");
if (
  !host ||
  !reason ||
  !input ||
  !download ||
  !consumer ||
  !deliveryHost ||
  !theme ||
  !compactHost ||
  !themedArea
)
  throw new Error("Missing workbench elements");
const disposeTheme = bindBenchTheme(theme, themedArea);

// A generated local PNG is only a preview resolver; its bytes never enter the semantic record.
const canvas = document.createElement("canvas");
canvas.width = 520;
canvas.height = 260;
const ctx = canvas.getContext("2d");
if (ctx) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 520, 260);
  ctx.strokeStyle = "#30343b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, 20);
  ctx.lineTo(40, 220);
  ctx.lineTo(500, 220);
  ctx.stroke();
  ctx.strokeStyle = "#24779a";
  ctx.beginPath();
  for (let x = 40; x <= 490; x += 1) {
    const y = 200 - 130 * Math.exp(-((x - 260) ** 2) / 10000);
    if (x === 40) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#30343b";
  ctx.font = "14px monospace";
  ctx.fillText("Synthetic preview asset", 190, 245);
}
const previewUrl = ctx ? canvas.toDataURL("image/png") : undefined;
const options = { resolveAsset: () => previewUrl };
let record: SemanticRecord | null = exampleRecord();
let inspector: MountedInspector | null = mountInspector(host, record, options);
let mounted: { dispose: () => void } = inspector;
const compact = mountPreview(compactHost, record, options);

function delivery() {
  deliveryHost?.replaceChildren();
  if (!record || !consumer) return;
  try {
    const result = prepareExampleDelivery(record, consumer.value as ExampleConsumer);
    for (const [name, value] of Object.entries(result)) {
      const details = document.createElement("details");
      details.open = name === "delivery";
      const summary = document.createElement("summary");
      summary.textContent =
        name === "delivery" ? "Derived delivery and output mappings" : "Semantic operation record";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(value, null, 2);
      details.append(summary, pre);
      deliveryHost?.append(details);
    }
  } catch (error) {
    const failure = document.createElement("p");
    failure.setAttribute("role", "alert");
    failure.textContent = String(error);
    deliveryHost?.append(failure);
  }
}

function show(inputRecord: unknown, loadOptions: InspectionLoadOptions = {}) {
  if (!inspector) {
    mounted.dispose();
    inspector = mountInspector(host as HTMLDivElement, record, options);
    mounted = inspector;
  }
  inspector.load(inputRecord, loadOptions);
  compact.load(inputRecord, loadOptions);
  record = inspector.controller.record;
  if (download) download.disabled = record === null;
  delivery();
}

document.querySelector("#new-record")?.addEventListener("click", () => {
  record = exampleRecord(reason.value as "start" | "reconnect" | "refresh");
  input.value = JSON.stringify(record, null, 2);
  show(record);
});
document.querySelector("#compare")?.addEventListener("click", () => {
  mounted.dispose();
  inspector = null;
  record = exampleRecord("refresh");
  input.value = JSON.stringify(record, null, 2);
  download.disabled = false;
  mounted = mountComparison(host, exampleRecord("start"), record, options);
  compact.load(record);
  delivery();
});
document.querySelector("#text-example")?.addEventListener("click", () => {
  record = snapshot(textOnlyPrompt);
  input.value = JSON.stringify(record, null, 2);
  show(record);
});
document.querySelector("#delegation-example")?.addEventListener("click", () => {
  record = delegationRecord();
  input.value = JSON.stringify(record, null, 2);
  consumer.value = "responses";
  show(record);
});
document.querySelector("#marker-example")?.addEventListener("click", () => {
  record = markerSidecarRecord();
  input.value = JSON.stringify(record, null, 2);
  consumer.value = "channel";
  show(record);
});
consumer.addEventListener("change", delivery);
document
  .querySelector("#load")
  ?.addEventListener("click", () =>
    show(input.value, operationInput?.value.trim() ? { operation: operationInput.value } : {}),
  );
document.querySelector("#inspect-operation")?.addEventListener("click", () => {
  if (!record) return;
  try {
    const result = prepareExampleDelivery(record, consumer.value as ExampleConsumer);
    input.value = JSON.stringify(result.operation, null, 2);
    show(result.operation);
  } catch (error) {
    deliveryHost.textContent = String(error);
  }
});
document.querySelector("#inspect-delivery")?.addEventListener("click", () => {
  if (!record) return;
  try {
    const result = prepareExampleDelivery(record, consumer.value as ExampleConsumer);
    input.value = JSON.stringify(result.delivery, null, 2);
    if (operationInput) operationInput.value = JSON.stringify(result.operation, null, 2);
    show(result.delivery, { operation: result.operation });
  } catch (error) {
    deliveryHost.textContent = String(error);
  }
});
document.querySelector("#download")?.addEventListener("click", () => {
  if (!record) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(record)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "semantic-prompt.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
input.value = JSON.stringify(record, null, 2);
delivery();

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    disposeTheme();
    mounted.dispose();
    compact.dispose();
  });
