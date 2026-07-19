/**
 * config-effects.ts — the three bind-time reactive roots that push live config
 * changes outward: the pencil live-fade re-relay, the in-place stt/linter
 * re-apply onto engine.settings, and the mid-thread linter control chunk. Each
 * keeps Solid 2.0's TWO-ARG (compute, effect) shape — the one-arg form
 * typechecks but throws MISSING_EFFECT_FN at render (a known repo footgun) —
 * and its own createRoot so the returned dispose tears down exactly what bind
 * created.
 */

import type { LinterVendor, OracleVendor } from "@habemus-papadum/aiui-lowering-pipeline";
import { createEffect, createRoot } from "solid-js";
import type { IntentClient } from "../client";
import { linter, oracle, pencilFade, pencilVanish, stt } from "../config";
import { panelIntentConfig } from "./turn-config";
import type { LaneContext } from "./types";

export function createConfigEffects(ctx: LaneContext, client: IntentClient): () => void {
  const { host, engine, wire } = ctx;

  // Pencil live fade (owner, 2026-07-16): the pencilVanish/pencilFade
  // controls moving while the pencil is claimed re-relay the new lifetime
  // (idempotent re-assert). Engage / disengage / re-point across a tab
  // switch are the `pencilSurface` CLAIM's job (claims.ts), so this effect
  // only re-relays the vanish lifetime while the claim is active — no
  // hand-rolled lifecycle. Owned by a root so unbind disposes it. EVERYTHING
  // the handler needs is computed in the compute (a read inside the handler
  // is untracked and warns STRICT_READ_UNTRACKED).
  const disposePencilFade = createRoot((dispose) => {
    createEffect(
      () => ({
        fade: pencilVanish.get() === true ? (pencilFade.get() as number) : 0,
        active: client.claimStatuses().pencilSurface?.phase === "active",
        tab: client.context().activeTab,
      }),
      ({ fade, active, tab }) => {
        if (active && tab !== undefined) {
          void host.transport
            .requestPage(tab, "pencil", { op: "fade", fadeSec: fade })
            .catch(() => {});
        }
      },
    );
    return dispose;
  });

  // Live config: the stt/linter selects moving mid-session re-apply the
  // engine's IntentPipelineConfig IN PLACE — the retired overlay's
  // `applyEffective`, distilled (delete-then-assign on the live object,
  // which every consumer reads through a thunk). Without this the selects were
  // boot-frozen: the next hello still declared the OLD linter, and the
  // wire's linter-clip gate (`config().linter !== "off"`, shell/wire.ts)
  // silently dropped the clips a mid-session switch-on should have played.
  const disposeConfig = createRoot((dispose) => {
    createEffect(
      () => panelIntentConfig(stt.get() as string, linter.get() as string, oracle.get() as string),
      (effective) => {
        const live = engine.settings as unknown as Record<string, unknown>;
        for (const key of Object.keys(live)) {
          if (!(key in effective)) {
            delete live[key]; // e.g. ttsModel when stepping down from premium
          }
        }
        Object.assign(engine.settings, effective);
      },
    );
    return dispose;
  });

  // Mid-thread linter control: the linter select moving WHILE a turn is open
  // sends a `control` chunk so the sidecar starts/stops/swaps on the CURRENT
  // thread — not just the next hello (which disposeConfig above already
  // updated engine.settings for). No open thread → no-op (the hello carries
  // it). Seeded from the current value so the first real change is caught,
  // never the mount.
  const disposeLinterControl = createRoot((dispose) => {
    let last = linter.get() as string;
    createEffect(
      () => linter.get() as string,
      (value) => {
        if (value === last) {
          return;
        }
        last = value;
        if (engine.threadOpen) {
          // The linter select only ever holds a LinterVendor; `value` is the
          // effect's `string` view of it (config stores it widened).
          void wire.sendControl("linter", value as LinterVendor);
        }
      },
    );
    return dispose;
  });

  // Mid-thread ORACLE control — the oracle select moving while a turn is open
  // starts/stops the oracle on the CURRENT thread, same rail as the linter's.
  const disposeOracleControl = createRoot((dispose) => {
    let last = oracle.get() as string;
    createEffect(
      () => oracle.get() as string,
      (value) => {
        if (value === last) {
          return;
        }
        last = value;
        if (engine.threadOpen) {
          void wire.sendControl("oracle", value as OracleVendor);
        }
      },
    );
    return dispose;
  });

  // The journeys' XOR (capture-bus §4), enforced where the selects LIVE:
  // turning either of oracle/linter on flips the other off, so the illegal
  // combination is unrepresentable in the config layer. Flipping to "off"
  // never recurses (the guards fire only on non-off), so the two effects
  // settle in one bounce. The channel backstops a hand-written hello with a
  // resolve coercion (oracle wins there too).
  const disposeXor = createRoot((dispose) => {
    createEffect(
      () => oracle.get() as string,
      (value) => {
        if (value !== "off" && (linter.get() as string) !== "off") {
          linter.set("off");
        }
      },
    );
    createEffect(
      () => linter.get() as string,
      (value) => {
        if (value !== "off" && (oracle.get() as string) !== "off") {
          oracle.set("off");
        }
      },
    );
    return dispose;
  });

  return () => {
    disposePencilFade();
    disposeConfig();
    disposeLinterControl();
    disposeOracleControl();
    disposeXor();
  };
}
