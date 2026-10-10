/** Presentation-only workbench control. Never reload or re-mount the inspector. */
export function bindBenchTheme(select: HTMLSelectElement, wrapper: HTMLElement): () => void {
  const apply = () => {
    if (["neutral", "aiui", "terminal"].includes(select.value))
      wrapper.dataset.promptTheme = select.value;
  };
  apply();
  select.addEventListener("change", apply);
  return () => select.removeEventListener("change", apply);
}
