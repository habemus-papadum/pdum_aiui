/**
 * The VS Code extension host entry: a status-bar item showing which browser
 * tab this window sends selections to (click to change, like the git branch
 * picker), and the `aiui: Send Selection to Browser Tab` command.
 *
 * Nothing here caches the world: the picker queries the registry + each
 * channel's live peers when it opens, and every send revalidates the
 * remembered tab first. That revalidation matters because a channel reload
 * (an edit under `AIUI_CHANNEL_WATCH`, or `POST /debug/api/reload`) drops all
 * websockets — the tab reconnects with a NEW clientId — so a remembered id
 * goes stale while the tab itself is fine; the send re-binds to it silently
 * instead of nagging.
 *
 * Everything that doesn't need the `vscode` module lives in channels.ts,
 * agents.ts, and contribution.ts; this file is the thin host glue.
 * build-extension.mjs bundles it to CJS for the .vsix — the npm artifact
 * ships only the library (index.ts), whose build never includes this file's
 * `vscode` import.
 */
import * as vscode from "vscode";
import { claudeSessionNames } from "./agents";
import {
  type ChannelEntry,
  fetchPeers,
  listChannels,
  publishSelection,
  type SessionPeer,
} from "./channels";
import { selectionToContribution } from "./contribution";

/** The picked destination, persisted per workspace. */
interface Target {
  port: number;
  tag: string;
  cwd: string;
  clientId: string;
  label: string;
  url?: string;
  /** The channel's display title (name / Claude session / tag, marked when debug). */
  channel?: string;
  /** The tab belongs to a debug server (never silently auto-picked). */
  debug?: boolean;
}

const TARGET_KEY = "aiui.target";

/** A short human name for a peer (title, else URL, else id). */
function peerLabel(peer: SessionPeer): string {
  return peer.label ?? peer.url ?? peer.clientId;
}

/**
 * A deep link back to the selection (1-based line/col). Locally that's
 * `vscode://file/…`; in a remote window the extension runs in the remote host
 * (see `extensionKind`) and the document's path exists only on that machine,
 * so the link routes through the `vscode-remote` authority — clicking it from
 * the local browser reopens the file in the remote workspace.
 */
function selectionUrl(uri: vscode.Uri, line: number, character: number): string {
  if (uri.scheme === "vscode-remote") {
    return `vscode://vscode-remote/${uri.authority}${uri.path}:${line}:${character}`;
  }
  return `vscode://file/${uri.fsPath}:${line}:${character}`;
}

/**
 * How the picker titles a channel: its own display name (a debug server's `--name`),
 * else the owning Claude Code session's name (the channel's `ppid` is that
 * session — matched via `claude agents --json`, exactly like the CLI
 * selector), else the tag. Debug servers are always marked.
 */
function channelTitle(channel: ChannelEntry, agents: Map<number, string>): string {
  const who = channel.name ?? agents.get(channel.ppid) ?? channel.tag;
  return `${who}${channel.debug === true ? " · debug" : ""}`;
}

/** The persisted pick for one of a channel's tabs. */
function targetFor(channel: ChannelEntry, peer: SessionPeer, agents: Map<number, string>): Target {
  return {
    port: channel.port,
    tag: channel.tag,
    cwd: channel.cwd,
    clientId: peer.clientId,
    label: peerLabel(peer),
    channel: channelTitle(channel, agents),
    ...(peer.url !== undefined ? { url: peer.url } : {}),
    ...(channel.debug === true ? { debug: true } : {}),
  };
}

/**
 * A channel's session views that can ingest a selection: the intent client's
 * panels (role "intent-client" — the greeting in the client's session.ts).
 * The panel forwards the published selection into its wire engine as a
 * `code-selection` event on the open turn.
 */
async function selectionTargets(channel: Pick<ChannelEntry, "port">): Promise<SessionPeer[]> {
  const { peers } = await fetchPeers(channel.port);
  return peers.filter((p) => p.role === "intent-client");
}

