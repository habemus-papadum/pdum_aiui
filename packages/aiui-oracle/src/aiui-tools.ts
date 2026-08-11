/**
 * aiui-tools.ts — the bridge from an aiui app's surface to {@link OracleTool}s.
 * Two projections, complementary:
 *
 *  - {@link toolsFromControlSurface} — TYPED. One `set_<name>` function tool
 *    per `control()`, its argument schema SYNTHESIZED from `ControlMeta`
 *    (`options` → `enum`, `min`/`max` → `minimum`/`maximum`, `step` →
 *    `multipleOf` when 0-anchored) — the projection the repo lacked: realtime
 *    tools have no strict mode, so the schema is how the model learns the
 *    bounds. Plus one tool per `action()`, and a `report` snapshot tool.
 *  - {@link toolsFromAiuiRegistry} — GENERIC. Wraps `window.__AIUI__.tools`
 *    registrations (whatever the page installed, HMR-live) — the same surface
 *    the intent client forwards to the channel. The O3 spine.
 *
 * Solid-correctness (the pinned semantics, packages/aiui-viz/docs/frontend-hard-won.md):
 * a write goes through the control's own validated `set`, and the RETURNED
 * value is the truth — never read back after a write (Solid 2.0 stages
 * commits; a boundary read would be stale). Calling `.set` from a transport
 * callback is correct — controls are module-level durable signals, no owner
 * involved.
 */

import {
  actionByName,
  type ControlSurfaceEntry,
  controlByName,
  controlSurface,
  ensureAiuiGlobal,
  subscribeControlSurface,
} from "@habemus-papadum/aiui-viz";
import type { OracleTool } from "./types";

