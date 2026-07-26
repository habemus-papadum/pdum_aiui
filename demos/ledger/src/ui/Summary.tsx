/**
 * Summary.tsx — the strip at the top: what this corpus is, and the one number
 * that reframes everything else.
 *
 * The token-class split is deliberately the largest thing on the page. Cache
 * reads are ~63% of spend and fresh input ~0.1%, which means "using Claude Code
 * efficiently" is a context-management problem far more than a prompting one.
 * A dashboard that led with total dollars would bury that.
 *
 * Every dollar carries its provenance: there is no cost field in a Claude Code
 * transcript, so the pricing-table version is shown, not hidden.
 */

import { Show } from "solid-js";
import { store } from "../model/store";

const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "—");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One class of token spend, sized by its share. */
function ClassBar(props: { label: string; cost: number; total: number; tone: string }) {
  return (
    <div class="lg-class">
      <div class="lg-class-head">
        <span class="lg-class-label">{props.label}</span>
        <span class="lg-class-share">{pct(props.cost, props.total)}</span>
      </div>
      <div class="lg-class-track">
        <div
          class="lg-class-fill"
          style={{
            width: `${props.total > 0 ? (props.cost / props.total) * 100 : 0}%`,
            background: props.tone,
          }}
        />
      </div>
      <div class="lg-class-cost">{usd(props.cost)}</div>
    </div>
  );
}

export function Summary() {
  const s = () => store.summary();
  const m = () => store.manifest();

  return (
    <Show when={s()}>
      {(sum) => (
        <section class="lg-summary">
          <div class="lg-stats">
            <div class="lg-stat">
              <div class="lg-stat-value">{usd(sum().totalCost)}</div>
              <div class="lg-stat-label">derived spend</div>
            </div>
            <div class="lg-stat">
              <div class="lg-stat-value">{sum().turns.toLocaleString()}</div>
              <div class="lg-stat-label">turns</div>
            </div>
            <div class="lg-stat">
              <div class="lg-stat-value">{sum().sessions.toLocaleString()}</div>
              <div class="lg-stat-label">sessions</div>
            </div>
            <div class="lg-stat">
              <div class="lg-stat-value">{sum().projects}</div>
              <div class="lg-stat-label">projects</div>
            </div>
            <div class="lg-stat lg-stat-wide">
              <div class="lg-stat-value">
                {day(sum().firstTs)} → {day(sum().lastTs)}
              </div>
              <div class="lg-stat-label">window</div>
            </div>
          </div>

          <div class="lg-classes">
            <h2 class="lg-h2">where the money actually goes</h2>
            <ClassBar
              label="cache read"
              cost={sum().costCacheRead}
              total={sum().totalCost}
              tone="var(--lg-cache-read)"
            />
            <ClassBar
              label="cache creation"
              cost={sum().costCacheCreate}
              total={sum().totalCost}
              tone="var(--lg-cache-create)"
            />
            <ClassBar
              label="output"
              cost={sum().costOutput}
              total={sum().totalCost}
              tone="var(--lg-output)"
            />
            <ClassBar
              label="fresh input"
              cost={sum().costInput}
              total={sum().totalCost}
              tone="var(--lg-input)"
            />
            <p class="lg-note">
              Cache read + creation is{" "}
              <strong>{pct(sum().costCacheRead + sum().costCacheCreate, sum().totalCost)}</strong>{" "}
              of spend. Most of what you pay for is re-sending context, not generating tokens.
            </p>
          </div>

          <Show when={m()}>
            {(man) => (
              <p class="lg-provenance">
                No cost field exists in a Claude Code transcript — every figure here is tokens ×{" "}
                <code>{man().pricing.source}</code> @ {man().pricing.version.slice(0, 10)}, derived
                from {man().stats.files} files. A naive per-record sum would have reported{" "}
                {(
                  man().stats.naiveOutputTokens / Math.max(1, man().stats.dedupedOutputTokens)
                ).toFixed(2)}
                × these output tokens.
                <Show when={!man().invariants.ok}>
                  {" "}
                  <strong class="lg-warn">
                    Invariants FAILED — treat these numbers as suspect.
                  </strong>
                </Show>
              </p>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
}
