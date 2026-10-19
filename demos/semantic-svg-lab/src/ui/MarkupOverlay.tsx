import { Show } from "solid-js";
import { resistanceLabel, resolveFeature } from "../model/circuit";
import type { Evidence, Proposal } from "../model/markup";

export function MarkupOverlay(props: { evidence?: Evidence; proposal?: Proposal }) {
  return (
    <g pointer-events="none" class="svg-lab-markup-overlay">
      <Show when={props.evidence?.attachmentImage}>
        {(image) => {
          const anchor = () =>
            resolveFeature(props.evidence?.attachment.target ?? "a/R1/value").point;
          const bounds = () =>
            props.evidence?.attachment.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
          return (
            <image
              data-annotation-target={props.evidence?.attachment.target}
              href={image()}
              x={anchor().x + bounds().x}
              y={anchor().y + bounds().y}
              width={bounds().width}
              height={bounds().height}
            />
          );
        }}
      </Show>
      <Show when={props.proposal}>
        {(proposal) => {
          const anchor = () => resolveFeature(proposal().target).point;
          return (
            <g
              data-proposed-target={proposal().target}
              transform={`translate(${anchor().x - 32} ${anchor().y + 24})`}
            >
              <rect class="svg-lab-proposal-tag" width="124" height="30" />
              <text x="8" y="20">
                → {resistanceLabel(proposal().after)}
              </text>
            </g>
          );
        }}
      </Show>
    </g>
  );
}
