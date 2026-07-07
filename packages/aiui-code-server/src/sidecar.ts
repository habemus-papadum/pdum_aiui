/**
 * The code reader's **backend as a channel sidecar** — the server half of the
 * reader (the LSP byte-relay plus the file/walkthrough routes under
 * `/__aiui_code/*`), mounted onto the aiui channel's Express app so one session
 * process serves it. There is no separate dev server.
 *
 * The reader *frontend* is a separate, session-agnostic library
 * ({@link mountCodeReader}); it runs in the app's page and talks to these routes
 * over the channel port (cross-origin loopback — the backend already sends
 * permissive CORS). This module is the concrete {@link Sidecar} the launcher
 * hands `startWebServer` when a project has an LSP setup: language servers spin
 * up lazily per connection and are disposed on channel close.
 */
import type { MountedSidecar, Sidecar, SidecarContext } from "@habemus-papadum/aiui-claude-channel";
import type { Express } from "express";
import { mountAiuiCodeBackend } from "./backend";

export interface CodeReaderSidecarOptions {
  /** Project root served + LSP working directory. */
  root: string;
}

/** Package the code reader's backend as a channel {@link Sidecar}. */
export function codeReaderSidecar(options: CodeReaderSidecarOptions): Sidecar {
  return {
    name: "code",
    mount(app: Express, ctx: SidecarContext): MountedSidecar {
      const backend = mountAiuiCodeBackend({ root: options.root, onLog: ctx.log });
      // The reader's own handler claims everything under /__aiui_code/* and
      // returns false for anything else (which falls through to `next`). The
      // channel scopes body parsing to `/prompt`, so POST streams reach the
      // reader's raw body reader intact. A rejection is routed to Express's
      // error path — an unhandled rejection here would take down the whole
      // channel process.
      app.use((req, res, next) => {
        void Promise.resolve(backend.handleHttp(req, res)).then((handled) => {
          if (!handled) {
            next();
          }
        }, next);
      });
      return {
        handleUpgrade: (req, socket, head) => backend.handleUpgrade(req, socket, head),
        dispose: () => backend.dispose(),
      };
    },
  };
}
