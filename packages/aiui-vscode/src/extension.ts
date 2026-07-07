/**
 * The VS Code extension host entry: a status-bar item showing which browser
 * tab this window sends selections to (click to change, like the git branch
 * picker), and the `aiui: Send Selection to Browser Tab` command.
 *
 * Everything that doesn't need the `vscode` module lives in channels.ts and
 * contribution.ts; this file is the thin host glue. build-extension.mjs
 * bundles it to CJS for the .vsix — the npm artifact ships only the library
 * (index.ts), whose build never includes this file's `vscode` import.
 */
import * as vscode from "vscode";
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
}

const TARGET_KEY = "aiui.target";

/** A short human name for a peer (title, else URL, else id). */
function peerLabel(peer: SessionPeer): string {
  return peer.label ?? peer.url ?? peer.clientId;
}

/** A channel's browser tabs that can ingest a selection (the overlay hosts). */
async function appTabs(channel: ChannelEntry): Promise<SessionPeer[]> {
  const { peers } = await fetchPeers(channel.port);
  return peers.filter((p) => p.role === "app");
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
          `channel \`${target.tag}\` · port ${target.port}\n\n\`${target.cwd}\`\n\n` +
          `_Click to pick a different browser tab._`,
      );
    } else {
      status.text = "$(radio-tower) aiui: pick tab";
      status.tooltip = "aiui — pick the browser tab to send selections to";
    }
    status.show();
  }

  const workspaceDir = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  /** One QuickPick over every channel's app tabs, grouped per channel. */
  async function pickBrowserTab(): Promise<Target | undefined> {
    const channels = listChannels({ workspaceDir: workspaceDir() });
    if (channels.length === 0) {
      void vscode.window.showWarningMessage(
        "aiui: no running channel servers found — launch `aiui claude` first.",
      );
      return undefined;
    }
    type TabItem = vscode.QuickPickItem & { target?: Target };
    const items: TabItem[] = [];
    for (const channel of channels) {
      items.push({
        label: `${channel.tag} — ${channel.cwd}`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      let tabs: SessionPeer[];
      try {
        tabs = await appTabs(channel);
      } catch {
        items.push({
          label: "$(warning) channel unreachable",
          description: `port ${channel.port}`,
        });
        continue;
      }
      if (tabs.length === 0) {
        items.push({
          label: "$(circle-slash) no overlay tabs connected",
          description: "open the app with the dev overlay mounted",
        });
        continue;
      }
      for (const peer of tabs) {
        items.push({
          label: `$(browser) ${peerLabel(peer)}`,
          description: peer.url,
          target: {
            port: channel.port,
            tag: channel.tag,
            cwd: channel.cwd,
            clientId: peer.clientId,
            label: peerLabel(peer),
            ...(peer.url !== undefined ? { url: peer.url } : {}),
          },
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
   * exists anywhere — that tab (silently), else whatever the picker returns.
   */
  async function resolveTarget(): Promise<Target | undefined> {
    const remembered = getTarget();
    if (remembered) {
      return remembered;
    }
    const channels = listChannels({ workspaceDir: workspaceDir() });
    const found: Target[] = [];
    for (const channel of channels) {
      const tabs = await appTabs(channel).catch(() => []);
      found.push(
        ...tabs.map((peer) => ({
          port: channel.port,
          tag: channel.tag,
          cwd: channel.cwd,
          clientId: peer.clientId,
          label: peerLabel(peer),
          ...(peer.url !== undefined ? { url: peer.url } : {}),
        })),
      );
    }
    if (found.length === 1 && found[0]) {
      await setTarget(found[0]);
      return found[0];
    }
    return pickBrowserTab();
  }

  async function sendSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("aiui: nothing selected.");
      return;
    }
    const target = await resolveTarget();
    if (!target) {
      return; // the picker already explained itself
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
      `vscode://file/${document.uri.fsPath}:${sel.start.line + 1}:${sel.start.character + 1}`,
    );
    try {
      const result = await publishSelection(target.port, target.clientId, contribution);
      if (result.ok) {
        void vscode.window.showInformationMessage(`aiui: selection sent to ${target.label}.`);
      } else {
        // The tab went away (or was never reachable): let the ack's reason
        // through and make the stale pick obvious.
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

  context.subscriptions.push(
    vscode.commands.registerCommand("aiui.pickBrowserTab", () => pickBrowserTab()),
    vscode.commands.registerCommand("aiui.sendSelection", () => sendSelection()),
  );
  renderStatus();
}
