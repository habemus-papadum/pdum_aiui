import "katex/dist/katex.min.css";
import "./style.css";
import { button, control, element } from "./dom";
import { fixtures } from "./fixtures";
import { ImagePopup } from "./image-popup";
import { request } from "./model";
import { type Action, counterpart, initialState, reduce, type Side } from "./state";
import { inspector, sourceView } from "./views";

const root = document.getElementById("app");
if (!root) throw new Error("Missing app root");
const app: HTMLElement = root;
let state = initialState(fixtures[2]);
const popup = new ImagePopup();
let status = "Select text, an equation, a tree entry, or a source line to follow its provenance.";
let suppressScrollUntil = 0;
let renderAbort = new AbortController();

function dispatch(action: Action) {
  state = reduce(state, action);
  render();
}

function select(side: Side, owners: string[], from: "tree" | "raw" | "preview" | "source") {
  state = reduce(state, { type: "reveal", side, owners });
  state = reduce(state, { type: "select", selection: { side, owners, from } });
  const unmatched = owners.filter((owner) => !counterpart(state, side, owner));
  status = owners.length
    ? `${owners.length} contributor${owners.length === 1 ? "" : "s"} selected from ${from}.${state.compare && unmatched.length ? ` No counterpart for ${unmatched.join(", ")} on the other side.` : ""}`
    : "No recorded source owner on this line.";
  render();
  suppressScrollUntil = performance.now() + 150;
  for (const pane of app.querySelectorAll<HTMLElement>("[data-scroll]")) {
    const selected = pane.querySelector<HTMLElement>(".selected");
    if (selected) scrollToElement(pane, selected);
  }
}

function scrollToElement(pane: HTMLElement, target: HTMLElement) {
  pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
}

function installScrollSync() {
  for (const inspectorNode of app.querySelectorAll<HTMLElement>("[data-inspector]")) {
    const panes = [...inspectorNode.querySelectorAll<HTMLElement>("[data-scroll]")].filter(
      (pane) => !pane.dataset.scroll?.endsWith("tree"),
    );
    for (const active of panes) {
      active.addEventListener(
        "scroll",
        () => {
          if (!state.scrollSync || performance.now() < suppressScrollUntil) return;
          const top = active.getBoundingClientRect().top;
          const anchors = [...active.querySelectorAll<HTMLElement>("[data-anchor], .asset")];
          const anchor = anchors.find(
            (candidate) => candidate.getBoundingClientRect().bottom > top + 15,
          );
          if (!anchor) return;
          const owners = anchor.dataset.owners?.split(" ") ?? [];
          for (const targetPane of panes.filter((pane) => pane !== active)) {
            const target = [
              ...targetPane.querySelectorAll<HTMLElement>("[data-anchor], .asset"),
            ].find((candidate) =>
              candidate.dataset.owners?.split(" ").some((owner) => owners.includes(owner)),
            );
            if (!target) continue;
            suppressScrollUntil = performance.now() + 100;
            // Coarse occurrence anchor; never proportional character-to-pixel mapping.
            scrollToElement(targetPane, target);
          }
        },
        { passive: true, signal: renderAbort.signal },
      );
    }
  }
}

async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    status = `Copied ${label}. Presentation folds did not change it.`;
  } catch {
    status =
      "Clipboard is unavailable in this browser. Open the request panel to select its complete JSON.";
  }
  const live = app.querySelector("[data-status]");
  if (live) live.textContent = status;
}

