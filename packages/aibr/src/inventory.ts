import { browserStatus } from "./browser.ts";
import { browserExecutable, type installations } from "./installations.ts";
import { type Config, type Paths, redactEndpoint } from "./model.ts";
import { inspectProfiles } from "./profiles.ts";

export async function profileInventory(p: Paths, config: Config) {
  return Promise.all(
    (await inspectProfiles(p, config)).map(async (row) => {
      const status = row.profile && row.dir ? await browserStatus(p, row.dir) : undefined;
      let executable: string | undefined;
      let browserError: string | undefined;
      if (row.profile) {
        try {
          executable = await browserExecutable(p, row.profile.browser);
        } catch (error) {
          browserError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        ...row,
        status:
          status?.state ??
          (row.error
            ? "invalid"
            : "endpoint" in row.target
              ? "endpoint (not probed)"
              : "provider (not probed)"),
        target:
          "endpoint" in row.target ? { endpoint: redactEndpoint(row.target.endpoint) } : row.target,
        runningHeadless: status?.runtime?.launch.headless,
        detail: status?.detail,
        restartRequired: status?.changedSettings ?? false,
        executable,
        browserError,
      };
    }),
  );
}

export function formatInstallations(rows: Awaited<ReturnType<typeof installations>>): string {
  if (!rows.length) return "No aibr-managed browsers installed. Run: aibr browser install";
  return rows
    .map(
      (row) =>
        `${row.family} ${row.buildId} (${row.platform})${row.selected ? " [selected for new launches]" : ""}${row.available ? "" : " [executable missing]"}\n  ${row.executable}`,
    )
    .join("\n");
}

export function formatProfiles(
  rows: Awaited<ReturnType<typeof profileInventory>>,
  defaultTarget?: string,
): string {
  if (!rows.length) return "No profiles yet. Run: aibr profile create";
  return rows
    .map((row) => {
      const lines = [
        `${row.name}${row.name === defaultTarget ? " [user default]" : ""} — ${row.status}${row.restartRequired ? " (restart required)" : ""}`,
      ];
      if (row.dir) lines.push(`  Directory: ${row.dir}${row.external ? " (external)" : ""}`);
      if ("endpoint" in row.target)
        lines.push(
          `  Endpoint: ${row.target.endpoint}`,
          "  Lifecycle: attach only; managed on the browser host",
        );
      if ("provider" in row.target)
        lines.push(`  Provider: ${row.target.provider} · ID: ${row.target.id}`);
      if (row.profile) {
        const { browser, launch } = row.profile;
        lines.push(`  Browser: ${"managed" in browser ? browser.managed : browser.executable}`);
        lines.push(
          `  Debug port: ${launch.debugPort || "0 (ephemeral)"} · Mode: ${launch.headless ? "headless" : "not headless"} · Media: ${launch.mediaPreset}`,
        );
        if (row.runningHeadless !== undefined)
          lines.push(`  Running mode: ${row.runningHeadless ? "headless" : "not headless"}`);
        lines.push(
          `  Extensions: ${launch.extensions.map((e) => ("path" in e ? e.path : `${e.package}/${e.directory}`)).join(", ") || "none"}`,
        );
        lines.push(
          `  Extra arguments: ${launch.extraArgs.length ? JSON.stringify(launch.extraArgs) : "none"}`,
        );
        if (row.executable) lines.push(`  Executable: ${row.executable}`);
      }
      for (const issue of [row.error, row.browserError, row.detail])
        if (issue) lines.push(`  Issue: ${issue}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
