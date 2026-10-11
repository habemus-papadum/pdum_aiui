import type { DemoCard } from "@habemus-papadum/aiui-viz";
export const card: DemoCard = {
  blurb: "One microphone, shared routing, live dictation and spoken edits.",
  Preview: () => (
    <div
      class="demo-card-placeholder"
      style={{ display: "grid", gap: "1rem", "text-align": "center" }}
    >
      <span>🎙 ▂▄▆▃</span>
      <span>✍ Dictation → 🔮 Editing</span>
    </div>
  ),
};