/** Why a remembered target no longer resolves. */
type Stale = { reason: "channel-gone" | "tab-gone" };

/**
 * Re-resolve a remembered target against the channel's LIVE peers: same
 * clientId → still good; otherwise re-bind by URL, or — the common
 * single-tab case after a channel reload handed the tab a fresh clientId —
 * to the only view left. Anything else is honestly stale.
 */
async function revalidateTarget(target: Target): Promise<Target | Stale> {
  let tabs: SessionPeer[];
  try {
    tabs = await selectionTargets({ port: target.port });
  } catch {
    return { reason: "channel-gone" };
  }
  const rebind = (peer: SessionPeer): Target => ({
    ...target,
    clientId: peer.clientId,
    label: peerLabel(peer),
    ...(peer.url !== undefined ? { url: peer.url } : {}),
  });
  const same = tabs.find((p) => p.clientId === target.clientId);
  if (same) {
    return rebind(same); // refresh label/url too — titles drift
  }
  const byUrl = target.url !== undefined ? tabs.filter((p) => p.url === target.url) : [];
  if (byUrl.length === 1 && byUrl[0]) {
    return rebind(byUrl[0]);
  }
  if (tabs.length === 1 && tabs[0]) {
    return rebind(tabs[0]);
  }
  return { reason: "tab-gone" };
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "aiui.pickBrowserTab";
  context.subscriptions.push(status);

  const getTarget = (): Target | undefined => context.workspaceState.get<Target>(TARGET_KEY);
  const setTarget = async (target: Target | undefined): Promise<void> => {
    await context.workspaceState.update(TARGET_KEY, target);
    renderStatus();
  };

  function renderStatus(): void {
    const target = getTarget();
    if (target) {
      status.text = `$(radio-tower) aiui: ${target.label}`;
      status.tooltip = new vscode.MarkdownString(
        `aiui — sending selections to **${target.label}**\n\n` +
          `${target.url ?? ""}\n\n` +
          `channel \`${target.channel ?? target.tag}\` · port ${target.port}\n\n\`${target.cwd}\`\n\n` +
          `_Click to pick a different browser tab._`,
      );
    } else {
      status.text = "$(radio-tower) aiui: pick tab";
      status.tooltip = "aiui — pick the browser tab to send selections to";
    }
    status.show();
  }

  const workspaceDir = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  /**
   * One QuickPick over every channel's intent panels, grouped per channel — always
   * built from a fresh registry read + live peer queries at the moment it
   * opens (nothing to refresh by hand; `aiui: Refresh Browser Tabs` exists
   * for the status bar's sake, not the picker's).
   */
  async function pickBrowserTab(): Promise<Target | undefined> {
    const channels = listChannels({ workspaceDir: workspaceDir() });
    if (channels.length === 0) {
      void vscode.window.showWarningMessage(
        "aiui: no running channel servers found — launch `aiui claude` first.",
      );
      return undefined;
    }
    const agents = await claudeSessionNames();
    type TabItem = vscode.QuickPickItem & { target?: Target };
    const items: TabItem[] = [];
    for (const channel of channels) {
      items.push({
        label: `${channelTitle(channel, agents)} — ${channel.cwd}`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      let tabs: SessionPeer[];
      try {
        tabs = await selectionTargets(channel);
      } catch {
        items.push({
          label: "$(warning) channel unreachable",
          description: `port ${channel.port}`,
        });
        continue;
      }
      if (tabs.length === 0) {
        items.push({
          label: "$(circle-slash) no intent panels connected",
          description: "open an aiui app page connected to this channel",
        });
        continue;
      }
      for (const peer of tabs) {
        items.push({
          label: `$(browser) ${peerLabel(peer)}`,
          description: peer.url,
          target: targetFor(channel, peer, agents),
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "aiui: pick the browser tab to send selections to",
      matchOnDescription: true,
    });
    if (picked?.target) {
      await setTarget(picked.target);
      return picked.target;
    }
    return undefined;
  }

  /**
   * The target to send to: the remembered one, else — when exactly one tab
   * exists anywhere and it belongs to a real session — that tab (silently),
   * else whatever the picker returns. A debug server's tab is never a silent
   * default: it stays a deliberate, marked pick.
   */
  async function resolveTarget(): Promise<Target | undefined> {
    const remembered = getTarget();
    if (remembered) {
      return remembered;
    }
    const channels = listChannels({ workspaceDir: workspaceDir() });
    const agents = await claudeSessionNames();
    const found: Target[] = [];
    for (const channel of channels) {
      const tabs = await selectionTargets(channel).catch(() => []);
      found.push(...tabs.map((peer) => targetFor(channel, peer, agents)));
    }
    if (found.length === 1 && found[0] && found[0].debug !== true) {
      await setTarget(found[0]);
      return found[0];
    }
    return pickBrowserTab();
  }

  /** Explain a stale target once, drop it, and leave the picker one click away. */
  async function dropStale(target: Target, stale: Stale): Promise<void> {
    const detail =
      stale.reason === "channel-gone"
        ? `its channel (port ${target.port}) is not running anymore`
        : "the tab is no longer connected";
    void vscode.window.showWarningMessage(
      `aiui: "${target.label}" — ${detail}. Pick a browser tab again.`,
    );
    await setTarget(undefined);
  }

  async function sendSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("aiui: nothing selected.");
      return;
    }
    const resolved = await resolveTarget();
    if (!resolved) {
      return; // the picker already explained itself
    }
    // Send-time revalidation: a channel reload re-ids the tab; re-bind
    // silently rather than failing a send at the very moment it was wanted.
    const live = await revalidateTarget(resolved);
    if ("reason" in live) {
      await dropStale(resolved, live);
      return;
    }
    if (live.clientId !== resolved.clientId || live.label !== resolved.label) {
      await setTarget(live);
    }
    const document = editor.document;
    const sel = editor.selection;
    const file = vscode.workspace.asRelativePath(document.uri, false).replaceAll("\\", "/");
    const contribution = selectionToContribution(
      {
        file,
        text: document.getText(sel),
        startLine: sel.start.line,
        startCharacter: sel.start.character,
        endLine: sel.end.line,
        endCharacter: sel.end.character,
      },
      selectionUrl(document.uri, sel.start.line + 1, sel.start.character + 1),
    );
    try {
      const result = await publishSelection(live.port, live.clientId, contribution);
      if (result.ok) {
        void vscode.window.showInformationMessage(`aiui: selection sent to ${live.label}.`);
      } else {
        // Revalidated a moment ago and still nacked — a genuine race; let the
        // server's reason through.
        void vscode.window.showWarningMessage(
          `aiui: not delivered — ${result.error ?? "no view matched"}. Pick a browser tab again.`,
        );
        await setTarget(undefined);
      }
    } catch (err) {
      void vscode.window.showWarningMessage(
        `aiui: channel unreachable (${err instanceof Error ? err.message : String(err)}). Pick a browser tab again.`,
      );
      await setTarget(undefined);
    }
  }

  /** Revalidate the remembered tab and repaint the status bar, quietly. */
  async function refreshTabs(): Promise<void> {
    const target = getTarget();
    if (target) {
      const live = await revalidateTarget(target);
      if ("reason" in live) {
        await dropStale(target, live);
      } else {
        await setTarget(live);
      }
    } else {
      renderStatus();
    }
    const tabCount = (
      await Promise.all(
        listChannels({ workspaceDir: workspaceDir() }).map((c) =>
          selectionTargets(c).catch(() => []),
        ),
      )
    ).flat().length;
    vscode.window.setStatusBarMessage(`aiui: ${tabCount} browser tab(s) connected`, 3000);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("aiui.pickBrowserTab", () => pickBrowserTab()),
    vscode.commands.registerCommand("aiui.sendSelection", () => sendSelection()),
    vscode.commands.registerCommand("aiui.refreshTabs", () => refreshTabs()),
  );
  renderStatus();
}
