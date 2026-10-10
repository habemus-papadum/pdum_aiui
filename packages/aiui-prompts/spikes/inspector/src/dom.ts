export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(
  label: string,
  click: () => void,
  className = "",
  title?: string,
): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", click);
  if (title) node.title = title;
  return node;
}

export function control(label: string, checked: boolean, change: () => void): HTMLLabelElement {
  const wrapper = element("label", "check");
  const input = element("input");
  input.type = "checkbox";
  input.dataset.control = `toggle:${label}`;
  input.checked = checked;
  input.addEventListener("change", change);
  wrapper.append(input, document.createTextNode(label));
  return wrapper;
}
