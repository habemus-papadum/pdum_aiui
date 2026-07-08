/**
 * MosaicView.tsx — this page's binding of the graduated Mosaic bridge
 * (`@habemus-papadum/aiui-viz/mosaic`) to the durable seismos coordinator, so
 * every call site stays `<MosaicView spec={…}/>`. The bridge itself — spec in,
 * coordinator-connected Plot out, marks disconnected on dispose — lives in the
 * library now; the rationale stays documented there and in NOTES.md.
 */
import { type Directive, MosaicView as VizMosaicView } from "@habemus-papadum/aiui-viz/mosaic";
import { store } from "../store";

export type { Directive };

export function MosaicView(props: { spec: () => Directive[]; class?: string }) {
  return (
    <VizMosaicView
      coordinator={store.coordinator}
      spec={() => props.spec()}
      {...(props.class !== undefined ? { class: props.class } : {})}
    />
  );
}
