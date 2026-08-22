/**
 * Facets.tsx — the country menu (mosaic-inputs Menu) bound to the shared
 * crossfilter, the seismos pattern: construct, connect to the durable
 * coordinator, enroll in the producer directory (so the country dimension
 * adopts it and the inspector names its clause), reflect external clears
 * back into the <select> (a Selection-bound menu is write-only), and destroy
 * on cleanup.
 */
import { registerMosaicInput } from "@habemus-papadum/aiui-viz";
import { Menu } from "@uwdata/mosaic-inputs";
import { onCleanup } from "solid-js";
import { appScope, store } from "../model/store";

function menuHost(column: string, label: string) {
  const menu = new Menu({
    as: store.brush,
    from: store.table,
    column,
    label,
  } as ConstructorParameters<typeof Menu>[0]);
  store.coordinator.connect(menu);
  const unregister = registerMosaicInput({
    scope: appScope,
    name: `${column}-menu`,
    input: menu,
    selection: store.brush,
    fields: [column],
  });

  const el = menu.element as HTMLElement;
  const select = el.matches?.("select") ? (el as HTMLSelectElement) : el.querySelector("select");
  const reflect = () => {
    if (!select) return;
    const has = store.brush.clauses.some((c) => c.source === menu);
    if (!has && select.value !== "") select.value = "";
  };
  store.brush.addEventListener("value", reflect);
  onCleanup(() => {
    unregister();
    store.brush.removeEventListener("value", reflect);
    menu.destroy();
  });
  return el;
}

export function Facets() {
  return (
    <div class="facets">
      <div class="vg-input">{menuHost("country", "country")}</div>
    </div>
  );
}
