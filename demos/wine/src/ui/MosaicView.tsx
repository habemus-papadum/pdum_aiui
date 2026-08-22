/**
 * MosaicView.tsx — this page's binding of the aiui-viz Mosaic bridge to the
 * durable wine coordinator, so call sites stay `<MosaicView name spec/>`.
 */
import { type Directive, MosaicView as VizMosaicView } from "@habemus-papadum/aiui-viz/mosaic";
import { appScope, store } from "../model/store";

export type { Directive };

export function MosaicView(props: { spec: () => Directive[]; class?: string; name?: string }) {
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
