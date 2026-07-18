/**
 * debug-page.ts — the bootstrap the served trace debugger page runs.
 *
 * The console (aiui-console) serves this page as its `/__aiui/debug` SPA
 * route (the channel itself serves no HTML). It is a full-page
 * {@link TracesPane} — the same shared list + live-followed TraceView the
 * intent client's panel embeds — polling a channel's `/debug/api/*` routes
 * (the channel opens CORS on `/debug`).
 *
 * **The channel switcher.** The channel serves no HTML, but it does serve
 * `GET /debug/api/channels` — the machine's whole registry — so one reachable
 * channel is enough to enumerate the others. The page's header offers them as
 * a picker: switching remounts the pane against the picked channel's port,
 * and re-enumerates from it (channels come and go with their Claude sessions;
 * whichever one you're on can name the current set).
 *
 * URL contract: `?session=<label>` pins the "current session" filter to that
 * label — the 🔍 link passes the label of the channel it talked to, so the
 * page opens on exactly that session's turns even if other sessions share the
 * trace cache (or the channel has since restarted under a new label). The pin
 * applies to the channel the page OPENED on; picking another channel drops it
 * (that channel's own session becomes the filter).
 */
import { injectDebugUiStyles } from "./styles";
import { TracesPane } from "./traces-pane";

export interface MountDebugPageOptions {
  /** Channel port (the host page supplies it — the console passes its own). */
  port?: number;
}

/** One row of a channel's `GET /debug/api/channels` answer. */
interface ChannelEntry {
  tag: string;
  port: number;
  pid: number;
  cwd: string;
  self?: boolean;
}

/**
 * Boot the trace debugger page: read the `?session=` pin and mount a
 * full-viewport {@link TracesPane} under a channel-switcher header. Without a
 * port there is no channel to poll — the page says so instead of rendering an
 * empty list.
 */
export function mountDebugPage(opts: MountDebugPageOptions = {}): void {
  const initialPort = opts.port;

  injectDebugUiStyles(document);
  const host = document.createElement("div");
  host.style.cssText =
    "position: fixed; inset: 0; display: flex; flex-direction: column; background: #14171f;";
  document.body.style.margin = "0";
  document.body.appendChild(host);

  if (initialPort === undefined) {
    const note = document.createElement("div");
    note.style.cssText =
      "margin: auto; color: #9aa0aa; font: 13px/1.6 ui-sans-serif, system-ui, sans-serif;";
    note.textContent =
      "no channel port — open this page through the console (`aiui debug`) so it knows which channel to poll";
    host.appendChild(note);
    return;
  }

  // ── the header: title + the channel picker ────────────────────────────────
  const head = document.createElement("div");
  head.className = "aiui-dbgp-head";
  const title = document.createElement("span");
  title.className = "aiui-dbgp-title";
  title.textContent = "aiui · lowering traces";
  const picker = document.createElement("select");
  picker.className = "aiui-dbgp-picker";
  picker.title = "Switch to another running channel (from the machine's registry)";
  head.append(title, picker);
  const paneHost = document.createElement("div");
  paneHost.style.cssText = "flex: 1; min-height: 0; display: flex; flex-direction: column;";
  host.append(head, paneHost);

  const initialSession = new URLSearchParams(location.search).get("session") ?? undefined;
  let pane: TracesPane | undefined;
  let currentPort = initialPort;

  const mountPane = (port: number, session?: string): void => {
    pane?.deactivate();
    pane?.root.remove();
    currentPort = port;
    pane = new TracesPane({
      baseUrl: `http://127.0.0.1:${port}`,
      ...(session !== undefined && session !== "" ? { session } : {}),
    });
    paneHost.appendChild(pane.root);
    pane.activate();
  };

  /** Re-enumerate the registry through the current channel and fill the picker. */
  const refreshChannels = async (): Promise<void> => {
    let channels: ChannelEntry[] = [];
    try {
      const res = await fetch(`http://127.0.0.1:${currentPort}/debug/api/channels`);
      if (res.ok) {
        channels = ((await res.json()) as { channels?: ChannelEntry[] }).channels ?? [];
      }
    } catch {
      // channel unreachable — keep whatever the picker already shows
    }
    if (!channels.some((entry) => entry.port === currentPort)) {
      // The channel we're on (older server, or launched unregistered) still
      // deserves a row — the picker must always be able to say where you are.
      channels.unshift({ tag: "(this channel)", port: currentPort, pid: 0, cwd: "" });
    }
    picker.replaceChildren(
      ...channels.map((entry) => {
        const option = document.createElement("option");
        option.value = String(entry.port);
        const dir = entry.cwd === "" ? "" : ` · ${entry.cwd.split("/").slice(-2).join("/")}`;
        option.textContent = `${entry.tag}${dir} · :${entry.port}`;
        option.selected = entry.port === currentPort;
        return option;
      }),
    );
    picker.disabled = channels.length < 2;
  };

  picker.addEventListener("change", () => {
    const port = Number(picker.value);
    if (Number.isInteger(port) && port > 0 && port !== currentPort) {
      // The ?session= pin belongs to the channel the page opened on; the
      // picked channel filters to its own session.
      mountPane(port);
      void refreshChannels();
    }
  });

  mountPane(initialPort, initialSession);
  void refreshChannels();
}
