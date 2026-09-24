/**
 * MosaicView.tsx — the lab's binding of aiui-viz's Mosaic bridge to the durable
 * coordinator, so call sites stay `<MosaicView spec={…} />`. The coordinator's
 * connector follows the engine generation (store.ts); the bridge itself never
 * learns which engine answers.
 */
import { type Directive, MosaicView as VizMosaicView } from "@habemus-papadum/aiui-viz/mosaic";
import { appScope, store } from "../model/store";

export type { Directive };

export function MosaicView(props: { spec: () => Directive[]; name?: string; class?: string }) {
  return (
    <VizMosaicView
      coordinator={store.coordinator}
      spec={() => props.spec()}
      scope={appScope}
      {...(props.name !== undefined ? { name: props.name } : {})}
      {...(props.class !== undefined ? { class: props.class } : {})}
    />
  );
}
