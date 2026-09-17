/**
 * vite.ts — mount the live backend INTO a Vite dev server: the session
 * broker (`POST /live/sessions`, the project key stays in this process's
 * environment) and the delegation relay (`WS /live/delegate`) with the
 * server-side delegators — Claude Code in the app's own source tree, a
 * Responses model with the server's key, and the scripted stand-in.
 *
 *   import { live } from "@habemus-papadum/aiui-live/vite";
 *   export default defineConfig({ plugins: [live(), aiui(), solid()] });
 *
 * The upgrade hook claims only `<prefix>/*` — Vite's HMR socket keeps working.
 */

import type { Plugin } from "vite";
import type { ClaudeDelegatorOptions } from "./claude/index.ts";
import { scriptedDelegator } from "./delegators/fake.ts";
import { responsesDelegator } from "./delegators/responses.ts";
import {
  createLiveBackend,
  type DelegatorFactory,
  type LiveBackendOptions,
} from "./node/backend.ts";

export interface LivePluginOptions extends Omit<LiveBackendOptions, "log" | "delegators"> {
  /** Extra or overriding delegators, by name. */
  delegators?: Record<string, DelegatorFactory>;
  /** Claude Code options (`cwd` defaults to the Vite root); `false` to omit. */
  claude?: ClaudeDelegatorOptions | false;
  /** The server-keyed Responses backend; `false` to omit. */
  responses?:
    | {
        model?: string;
        effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
        app?: string;
      }
    | false;
}

export function live(options: LivePluginOptions = {}): Plugin {
  return {
    name: "aiui-live",
    configureServer(server) {
      const log = (line: string) => server.config.logger.info(line);
      const resolveKey = options.resolveKey ?? (() => process.env.OPENAI_API_KEY);
      const delegators: Record<string, DelegatorFactory> = {
        scripted: () => scriptedDelegator({ delayMs: 1200 }),
      };
      if (options.responses !== false) {
        const responses = options.responses ?? {};
        delegators.responses = () =>
          responsesDelegator({
            key: () => process.env.OPENAI_API_KEY,
            model: responses.model,
            effort: responses.effort,
            app: responses.app,
          });
      }
      if (options.claude !== false) {
        const claude = options.claude ?? {};
        delegators.claude = async (ctx) => {
          const mod = await import("./claude/index.ts").catch((error: unknown) => {
            throw new Error(
              `Claude Code delegator unavailable — install @anthropic-ai/claude-agent-sdk (${error instanceof Error ? error.message : String(error)})`,
            );
          });
          return mod.claudeDelegator({ cwd: server.config.root, log: ctx.log, ...claude });
        };
      }
      Object.assign(delegators, options.delegators);
      const backend = createLiveBackend({
        prefix: options.prefix,
        resolveKey,
        baseUrl: options.baseUrl,
        fetchImpl: options.fetchImpl,
        toolTimeoutMs: options.toolTimeoutMs,
        delegators,
        log,
      });
      server.middlewares.use((req, res, next) => {
        if (!backend.handleHttp(req, res)) {
          next();
        }
      });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        backend.handleUpgrade(req, socket, head);
      });
      server.httpServer?.on("close", () => backend.dispose());
      log(
        `aiui-live: broker at ${options.prefix ?? "/live"}/sessions, delegators ${Object.keys(delegators).join(", ")}`,
      );
    },
  };
}
