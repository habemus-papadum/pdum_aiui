/**
 * tex.tsx — TeX rendered with KaTeX. `renderToString` builds the markup once
 * (no MathML/DOM churn), dropped into `innerHTML`. `throwOnError: false` keeps
 * a typo from blanking the page — it renders the offending source in red
 * instead.
 *
 * KaTeX draws with the inherited text color, so the .math-* wrappers should be
 * given `color: var(--text)` (or equivalent) by the consumer's stylesheet and
 * the math tracks the light/dark theme for free. The KaTeX stylesheet is
 * imported here so any page that uses <TeX> pulls it in once. `katex` is an
 * optional peer — only `/site` consumers pay for it.
 *
 * The wrapper carries `data-tex` with the raw source: it joins
 * `data-source-loc` / `data-cell` in the DOM attribution contract, so a text
 * selection landing inside rendered math (the intent runtime's selection
 * watcher) recovers the original TeX from the stamp (KaTeX's own MathML
 * `<annotation>` is the fallback, but the explicit attribute is robust to
 * output settings).
 *
 * (Named `TeX`, not `Math` — biome's noShadowRestrictedNames forbids shadowing
 * the `Math` global; see the hard-won ledger.)
 */
import katex from "katex";
import "katex/dist/katex.min.css";

export function TeX(props: { tex: string; display?: boolean }) {
  const html = () =>
    katex.renderToString(props.tex, {
      throwOnError: false,
      displayMode: props.display ?? false,
    });
  return props.display ? (
    <div class="math-display" data-tex={props.tex} innerHTML={html()} />
  ) : (
    <span class="math-inline" data-tex={props.tex} innerHTML={html()} />
  );
}