/** OpenAI tool names must match `[a-zA-Z0-9_-]{1,64}`; scope separators don't. */
function toolName(prefix: string, qualified: string): string {
  return `${prefix}${qualified}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** The ControlMeta → JSON Schema projection. Advisory (the control's own
 * validator still snaps and clamps) but it is what hands the model bounds. */
export function controlValueSchema(
  entry: Extract<ControlSurfaceEntry, { kind: "control" }>,
): Record<string, unknown> {
  const meta = entry.meta;
  if (Array.isArray(meta.options)) {
    return { enum: [...meta.options] };
  }
  if (typeof entry.value === "boolean") {
    return { type: "boolean" };
  }
  if (typeof entry.value === "number") {
    const schema: Record<string, unknown> = { type: "number" };
    if (typeof meta.min === "number") {
      schema.minimum = meta.min;
    }
    if (typeof meta.max === "number") {
      schema.maximum = meta.max;
    }
    // `multipleOf` assumes a 0 anchor; the control snaps anchored at `min`,
    // so only advertise it when the anchors agree.
    if (typeof meta.step === "number" && meta.step > 0 && (meta.min ?? 0) % meta.step === 0) {
      schema.multipleOf = meta.step;
    }
    return schema;
  }
  return { type: "string" };
}

function controlDescription(entry: Extract<ControlSurfaceEntry, { kind: "control" }>): string {
  const bits = [entry.description ?? entry.name];
  const meta = entry.meta;
  if (typeof meta.min === "number" && typeof meta.max === "number") {
    bits.push(`range ${meta.min}–${meta.max}${meta.unit !== undefined ? ` ${meta.unit}` : ""}`);
  } else if (meta.unit !== undefined) {
    bits.push(`unit ${meta.unit}`);
  }
  return bits.join(" — ");
}

export interface ControlSurfaceToolsOptions {
  /**
   * Keep only one scope's entries (an aiui `Scope` or its name). The control
   * surface is DOCUMENT-global — in a composed document (the gallery mounting
   * many demos) an unscoped projection hands this oracle EVERY app's
   * controls, so a per-app oracle passes its own scope. Omit deliberately for
   * a host-level oracle that drives the whole document.
   */
  scope?: string | { name: string };
  /** Arbitrary extra filtering (composes with `scope`). */
  filter?: (entry: ControlSurfaceEntry) => boolean;
  /** Include the `report` snapshot tool. Default true. */
  report?: boolean;
}

function surfaceFilter(
  options: ControlSurfaceToolsOptions,
): (entry: ControlSurfaceEntry) => boolean {
  const scopeName = typeof options.scope === "string" ? options.scope : options.scope?.name;
  return (entry) =>
    (scopeName === undefined || entry.name.startsWith(`${scopeName}/`)) &&
    (options.filter?.(entry) ?? true);
}

/** Project the page's control surface into typed oracle tools — a SNAPSHOT.
 * For a live surface, re-project on {@link onControlSurfaceChange} and hand
 * the result to `session.setTools` (the owner-decided day-one flexibility). */
export function toolsFromControlSurface(options: ControlSurfaceToolsOptions = {}): OracleTool[] {
  const keep = surfaceFilter(options);
  const entries = controlSurface().filter(keep);
  const tools: OracleTool[] = [];
  for (const entry of entries) {
    if (entry.kind === "control") {
      tools.push({
        name: toolName("set_", entry.name),
        description: `Set ${controlDescription(entry)}. Returns the value actually applied (snapped and clamped).`,
        parameters: {
          type: "object",
          properties: { value: controlValueSchema(entry) },
          required: ["value"],
          additionalProperties: false,
        },
        execute: (args) => {
          const box = controlByName(entry.name);
          if (box === undefined) {
            throw new Error(`control no longer exists: ${entry.name}`);
          }
          // The validated setter returns the WRITTEN value — the only honest
          // answer under staged commits.
          return { applied: box.set(args.value as never) };
        },
      });
    } else {
      tools.push({
        name: toolName("", entry.name),
        description: entry.description ?? entry.name,
        parameters:
          // Actions rarely declare a real schema; the loose `params` prose
          // rides the description instead of pretending to be one.
          { type: "object", properties: {}, additionalProperties: true },
        execute: (args) => {
          const action = actionByName(entry.name);
          if (action === undefined) {
            throw new Error(`action no longer exists: ${entry.name}`);
          }
          return action.run(args) ?? null;
        },
      });
    }
  }
  if (options.report !== false) {
    tools.push({
      name: "report",
      description:
        "Read the app's current state: every control's value and bounds. Call before answering questions about how the app is set.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: () =>
        controlSurface()
          .filter(keep)
          .map((entry) =>
            entry.kind === "control"
              ? { control: entry.name, value: entry.value, ...entry.meta }
              : { action: entry.name },
          ),
    });
  }
  return tools;
}

/** Change notification for the live surface (a control/action registered). */
export function onControlSurfaceChange(listener: () => void): () => void {
  return subscribeControlSurface(listener);
}

export interface RegistryToolsOptions {
  /** Keep only these namespaces (default: all registrations). */
  namespaces?: string[];
}

/**
 * Wrap the page's `window.__AIUI__.tools` registrations — whatever surface
 * the page installed (the standard tools, custom kits), exactly as the intent
 * client sees it. Names are `ns_name`-prefixed when more than one namespace
 * registers. Returns undefined when the page has no registry.
 */
export function toolsFromAiuiRegistry(
  options: RegistryToolsOptions = {},
): OracleTool[] | undefined {
  const registry = ensureAiuiGlobal()?.tools;
  if (registry === undefined) {
    return undefined;
  }
  const registrations = registry
    .list()
    .filter(
      (registration) =>
        options.namespaces === undefined || options.namespaces.includes(registration.ns),
    );
  const prefix = registrations.length > 1;
  const tools: OracleTool[] = [];
  for (const registration of registrations) {
    for (const tool of registration.tools) {
      tools.push({
        name: toolName(prefix ? `${registration.ns}_` : "", tool.name),
        description: tool.description,
        parameters: tool.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
        execute: (args) => registry.call(registration.ns, tool.name, args),
      });
    }
  }
  return tools;
}
