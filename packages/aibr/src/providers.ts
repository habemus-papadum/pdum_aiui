import { spawn } from "node:child_process";
import { endpoint, fields, object, type Provider, string } from "./model.ts";

export interface Candidate {
  id: string;
  label: string;
  host?: string;
  detail?: string;
}
export interface ProviderResolution {
  endpoint?: string;
  needsConnect?: boolean;
}

/** Versioned JSON protocol. argv is never evaluated by a shell. */
export async function callProvider(
  provider: Provider,
  operation: "discover" | "resolve" | "connect",
  id?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(provider.command, provider.args, {
      cwd: provider.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 500);
        forceKill.unref();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error(`Provider ${operation} timed out`)),
      provider.timeoutMs ?? 15_000,
    );
    child.once("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      if (stdout.length > 1024 * 1024) finish(new Error("Provider output exceeded 1 MiB"));
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderr = (stderr + chunk).slice(-8192);
    });
    child.once("close", (code) => {
      if (code !== 0)
        return finish(new Error(`Provider ${operation} exited ${code}: ${stderr.trim()}`));
      try {
        const reply = object(JSON.parse(stdout), "Provider response");
        if (reply.schemaVersion !== 1) throw new Error("Unsupported provider schemaVersion");
        if (reply.error !== undefined) throw new Error(string(reply.error, "Provider error"));
        finish(undefined, reply);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(
      `${JSON.stringify({ schemaVersion: 1, operation, ...(id === undefined ? {} : { id }) })}\n`,
    );
  });
}

export async function discover(provider: Provider): Promise<Candidate[]> {
  const reply = object(await callProvider(provider, "discover"), "Provider response");
  fields(reply, ["schemaVersion", "candidates"], "discovery response");
  if (!Array.isArray(reply.candidates)) throw new Error("Provider discover must return candidates");
  const ids = new Set<string>();
  return reply.candidates.map((value) => {
    const v = object(value, "Candidate");
    fields(v, ["id", "label", "host", "detail"], "candidate");
    const id = string(v.id, "Candidate ID");
    if (ids.has(id)) throw new Error(`Duplicate provider candidate ID: ${id}`);
    ids.add(id);
    return {
      id,
      label: string(v.label, "Candidate label"),
      host: v.host === undefined ? undefined : string(v.host, "Candidate host"),
      detail: v.detail === undefined ? undefined : string(v.detail, "Candidate detail"),
    };
  });
}

export async function resolveProvider(
  provider: Provider,
  id: string,
  connect = true,
): Promise<string> {
  const parse = (raw: unknown): ProviderResolution => {
    const reply = object(raw, "Provider resolution");
    fields(reply, ["schemaVersion", "endpoint", "needsConnect"], "provider resolution");
    if (reply.needsConnect !== undefined && typeof reply.needsConnect !== "boolean")
      throw new Error("needsConnect must be boolean");
    return {
      endpoint: reply.endpoint === undefined ? undefined : endpoint(reply.endpoint),
      needsConnect: reply.needsConnect === true,
    };
  };
  let result = parse(await callProvider(provider, "resolve", id));
  if (result.needsConnect) {
    if (!connect)
      throw new Error(
        "Target needs a connection; resolving it would require the provider's connect operation",
      );
    result = parse(await callProvider(provider, "connect", id));
  }
  if (!result.endpoint || result.needsConnect)
    throw new Error("Provider did not return a usable endpoint");
  return result.endpoint;
}
