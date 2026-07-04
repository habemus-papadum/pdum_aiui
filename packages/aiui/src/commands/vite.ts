import { execa } from "execa";

/**
 * Launch Vite.
 *
 * STUB — this currently just runs a placeholder subprocess so the wiring
 * (commander → execa) can be exercised end to end. The real Vite command line
 * is TBD; replace the `execa(...)` call below once we've settled on it.
 */
export async function runVite(): Promise<void> {
  // `stdio: "inherit"` hands the terminal to the child so the Vite dev server's
  // output streams straight through and Ctrl-C reaches it.
  await execa("echo", ["[aiui vite] stub — will launch Vite here"], {
    stdio: "inherit",
  });
}
