/**
 * Is a built extension artifact actually LOADABLE?
 *
 * The dev build's stamp (./dev-stamp) means "complete", and this is what earns
 * it: an extension whose manifest points at files that were never written loads
 * as a broken shell — no surface, no error, nothing to search for. A dev
 * artifact that cannot boot is worse than no dev artifact, so the build says so
 * and refuses to stamp.
 *
 * Node-side only (fs), and deliberately NOT in the browser barrel — hence the
 * package-internal subpath (`#dev-artifact`), the repo's convention for module
 * code Vite loads through Node itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Files the built manifest points at but which do not exist in the artifact.
 *
 * Note what this deliberately does NOT expect: in dev, CRXJS emits **no entry
 * bundles at all** — the manifest points at loader stubs
 * (`service-worker-loader.js`, `src/*-loader.js`) and at each HTML page's
 * CRXJS "loading page", and the real modules are fetched from the dev server at
 * runtime (the service worker proxies the extension's own origin). So the only
 * honest completeness question is the manifest's own: *is every file the
 * manifest names actually here?*
 */
export function missingManifestFiles(dir: string): string[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return ["manifest.json"];
  }
  const refs = new Set<string>();
  const add = (value: unknown): void => {
    // Globs (web_accessible_resources) name no single file — skip them.
    if (typeof value === "string" && value && !value.includes("*")) {
      refs.add(value);
    }
  };

  const background = manifest.background as { service_worker?: string } | undefined;
  add(background?.service_worker);
  const sidePanel = manifest.side_panel as { default_path?: string } | undefined;
  add(sidePanel?.default_path);
  const action = manifest.action as
    | { default_popup?: string; default_icon?: Record<string, string> | string }
    | undefined;
  add(action?.default_popup);
  for (const icon of Object.values(action?.default_icon ?? {})) {
    add(icon);
  }
  add(manifest.options_page);
  for (const icon of Object.values((manifest.icons as Record<string, string>) ?? {})) {
    add(icon);
  }
  for (const script of (manifest.content_scripts as { js?: string[]; css?: string[] }[]) ?? []) {
    for (const file of [...(script.js ?? []), ...(script.css ?? [])]) {
      add(file);
    }
  }
  for (const war of (manifest.web_accessible_resources as { resources?: string[] }[]) ?? []) {
    for (const file of war.resources ?? []) {
      add(file);
    }
  }
  return [...refs].filter((file) => !existsSync(join(dir, file))).sort();
}
