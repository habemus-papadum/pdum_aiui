/**
 * Facets.tsx — vgplot input widgets (mosaic-inputs Menu) bound to the shared
 * crossfilter. Each menu publishes an equality clause on a categorical column
 * (event type, magnitude type) into the same `brush` the plots use, so choosing
 * "nuclear explosion" or "mww" re-queries every view. Same island discipline as
 * MosaicView: construct, connect to the durable coordinator, disconnect on
 * cleanup (Menu extends MosaicClient, so `destroy()` disconnects).
 */
import { Menu } from "@uwdata/mosaic-inputs";
import { For, onCleanup } from "solid-js";
import { store } from "../store";

function menuHost(column: string, label: string) {
  // mosaic-inputs types `as` as Param<any>; a Selection is a Param subtype the
  // generated d.ts doesn't accept structurally — cast the options through.
  const menu = new Menu({
    as: store.brush,
    from: store.table,
    column,
    label,
  } as ConstructorParameters<typeof Menu>[0]);
  store.coordinator.connect(menu);

  // A menu bound to a Selection is write-only — mosaic-inputs only back-syncs a
  // menu bound to a scalar Param, so clearing the crossfilter elsewhere (the
  // reset button, the agent, another view) would leave the <select> showing a
  // stale value. Reflect it: when this menu's clause is gone from the brush,
  // return the <select> to its "all" option (without re-publishing).
  const el = menu.element as HTMLElement;
  const select = el.matches?.("select") ? (el as HTMLSelectElement) : el.querySelector("select");
  const reflect = () => {
    if (!select) return;
    const has = store.brush.clauses.some((c) => c.source === menu);
    if (!has && select.value !== "") select.value = "";
  };
  store.brush.addEventListener("value", reflect);
  onCleanup(() => {
    store.brush.removeEventListener("value", reflect);
    menu.destroy();
  });
  return el;
}

export function Facets() {
  const menus = [
    { column: "type", label: "event type" },
    { column: "magtype", label: "mag type" },
  ];
  return (
    <div class="facets">
      <For each={menus}>{(m) => <div class="vg-input">{menuHost(m.column, m.label)}</div>}</For>
    </div>
  );
}
