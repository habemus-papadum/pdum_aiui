/**
 * The channel's HTTP routes: `/health`, `POST /prompt`, and the session bus's
 * `GET /session/peers` + `POST /session/publish`. Pure registration over a small
 * dependency bag — no mutable state of its own; `generation` comes live from
 * `deps.getGeneration()`.
 *
 * Body parsing is scoped to the routes that need it (just `/prompt` and
 * `/session/publish`) via a per-route `express.json()`, NOT global: a sidecar's
 * raw request handler (one that reads its own POST bodies off the stream) must
 * reach the socket unconsumed.
 */
import express, { type Express } from "express";
import { listLanInterfaces } from "./lan";
import type { PageToolDirectory } from "./page-tools";
import type { PeersResponse, PublishResult, SessionHub } from "./session-hub";
import type { PromptHandler } from "./web";
import { errorMessage } from "./web-runtime";

export interface ChannelRouteDeps {
  /** The bound address, echoed on `/health` so tools can tell loopback from LAN. */
  bindHost: string;
  /** Called with text arriving over `POST /prompt`. */
  onPrompt: PromptHandler;
  /** The page-tool registry, summarized on `/health`. */
  pageTools: PageToolDirectory;
  /** The session bus, feeding `/health` and the `/session/*` HTTP surface. */
  sessionHub: SessionHub;
  /** Server-level debug mode, advertised on `/health`. */
  debug?: boolean;
  /** The live reload generation, read per request (never captured by value). */
  getGeneration: () => number;
}

/** Register the channel's own HTTP routes on the Express app. */
export function registerChannelRoutes(app: Express, deps: ChannelRouteDeps): void {
  const { bindHost, onPrompt, pageTools, sessionHub, getGeneration } = deps;

  app.get("/health", (_req, res) => {
    // Readable cross-origin: the intent client's tools-link probes this route
    // from the app's dev-server origin before dialing `/tools` (the browser
    // logs failed websocket handshakes unsuppressably, so it never dials
    // blind). The payload is harmless loopback metadata, and the header's
    // presence is part of the capability signal — it ships together with the
    // `/tools` endpoint, so a CORS-refused probe means an older channel.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      ok: true,
      pid: process.pid,
      ppid: process.ppid,
      generation: getGeneration(),
      // The bound address, so tools can tell a loopback-only server from a
      // LAN-exposed one (the console dashboard reads it to know whether the LAN
      // interfaces below are reachable).
      host: bindHost,
      // The machine's non-internal IPv4 interfaces — the addresses a host-bound
      // channel is reachable on from another device. The dashboard offers a copy
      // button per interface (an iPad on the same Wi-Fi picks the matching one).
      interfaces: listLanInterfaces(),
      pageTools: pageTools.summary(),
      session: sessionHub.summary(),
      ...(deps.debug === true ? { debug: true } : {}),
    });
  });

  app.post("/prompt", express.json(), async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text) {
      res.status(400).json({ ok: false, error: "expected a non-empty 'text' field" });
      return;
    }
    try {
      await onPrompt(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: errorMessage(err) });
    }
  });

  // The session bus's HTTP surface, for external same-host providers (the VS
  // Code extension) that contribute to the turn without holding a `/session`
  // socket of their own: `GET /session/peers` lists the connected views (so a
  // tool can offer "which browser tab?"), and `POST /session/publish` injects a
  // server-originated publish, targeted at one view (`clientId`), a role, or
  // everyone. Both report the cached `armed` slot so callers can phrase their
  // feedback; delivery is not gated on it — the intent client's contribution
  // handler arms the turn itself when a contribution lands.
  app.get("/session/peers", (_req, res) => {
    // Readable cross-origin for the same reason as /health: harmless loopback
    // metadata a debug page may want to render.
    res.setHeader("Access-Control-Allow-Origin", "*");
    const body: PeersResponse = {
      ok: true,
      peers: sessionHub.peers(),
      armed: sessionHub.get("armed") === true,
    };
    res.json(body);
  });

  app.post("/session/publish", express.json(), (req, res) => {
    const topic = typeof req.body?.topic === "string" ? req.body.topic : "";
    if (!topic) {
      const body: PublishResult = { ok: false, error: "expected a non-empty 'topic' field" };
      res.status(400).json(body);
      return;
    }
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : undefined;
    const role = typeof req.body?.role === "string" ? req.body.role : undefined;
    const delivered = sessionHub.publishFromServer(topic, req.body?.payload, {
      ...(clientId !== undefined ? { clientId } : {}),
      ...(role !== undefined ? { role } : {}),
    });
    if (delivered.length === 0) {
      const wanted =
        clientId !== undefined
          ? `view "${clientId}"`
          : role !== undefined
            ? `a "${role}" view`
            : "any connected view";
      const body: PublishResult = {
        ok: false,
        error: `no connected session view matches ${wanted}`,
      };
      res.status(404).json(body);
      return;
    }
    const body: PublishResult = { ok: true, delivered, armed: sessionHub.get("armed") === true };
    res.json(body);
  });
}
