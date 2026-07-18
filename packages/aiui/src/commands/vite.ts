import {
  decideBrowserAction,
  discoverSessionBrowser,
  openInSessionBrowser,
} from "@habemus-papadum/aiui-util";
import chalk from "chalk";
import { execa } from "execa";
import { type AiuiArgs, infoFlag, splitAiuiArgs } from "../util/aiui-args";
import { resolveChromeSettings } from "../util/chrome";
import { type AiuiConfig, loadAiuiConfig } from "../util/config";
import { type CliInvocation, resolvePackageCli } from "../util/resolve-cli";
import { printError, printNote, printWarning } from "../util/ui";
import { VERSION } from "../util/version";
import { startSessionBrowser } from "./browser";

const VITE_PKG = "vite";

// NOTE: `aiui vite` no longer wires the app to a channel (owner, 2026-07-17).
// The build-time `VITE_AIUI_PORT` injection existed for the dev-overlay era,
// when a component injected into the app connected to the channel by port.
// That component is gone: an app reaches the channel through the intent client
// served at `/intent/` (same origin, no build-time port). So this command is
// now purely "run Vite, then open the app in the session browser". The one
// surface that still needs a build-time port — the standalone intent panel,
// served on Vite's OWN origin — wires it itself in aiui-intent-client's
// `scripts/dev.ts`, and `aiui debug` resolves a channel through
// `util/channel-target.ts`.

/**
 * Launch Vite, forwarding any extra args (e.g. `aiui vite dev`,
 * `aiui vite --port 3000`, `aiui vite --version`).
 *
 * Unlike `claude` — an external tool we look up on the PATH — Vite is a declared
 * dependency of this package, so we resolve it straight out of node_modules and
 * run it via the current Node with an absolute path. Resolving it also doubles
 * as the "is Vite available?" check: if it isn't installed, we fail loudly
 * rather than shelling out to nothing. See {@link resolvePackageCli}.
 *
 * Once the dev server is up, a *sidecar* opens it in the session browser (the
 * shared window `aiui claude` attaches the agent to). We never know up front
 * which port Vite will bind — the user runs many dev servers and Vite walks up
 * from 5173 — so instead of guessing, Vite's stdout is teed through us and
 * scanned for its own ready banner (see {@link parseViteLocalUrl}). stdin and
 * stderr stay inherited: Vite still owns the terminal, its interactive
 * shortcuts and Ctrl-C behave exactly as before. The sidecar is fire-and-forget
 * ({@link openAppInBrowser}): whatever the browser does, the dev server runs on.
 */
