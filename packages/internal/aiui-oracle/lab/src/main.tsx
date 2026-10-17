/**
 * Oracle Lab — layer map:
 *  - ../../src/*            layer 1: the library under test (source-first)
 *  - ./model/store.ts       the durable frontier (controls + action + toolkit)
 *  - ./model/wave.ts        the pure model
 *  - ./ui/Wave.tsx          the canvas island (imperative rAF)
 *  - ./ui/App.tsx           the composition: app + oracle session + widgets
 */

import { render } from "@solidjs/web";
import { App } from "./ui/App";
import "./styles.css";

const root = document.getElementById("root");
if (root !== null) {
  render(() => <App />, root);
}
