/**
 * Walkthrough.tsx — the Tier 3 stepper. Renders the active tour as a card pinned
 * over the reader: click ← / → (or the buttons) to move; each step reveals its
 * range in Monaco (via `showWalkthroughStep`), shows its prose, can read the
 * narration aloud (browser TTS standalone; the channel's speak seam later), and
 * shows an optional before/after diff.
 */
import { For, Show } from "solid-js";
import { showWalkthroughStep } from "../model/graph";
import { activeWalkthrough, walkthroughStep } from "../model/store";

export function WalkthroughPanel() {
  const w = () => activeWalkthrough.get();
  const i = () => walkthroughStep.get();
  const step = () => {
    const tour = w();
    return tour ? tour.steps[i()] : undefined;
  };

  const speak = (text: string) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      // no TTS available — silently skip
    }
  };

  return (
    <Show when={w()}>
      {(tour) => (
        <div class="walkthrough">
          <div class="walkthrough-head">
            <span class="walkthrough-title">{tour().title}</span>
            <button
              type="button"
              class="walkthrough-close"
              title="End tour"
              onClick={() => activeWalkthrough.set(undefined)}
            >
              ✕
            </button>
          </div>
          <Show when={step()}>
            {(s) => (
              <div class="walkthrough-body">
                <div class="walkthrough-meta">
                  step {i() + 1} / {tour().steps.length}
                  <span class="walkthrough-file">{s().file}</span>
                </div>
                <Show when={s().title}>
                  <div class="walkthrough-step-title">{s().title}</div>
                </Show>
                <p class="walkthrough-prose">{s().prose}</p>
                <Show when={s().diff}>
                  {(diff) => (
                    <div class="walkthrough-diff">
                      <For each={splitLines(diff().before)}>
                        {(l) => <div class="diff-del">- {l}</div>}
                      </For>
                      <For each={splitLines(diff().after)}>
                        {(l) => <div class="diff-add">+ {l}</div>}
                      </For>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <div class="walkthrough-nav">
            <button
              type="button"
              class="btn btn-outline"
              disabled={i() <= 0}
              onClick={() => showWalkthroughStep(tour(), i() - 1)}
            >
              ← Prev
            </button>
            <Show when={step()?.narration}>
              {(n) => (
                <button type="button" class="btn btn-outline" onClick={() => speak(n())}>
                  🔊 Narrate
                </button>
              )}
            </Show>
            <button
              type="button"
              class="btn"
              disabled={i() >= tour().steps.length - 1}
              onClick={() => showWalkthroughStep(tour(), i() + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}

const splitLines = (s: string): string[] => s.replace(/\n$/, "").split("\n");