export async function runVite(rawArgs: string[] = []): Promise<void> {
  const aiuiArgs = splitAiuiArgs(rawArgs);
  const { mcp, tag, passthrough } = aiuiArgs;

  // `--help` / `--version` are inert: aiui's own answer, then Vite's.
  const info = infoFlag(passthrough);
  if (info) {
    if (info === "help") {
      printViteWrapperHelp();
    } else {
      console.log(`aiui ${VERSION}`);
    }
    await forwardToVite(passthrough);
    return;
  }

  // A stray `--aiui-mcp`/`--aiui-tag` from muscle memory or an old script: the
  // channel wiring is gone (see the header), so it can only mislead. Say so
  // rather than accept it silently.
  if (mcp !== undefined || tag !== undefined) {
    printWarning(
      "aiui vite no longer connects the app to a channel",
      "--aiui-mcp / --aiui-tag are ignored. The app reaches the channel through the intent " +
        "client served at /intent/, not a build-time port. (The standalone panel's own `pnpm dev` " +
        "still selects a channel — that page is served on Vite's origin, not the channel's.)",
    );
  }

  const vite = resolveVite();
  if (!vite) {
    return;
  }

  // execa merges `env` over process.env, so we only add entries deliberately.
  const env: NodeJS.ProcessEnv = {};
  // Piping stdout (below) makes Vite see a non-TTY and drop its colors. When
  // *our* stdout is a real terminal the tee lands there verbatim, so tell the
  // child to keep coloring — unless the user already voted (FORCE_COLOR /
  // NO_COLOR), in which case their setting passes through untouched.
  if (process.stdout.isTTY && !("FORCE_COLOR" in process.env) && !("NO_COLOR" in process.env)) {
    env.FORCE_COLOR = "1";
  }

  // stdin/stderr inherit so the dev server owns the terminal (Ctrl-C, the
  // h/r/q shortcuts); stdout is piped *only* to learn which port Vite bound —
  // every byte is teed straight back out. buffer:false because a dev server
  // runs for hours and execa would otherwise accumulate its whole output.
  // reject:false so a non-zero/interrupted Vite exit is propagated as our exit
  // code instead of throwing an error the user didn't cause.
  const child = execa(vite.command, [...vite.args, ...passthrough], {
    stdio: ["inherit", "pipe", "inherit"],
    buffer: false,
    reject: false,
    env,
  });
  if (child.stdout) {
    teeAndDetectLocalUrl(child.stdout, process.stdout, (url) => {
      // Fire-and-forget: openAppInBrowser catches everything itself, and Vite
      // must never wait on (or die with) the browser.
      void openAppInBrowser(url, aiuiArgs);
    });
  }
  const result = await child;
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/**
 * ANSI CSI escape sequences (colors, cursor movement, screen clears):
 * `ESC [`, parameter bytes, intermediate bytes, one final byte.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Parse one line of Vite's stdout for the local dev-server URL.
 *
 * Vite's ready banner looks like (colored in a real terminal):
 *
 *     ➜  Local:   http://localhost:5174/
 *     ➜  Network: use --host to expose
 *
 * Only the `Local:` line counts, and only with a loopback host (`localhost`,
 * `127.0.0.1`, `[::1]`) — that's the URL meaningful to open in a browser on
 * this machine, or to port-forward in the headless hint. ANSI codes are
 * stripped *first*: Vite colors the host and the port separately, so escape
 * sequences sit in the middle of the URL text and no pattern would survive
 * matching against the raw bytes. Returns undefined for anything that isn't
 * the ready line — the same shape the retired workbench lab used, the
 * house pattern for these one-line protocols.
 */
export function parseViteLocalUrl(line: string): string | undefined {
  const plain = line.replace(ANSI_CSI, "");
  const match = plain.match(
    /\bLocal:\s+(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?\S*)/,
  );
  return match?.[1];
}

/**
 * Tee a child's stdout to ours verbatim while watching for the dev-server URL.
 *
 * Chunks are forwarded untouched (colors, spinners, screen clears all pass
 * through); scanning happens on a parallel line-buffered copy so a URL split
 * across chunk boundaries is still seen. Once found, `onUrl` fires exactly
 * once and the scanner disengages — from then on this is a plain passthrough.
 * Exported for tests, which drive it with in-memory streams (no child
 * process).
 */
export function teeAndDetectLocalUrl(
  source: NodeJS.ReadableStream,
  sink: NodeJS.WritableStream,
  onUrl: (url: string) => void,
): void {
  let buffer = "";
  let found = false;
  source.on("data", (chunk: Buffer | string) => {
    sink.write(chunk);
    if (found) {
      return;
    }
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const url = parseViteLocalUrl(line);
      if (url) {
        found = true;
        buffer = "";
        onUrl(url);
        return;
      }
    }
    // Guard the partial-line buffer against pathological unbroken output; the
    // banner line we're waiting for is short, so nothing real is lost.
    if (buffer.length > 8192) {
      buffer = buffer.slice(-8192);
    }
  });
}

type ChromeConfig = NonNullable<AiuiConfig["chrome"]>;

