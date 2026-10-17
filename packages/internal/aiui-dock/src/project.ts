/**
 * project.ts — the page's tool surface, as the dock hands it to a session:
 * the ACTIVE namespaces' tools and briefs from `window.__AIUI__.tools`. A
 * multi-app document (the gallery) parks the kits of the pages that are
 * off-route; a dock that projected them would hand the voice model the whole
 * site. Pure over the registry's listing, so the rule is testable.
 */
import {
  briefFromAiuiRegistry,
  type OracleTool,
  toolsFromAiuiRegistry,
} from "@habemus-papadum/aiui-oracle";
import { ensureAiuiGlobal } from "@habemus-papadum/aiui-viz";

export interface DockSurface {
  /** The namespaces projected (the active ones). */
  namespaces: string[];
  tools: OracleTool[];
  brief: string | undefined;
  /** Changes when the projection does: the sessions re-receive tools on a new one only. */
  signature: string;
}

/** The namespaces a session should see: every one not parked (`active !== false`). */
export function activeNamespaces(
  listing: ReadonlyArray<{ ns: string; active?: boolean }>,
): string[] {
  return listing.filter((entry) => entry.active !== false).map((entry) => entry.ns);
}

/** Project the page's registry: the active kits' tools and the brief that goes with them. */
export function projectSurface(): DockSurface {
  const registry = ensureAiuiGlobal()?.tools;
  const namespaces = activeNamespaces(registry?.list() ?? []);
  const tools = namespaces.length > 0 ? (toolsFromAiuiRegistry({ namespaces }) ?? []) : [];
  const brief = namespaces.length > 0 ? briefFromAiuiRegistry({ namespaces }) : undefined;
  return {
    namespaces,
    tools,
    brief,
    signature: `${namespaces.join(",")}|${tools.map((t) => t.name).join(",")}|${brief ?? ""}`,
  };
}
