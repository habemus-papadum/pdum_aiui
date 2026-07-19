/**
 * Sparkline.tsx — the score history (playbook layer 3). A tiny line chart of
 * the last {@link HISTORY_LEN} turns' scores, sitting under the panel head next
 * to the current score. Pure reader of `scoreHistory`; the newest point is
 * dotted in its own score colour so the current turn stands out.
 */

import type { JSX } from "@solidjs/web";
import { Show } from "@solidjs/web";
import { HISTORY_LEN, scoreHistory } from "../model/store";
import { scoreColor } from "./format";

const W = 232;
const H = 38;
const PAD = 4;

export function Sparkline(): JSX.Element {
  const scores = () => scoreHistory.get();
  const best = () => (scores().length ? Math.max(...scores()) : 0);

  const geometry = () => {
    const s = scores();
    const n = s.length;
    const x = (i: number) => (n <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1));
    const y = (v: number) => H - PAD - (Math.max(0, Math.min(100, v)) / 100) * (H - 2 * PAD);
    const pts = s.map((v, i) => [x(i), y(v)] as const);
    const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    const area = pts.length
      ? `${PAD},${H - PAD} ${line} ${pts[pts.length - 1][0].toFixed(1)},${H - PAD}`
      : "";
    const last = pts[pts.length - 1];
    return { line, area, last };
  };

  return (
    <Show
      when={scores().length >= 1}
      fallback={<div class="spark-empty">No turns yet — draw to start the streak.</div>}
    >
      <div class="spark">
        <div class="spark-caption">
          <span>
            Last {Math.min(scores().length, HISTORY_LEN)} turn
            {scores().length === 1 ? "" : "s"}
          </span>
          <span>
            best{" "}
            <b class="spark-best" style={{ color: scoreColor(best()) }}>
              {best()}
            </b>
          </span>
        </div>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img">
          <title>Score history sparkline</title>
          <polygon points={geometry().area} fill="rgba(138,180,248,0.10)" />
          <polyline
            points={geometry().line}
            fill="none"
            stroke="rgba(138,180,248,0.7)"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <Show when={geometry().last}>
            {(pt) => (
              <circle
                cx={pt()[0]}
                cy={pt()[1]}
                r="2.8"
                fill={scoreColor(scores()[scores().length - 1])}
              />
            )}
          </Show>
        </svg>
      </div>
    </Show>
  );
}
