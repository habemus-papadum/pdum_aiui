/**
 * presentation.ts — the paved road's config resolution (owner, 2026-07-17).
 *
 * A host declares a {@link RemotePresentation} when it registers; the shared
 * client app renders from the RESOLVED form. Absent fields default to
 * fully-featured — the Lab's behavior — so a host that declares nothing gets
 * everything, and a host like the intent client subtracts what it doesn't
 * want (erase, presets, brush knobs) without forking the client.
 *
 * Presentation only: the host stays authoritative over what strokes it
 * accepts (see protocol.ts — overrides merge over the host-resolved preset,
 * and a host can clamp the tool outright).
 */
import type { PencilMode } from "../pencil";
import type { RemotePresentation } from "../protocol";
import type { Tool } from "../surface";

/** {@link RemotePresentation} with every default applied. */
export interface ResolvedPresentation {
  title?: string;
  accent?: string;
  /** A fixed ink color: the preview paints with it (see the protocol doc). */
  strokeColor?: string;
  tools: Tool[];
  modes: PencilMode[];
  undo: boolean;
  clear: boolean;
  navigation: boolean;
  color: boolean;
  size: boolean;
}

/** The fully-featured defaults (what the Lab shows). */
export const FULL_PRESENTATION: ResolvedPresentation = {
  tools: ["draw", "erase"],
  modes: ["write", "sketch"],
  undo: true,
  clear: true,
  navigation: true,
  color: true,
  size: true,
};

/** Apply defaults; empty arrays are treated as "offer none" (still valid). */
export function resolvePresentation(p?: RemotePresentation): ResolvedPresentation {
  return {
    ...(p?.title !== undefined ? { title: p.title } : {}),
    ...(p?.accent !== undefined ? { accent: p.accent } : {}),
    ...(p?.strokeColor !== undefined ? { strokeColor: p.strokeColor } : {}),
    tools: p?.tools ?? FULL_PRESENTATION.tools,
    modes: p?.modes ?? FULL_PRESENTATION.modes,
    undo: p?.undo ?? true,
    clear: p?.clear ?? true,
    navigation: p?.navigation ?? true,
    color: p?.color ?? true,
    size: p?.size ?? true,
  };
}
