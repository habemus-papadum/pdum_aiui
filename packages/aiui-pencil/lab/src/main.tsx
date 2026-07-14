/**
 * Pencil Lab — the aesthetics rig for `@habemus-papadum/aiui-pencil`.
 *
 *   pnpm -C packages/aiui-pencil lab       # then open the printed LAN URL on the iPad
 *
 * The Lab is served with `--host`, because the whole point is to draw on it with
 * an Apple Pencil from another device on your network. (That is the same
 * trusted-LAN posture the channel's `channel.bind: "host"` setting takes; see
 * docs/guide/warning.md before pointing it at a network you do not own.)
 *
 * Layer map, per the frontend playbook:
 *
 *   ../../src/*.ts        layer 1 — the pure stroke pipeline (the library itself)
 *   src/model/store.ts    durable roots + the control surface
 *   src/model/capture.ts  the pen recorder — imperative, non-reactive, 120Hz
 *   src/model/pad-renderer.ts  the canvas island — no signals in the hot loop
 *   src/model/graph.ts    the cell graph + the agent tools
 *   src/ui/               components
 */

import { render } from "@solidjs/web";
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { App } from "./ui/App";

render(() => <App />, document.getElementById("root") as HTMLElement);
