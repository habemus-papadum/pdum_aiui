import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Adapter for any executable that emits the dev-ready line. POSIX process groups. */
export async function processBackend({
  name,
  command,
  args,
  cwd,
  env,
  onExit,
  signal,
  probePath,
  timeout = 30_000,
}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopping = false;
  let exited = false;
  let stopPromise;
  const lines = createInterface({ input: child.stdout });
  const errors = createInterface({ input: child.stderr });
  errors.on("line", (line) => console.error(`[${name}] ${line}`));
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve();
      if (!stopping) onExit?.(new Error(`${name} exited (${signal ?? code})`));
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = () => {
    stopPromise ??= (async () => {
      stopping = true;
      signalGroup("SIGTERM");
      if (!exited) {
        let timer;
        await Promise.race([
          exit,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
        clearTimeout(timer);
      }
      // Also collect descendants left behind if the direct child already exited.
      signalGroup("SIGKILL");
      await exit;
      lines.close();
      errors.close();
    })();
    return stopPromise;
  };

  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: readiness timed out`)), timeout);
      const finish = (error, url) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(url);
      };
      const abort = () => finish(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", (error) => finish(error));
      child.once("exit", () => finish(new Error(`${name}: exited before readiness`)));
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          console.log(`[${name}] ${line}`);
          return;
        }
        if (message?.type !== "dev-ready") return;
        try {
          const url = new URL(message.url);
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
            throw new Error(`${name}: expected a bound loopback HTTP URL`);
          }
          finish(null, url.href);
        } catch (error) {
          finish(error);
        }
      });
    });
    // Readiness means the address is useful, not just that a socket was allocated.
    if (probePath) {
      const probeSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const response = await fetch(new URL(probePath, url), { signal: probeSignal });
      if (!response.ok) throw new Error(`${name}: readiness probe returned ${response.status}`);
      await response.body?.cancel();
    }
    return { name, url, pid: child.pid, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