function toolbar() {
  const node = element("div", "toolbar top-toolbar");
  const label = element("label", "", "Example ");
  const picker = element("select");
  picker.setAttribute("aria-label", "Example fixture");
  picker.dataset.control = "fixture";
  for (const fixture of fixtures) {
    const option = element("option", "", fixture.title);
    option.value = fixture.id;
    option.selected = fixture.id === state.fixture.id;
    picker.append(option);
  }
  picker.addEventListener("change", () => {
    const fixture = fixtures.find((item) => item.id === picker.value);
    if (!fixture) return;
    state = initialState(fixture);
    if (fixture.id === "comparison") state = { ...state, compare: true };
    status = "Fixture changed. All panes now show the same artifact revision.";
    render();
  });
  label.append(picker);
  node.append(label);
  const revision = element("select");
  revision.setAttribute("aria-label", "Artifact revision");
  revision.dataset.control = "revision";
  for (const side of ["before", "after"] as const) {
    const option = element("option", "", `${side === "before" ? "A" : "B"} · ${side}`);
    option.value = side;
    option.selected = state.revision === side;
    revision.append(option);
  }
  revision.disabled = state.compare;
  revision.addEventListener("change", () =>
    dispatch({ type: "revision", revision: revision.value as Side }),
  );
  node.append(
    revision,
    control("Compare A / B", state.compare, () => dispatch({ type: "compare" })),
    control("Link comparison", state.linked, () => dispatch({ type: "linked" })),
    control("Sync scrolling", state.scrollSync, () => dispatch({ type: "scrollSync" })),
  );
  node.append(button("Expand all", () => dispatch({ type: "expand" })));
  const fold = button("Fold selected", () => {
    const selection = state.selection;
    if (!selection) return;
    for (const owner of selection.owners)
      state = reduce(state, { type: "fold", side: selection.side, owner });
    render();
  });
  fold.disabled = !state.selection?.owners.length;
  node.append(fold);
  const artifact = state.fixture[state.selection?.side ?? state.revision];
  const textParts = artifact.parts.filter((part) => part.kind === "text");
  const oneTextOnly = artifact.parts.length === 1 && artifact.parts[0].kind === "text";
  node.append(
    button(oneTextOnly ? "Copy exact text" : "Copy ordered parts JSON", () => {
      const value = oneTextOnly
        ? textParts[0].text
        : JSON.stringify(request(artifact).currentTurn.messages[0].content, null, 2);
      void copy(value, oneTextOnly ? "exact original text" : "ordered parts JSON");
    }),
  );
  node.append(
    button("Copy request JSON", () => {
      void copy(JSON.stringify(request(artifact), null, 2), "fixture request JSON");
    }),
  );
  return node;
}

function render() {
  const scrollPositions = new Map(
    [...app.querySelectorAll<HTMLElement>("[data-scroll]")].map((node) => [
      node.dataset.scroll,
      node.scrollTop,
    ]),
  );
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.control
      : undefined;
  popup.close();
  renderAbort.abort();
  renderAbort = new AbortController();
  app.replaceChildren();
  const header = element("header");
  header.append(
    element("h1", "", "Prompt inspector · interaction spike"),
    element(
      "p",
      "lede",
      "Inspect one newly authored turn, with its exact content and a linked human preview.",
    ),
  );
  header.append(
    element(
      "p",
      "notice",
      "Unpublished prototype · fixed examples and hand-authored provenance · no compiler, model calls, automatic optimization, or arbitrary TSX editing.",
    ),
    toolbar(),
    element("p", "scenario", state.fixture.note),
  );
  const live = element("p", "status", status);
  live.dataset.status = "true";
  live.setAttribute("role", "status");
  header.append(live);
  app.append(header);
  const sides: Side[] = state.compare ? ["before", "after"] : [state.revision];
  const content = element("main", state.compare ? "comparison" : "");
  for (const side of sides) content.append(inspector({ state, side, dispatch, select, popup }));
  app.append(content);
  const bottom = element("div", "bottom-grid");
  bottom.append(sourceView({ state, side: state.revision, dispatch, select, popup }));
  const payload = element("section", "payload-section");
  payload.append(
    element("h3", "", "Current turn + history reference"),
    element(
      "p",
      "muted",
      "Neutral fixture shape, not a provider SDK request. History is separate and fixed; no request has been sent.",
    ),
  );
  const side = state.selection?.side ?? state.revision;
  const pre = element("pre", "payload", JSON.stringify(request(state.fixture[side]), null, 2));
  pre.dataset.scroll = "payload";
  payload.append(pre);
  bottom.append(payload);
  app.append(bottom);
  app.append(
    element(
      "footer",
      "muted",
      "Interaction limits: block-level preview maps; whole equations and tables remain visible when partially folded. Scroll linking is a coarse occurrence anchor, not glyph synchronization. Image SVGs are local illustrations.",
    ),
  );
  for (const pane of app.querySelectorAll<HTMLElement>("[data-scroll]"))
    pane.scrollTop = scrollPositions.get(pane.dataset.scroll) ?? 0;
  if (focused)
    [...app.querySelectorAll<HTMLElement>("[data-control]")]
      .find((node) => node.dataset.control === focused)
      ?.focus({ preventScroll: true });
  installScrollSync();
}

render();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    popup.dispose();
    renderAbort.abort();
    app.replaceChildren();
  });