/**
 * The browser sidecar: once the dev server's URL is known, put it in front of
 * the user — in the *session browser* (the shared window `aiui claude`
 * attaches the agent to; see aiui-util's browser module and `aiui open`),
 * never their default browser. A running session browser gets a new tab; none running
 * means launching one exactly the way `aiui browser` does
 * ({@link startSessionBrowser}), with the app as its first tab.
 *
 * Runs concurrently with Vite and must never interfere with it: everything is
 * caught, failures print a warning, and the dev server keeps the terminal and
 * keeps running either way. It is also deliberately non-interactive — Vite
 * owns stdin — so the managed-browser sync never prompts here; it just
 * uses whatever browser is already available.
 */
export async function openAppInBrowser(url: string, aiuiArgs: AiuiArgs): Promise<void> {
  try {
    // `--aiui-browser-url` beats a configured chrome.browserUrl for this run,
    // the same precedence `aiui claude` gives it.
    const chromeCfg: ChromeConfig = {
      ...loadAiuiConfig().chrome,
      ...(aiuiArgs.browserUrl ? { browserUrl: aiuiArgs.browserUrl } : {}),
    };
    const action = decideBrowserAction(aiuiArgs, chromeCfg);
    if (action.kind === "skip") {
      return;
    }
    if (action.kind === "hint") {
      printNote(
        `detected a headless environment (${action.reason}) — not opening a browser`,
        `Assuming the dev server's port is already forwarded, open ${url} in the browser\n` +
          "on your local machine. (Pass --aiui-browser to open one here anyway.)",
      );
      return;
    }

    if (chromeCfg.browserUrl) {
      await openInSessionBrowser(chromeCfg.browserUrl, url);
      console.error(chalk.dim(`aiui: opened ${url} in the browser at ${chromeCfg.browserUrl}`));
      return;
    }
    const settings = resolveChromeSettings(aiuiArgs, chromeCfg);
    const running = await discoverSessionBrowser(settings.userDataDir);
    if (running) {
      await openInSessionBrowser(running.browserUrl, url);
      console.error(chalk.dim(`aiui: opened ${url} in the session browser`));
    } else {
      await startSessionBrowser({
        flags: aiuiArgs,
        config: chromeCfg,
        interactive: false,
        startUrl: url,
      });
      console.error(chalk.dim(`aiui: opened ${url} in a new session browser`));
    }
  } catch (error) {
    printWarning(
      "couldn't open the app in the session browser — the dev server is unaffected",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Resolve the Vite CLI; print the friendly install pointer when missing. */
function resolveVite(): CliInvocation | undefined {
  try {
    return resolvePackageCli(VITE_PKG);
  } catch {
    printError(
      "Vite is not available",
      "`vite` should be installed as a dependency of aiui — try reinstalling.",
    );
    process.exitCode = 1;
    return undefined;
  }
}

/** Run Vite with the args verbatim (the --help/--version forward). */
async function forwardToVite(args: string[]): Promise<void> {
  const vite = resolveVite();
  if (!vite) {
    return;
  }
  const result = await execa(vite.command, [...vite.args, ...args], {
    stdio: "inherit",
    reject: false,
  });
  if (result.exitCode) {
    process.exitCode = result.exitCode;
  }
}

/** The aiui half of `aiui vite --help` (vite's own --help follows it). */
function printViteWrapperHelp(): void {
  console.log(`aiui vite — launch Vite and open the app in the session browser

aiui's own flags (everything else forwards to vite verbatim):
  --aiui-browser                 open the app in the session browser even when
                                 the environment looks headless (CI, SSH, no display)
  --aiui-no-browser              never open a browser for this run
  --aiui-chrome-profile <name>   browser profile at .aiui-cache/chrome/<name>
  --aiui-chrome-data-dir <path>  explicit browser user data dir

When Vite prints its Local: URL, aiui opens it in the shared session browser
(the one \`aiui claude\` and \`aiui open\` use); in headless environments it
prints the URL to open on your own machine instead.

The app reaches the aiui channel through the intent client served at /intent/,
not through this command — so there is no channel to pick here. (The standalone
intent panel, served on Vite's own origin, is the exception: its \`pnpm dev\`
selects a channel itself.) What follows is vite's own --help:
`);
}
