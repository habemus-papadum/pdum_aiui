import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  Browser,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import { type BrowserFamily, type BrowserSpec, object, type Paths, string } from "./model.ts";
import { locked, readJson, writeJson } from "./storage.ts";

const kinds = { chromium: Browser.CHROMIUM, "chrome-for-testing": Browser.CHROME };
const installRoot = (p: Paths): string => join(p.cache, "browsers");
const selectedFile = (p: Paths, family: BrowserFamily): string =>
  join(p.state, `browser-${family}.json`);

export function family(value: string): BrowserFamily {
  if (value === "cft") return "chrome-for-testing";
  if (value !== "chromium" && value !== "chrome-for-testing")
    throw new Error("Browser must be chromium or chrome-for-testing (cft)");
  return value;
}

export async function installations(p: Paths) {
  return Promise.all(
    (await getInstalledBrowsers({ cacheDir: installRoot(p) }))
      .filter((b) => b.browser === Browser.CHROMIUM || b.browser === Browser.CHROME)
      .sort(
        (a, b) =>
          a.browser.localeCompare(b.browser) ||
          b.buildId.localeCompare(a.buildId, undefined, { numeric: true }),
      )
      .map(async (b) => {
        const browser: BrowserFamily =
          b.browser === Browser.CHROMIUM ? "chromium" : "chrome-for-testing";
        const selected = await readJson(selectedFile(p, browser));
        let available = true;
        try {
          await access(b.executablePath, constants.X_OK);
        } catch {
          available = false;
        }
        return {
          family: browser,
          buildId: b.buildId,
          platform: b.platform,
          executable: b.executablePath,
          selected:
            selected !== undefined &&
            object(selected, "Selected browser").executable === b.executablePath,
          available,
        };
      }),
  );
}

export async function latestBuild(browser: BrowserFamily): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform)
    throw new Error(
      `No managed browser build for ${process.platform}/${process.arch}; use --executable`,
    );
  return resolveBuildId(kinds[browser], platform, browser === "chromium" ? "latest" : "stable");
}

export async function installBrowser(
  p: Paths,
  browser: BrowserFamily,
  build?: string,
): Promise<string> {
  return locked(join(p.state, "browser-install"), async () => {
    const buildId = build ?? (await latestBuild(browser));
    const result = await install({ browser: kinds[browser], buildId, cacheDir: installRoot(p) });
    await writeJson(selectedFile(p, browser), { buildId, executable: result.executablePath });
    // Existing browser processes can still be using older builds. Never prune them on update.
    return result.executablePath;
  });
}

export async function browserExecutable(p: Paths, spec: BrowserSpec): Promise<string> {
  let executable: string;
  if ("executable" in spec) executable = spec.executable;
  else {
    const selected = await readJson(selectedFile(p, spec.managed));
    if (selected === undefined)
      throw new Error(`Install the profile's browser first: aibr browser install ${spec.managed}`);
    executable = string(object(selected, "Selected browser").executable, "Browser executable");
  }
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error(`Browser executable is missing or not executable: ${executable}`);
  }
  return executable;
}
