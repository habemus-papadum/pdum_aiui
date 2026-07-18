/**
 * verbs.ts — the IntentLanes the mode engine drives (arm/turn/send/cancel,
 * manual shot, selection pull, pencil sweep, talk) built over a LaneContext.
 * The wire engine is DRIVEN here: these verbs call openTurn/send/stepOut and
 * the engine's own events flow BACK as the mode engine's world. Every status /
 * toast string is byte-identical to the pre-split closure — lanes.test.ts
 * pins them.
 */

import { composeIntent } from "@habemus-papadum/aiui-lowering-pipeline";
import type { IntentLanes } from "../client";
import { shotFlash } from "../config";
import { currentThreadEvents } from "./turn-config";
import type { LaneContext } from "./types";

export function createVerbs(ctx: LaneContext): IntentLanes {
  const { host, engine, wire, talk, status, toast, pencilTabs } = ctx;

  /** The open turn holds something worth lowering (explicit turns can be empty). */
  const turnHasContent = (): boolean =>
    composeIntent(currentThreadEvents(engine.events), "replace", { streaming: true }).items.length >
    0;

  return {
    setArmed: (on) => {
      // Driving, not dual truth: the mode engine is the machine; the wire
      // engine is told. Its setArmed(false) is its own abandon (ends talk,
      // cancels an open thread) — exactly the disarm semantics.
      engine.setArmed(on);
    },
    openTurn: () => {
      engine.setArmed(true); // idempotent belt for same-dispatch arm+open
      engine.openTurn();
    },
    sendTurn: () => {
      if (!engine.threadOpen) {
        return;
      }
      if (turnHasContent()) {
        engine.send({ keepArmed: true }); // §13.6: the seat stays armed
      } else {
        engine.stepOut(); // an empty explicit turn: nothing to lower — cancel
        status("nothing in the turn — cancelled");
      }
    },
    cancelTurn: () => {
      if (engine.threadOpen) {
        engine.stepOut(); // closes with reason "cancel", stays armed
      }
    },
    // NOTE: armRegion/armJump are gone (owner, 2026-07-16). Area and jump are
    // TOGGLE modes now; the regionSurface/jumpSurface claims (claims.ts) arm and
    // lower the page overlays as the mode flips — no imperative lane call. The
    // `regionDrag` page event below still crops + uploads the completed drag.
    takeShot: (tab) => {
      void (async () => {
        const takenAt = Date.now();
        try {
          const shot = await host.capture.grabShot(tab);
          // Camera-style confirmation, strictly AFTER the grab so the wash is
          // never in the frame it confirms. Manual shots flash; sampled never.
          if (shotFlash.get() === true) {
            void host.transport.requestPage(tab, "flash", { kind: "shot" }).catch(() => {});
          }
          const marker = engine.shotDone(
            { x: 0, y: 0, w: shot.width, h: shot.height },
            [],
            shot.thumb ?? "",
            undefined,
            true,
            takenAt,
          );
          await wire.uploadAttachment(marker, shot.mime, shot.bytes);
          status(`${marker} captured (${shot.width}×${shot.height})`);
        } catch (err) {
          toast(`shot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    addSelection: (tab) => {
      void (async () => {
        try {
          const selection = await host.transport.requestPage(tab, "selection");
          if (selection === null || selection === undefined) {
            status("no selection on the page");
            return;
          }
          // The reply is AppSelection plus a `title` the event schema omits;
          // appSelection takes the AppSelection and ignores the extra field.
          engine.appSelection(selection);
        } catch (err) {
          toast(`selection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    clearPencil: (tab) => {
      void host.transport.requestPage(tab, "pencil", { op: "clear" }).catch(() => {});
    },
    clearAllPencils: () => {
      // Disarm's stroke sweep (client.ts runVerbs). Fire-and-forget per tab:
      // a closed tab or dead content script just misses its clear — the page
      // watchdog hard-cleans those anyway.
      for (const tab of pencilTabs) {
        void host.transport.requestPage(tab, "pencil", { op: "clear" }).catch(() => {});
      }
      pencilTabs.clear();
    },
    startTalk: () => {
      talk.startMainListening();
    },
    stopTalk: () => {
      talk.stopMainListening();
    },
    setMicMuted: (muted) => {
      talk.setMicMuted(muted);
    },
  };
}
