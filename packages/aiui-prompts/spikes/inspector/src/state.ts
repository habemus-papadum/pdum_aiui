import { type Artifact, ancestors, type Fixture } from "./model";

export type Side = "before" | "after";
export interface Selection {
  side: Side;
  owners: string[];
  from: "tree" | "raw" | "preview" | "source";
}
export interface InspectorState {
  fixture: Fixture;
  revision: Side;
  compare: boolean;
  linked: boolean;
  scrollSync: boolean;
  folded: Set<string>;
  outline: Set<string>;
  selection?: Selection;
}
export type Action =
  | { type: "fixture"; fixture: Fixture }
  | { type: "revision"; revision: Side }
  | { type: "compare" }
  | { type: "linked" }
  | { type: "scrollSync" }
  | { type: "select"; selection: Selection }
  | { type: "fold"; side: Side; owner: string }
  | { type: "outline"; side: Side; owner: string }
  | { type: "reveal"; side: Side; owners: string[] }
  | { type: "expand" };

export const key = (side: Side, id: string) => `${side}:${id}`;
export function initialState(fixture: Fixture): InspectorState {
  return {
    fixture,
    revision: "after",
    compare: false,
    linked: true,
    scrollSync: true,
    folded: new Set(),
    outline: new Set(),
  };
}
export function hidden(state: InspectorState, side: Side, owner: string): boolean {
  return ancestors(state.fixture[side], owner).some((id) => state.folded.has(key(side, id)));
}
export function coverage(
  state: InspectorState,
  side: Side,
  owners: string[],
): "none" | "partial" | "full" {
  const count = owners.filter((id) => hidden(state, side, id)).length;
  return count === 0 ? "none" : count === owners.length ? "full" : "partial";
}
export function counterpart(state: InspectorState, side: Side, id: string): string | undefined {
  const other = side === "before" ? "after" : "before";
  // These fixtures explicitly reuse stable occurrence IDs for known correspondence.
  return state.fixture[other].occurrences.some((item) => item.id === id) ? id : undefined;
}
function toggle(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function reduce(state: InspectorState, action: Action): InspectorState {
  switch (action.type) {
    case "fixture":
      return initialState(action.fixture);
    case "compare": {
      const next = { ...state, compare: !state.compare };
      return next.compare ? next : reduce(next, { type: "revision", revision: state.revision });
    }
    case "linked":
      return { ...state, linked: !state.linked };
    case "scrollSync":
      return { ...state, scrollSync: !state.scrollSync };
    case "revision": {
      const selection = state.selection;
      const owners = selection?.owners.filter((id) =>
        state.fixture[action.revision].occurrences.some((o) => o.id === id),
      );
      const reconcile = (values: Set<string>) => {
        const next = new Set(values);
        for (const occurrence of state.fixture[action.revision].occurrences) {
          next.delete(key(action.revision, occurrence.id));
          if (values.has(key(state.revision, occurrence.id)))
            next.add(key(action.revision, occurrence.id));
        }
        return next;
      };
      return {
        ...state,
        revision: action.revision,
        folded: reconcile(state.folded),
        outline: reconcile(state.outline),
        selection:
          owners?.length && selection ? { ...selection, side: action.revision, owners } : undefined,
      };
    }
    case "select":
      return { ...state, selection: action.selection };
    case "outline":
      return { ...state, outline: toggle(state.outline, key(action.side, action.owner)) };
    case "fold": {
      const folded = toggle(state.folded, key(action.side, action.owner));
      const other: Side = action.side === "before" ? "after" : "before";
      if (state.compare && state.linked && counterpart(state, action.side, action.owner)) {
        const otherKey = key(other, action.owner);
        if (folded.has(key(action.side, action.owner))) folded.add(otherKey);
        else folded.delete(otherKey);
      }
      return { ...state, folded };
    }
    case "reveal": {
      const folded = new Set(state.folded);
      const outline = new Set(state.outline);
      for (const owner of action.owners) {
        for (const id of ancestors(state.fixture[action.side], owner)) {
          folded.delete(key(action.side, id));
          outline.delete(key(action.side, id));
        }
      }
      return { ...state, folded, outline };
    }
    case "expand":
      return { ...state, folded: new Set(), outline: new Set() };
  }
}

export function selected(state: InspectorState, side: Side, owner: string): boolean {
  const selection = state.selection;
  if (!selection) return false;
  return selection.owners.some(
    (id) =>
      ancestors(state.fixture[side], owner).includes(id) &&
      (selection.side === side ||
        (state.compare && state.linked && !!counterpart(state, selection.side, id))),
  );
}

export function changeKind(
  fixture: Fixture,
  side: Side,
  owner: string,
): "same" | "changed" | "added" | "removed" {
  const other = side === "before" ? "after" : "before";
  if (!fixture[other].occurrences.some((o) => o.id === owner))
    return side === "before" ? "removed" : "added";
  const value = (artifact: Artifact) =>
    artifact.parts
      .flatMap((part) =>
        part.kind === "image"
          ? part.owner === owner
            ? [`${part.asset.id}:${part.asset.revision}`]
            : []
          : part.contributions
              .filter((c) => c.owner === owner)
              .map((c) => part.text.slice(c.start, c.end)),
      )
      .join("");
  return value(fixture.before) === value(fixture.after) ? "same" : "changed";
}
