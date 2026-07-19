/**
 * target-tab.tsx — the "aimed at" chip: which real tab the panel is driving.
 *
 * The standalone CDP panel is a separate PAGE, so when it shoots/ink/selects
 * it lands on some OTHER tab — and the only existing "which tab" signal, the
 * injected ring, lives in that other tab where you cannot see it while looking
 * at the panel. This chip names the leader tab in the panel itself: favicon +
 * short host + title, live on every leader change. Pure display — the leader
 * is chosen by the host's targeting (visibility/focus), never by this widget.
 *
 * It reads only the `SurfaceTargeting` seam every tier exposes
 * (`activeTab` + `onActiveTabChange` + optional `tabInfo`), so it is
 * host-agnostic; it renders nothing when the host cannot identify tabs
 * (`tabInfo` absent — the fake tier has no real page to name).
 */

import { createSignal, onCleanup, Show } from "solid-js";
import type { PageEvent, SurfaceTargeting } from "../transport";

export const TARGET_TAB_STYLES = `
  .aiui-target { margin: 6px 12px 0; font: 12px system-ui; display: flex; }
  .aiui-target-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    background: color-mix(in srgb, currentColor 5%, transparent); }
  .aiui-target-eye { opacity: 0.5; font-size: 11px; }
  .aiui-target-fav { width: 14px; height: 14px; border-radius: 3px; flex: none; }
  .aiui-target-host { font-weight: 600; white-space: nowrap; }
  .aiui-target-title { opacity: 0.6; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; min-width: 0; }
  .aiui-target-none { opacity: 0.5; }
  .aiui-target-id { opacity: 0.4; font-size: 10px; font-variant-numeric: tabular-nums; }
`;

/** host of a URL, or the scheme-y stand-in for a non-http page (fake://, about:). */
function shortHost(url: string | undefined): string | undefined {
  if (url === undefined || url === "") {
    return undefined;
  }
  try {
    const u = new URL(url);
    return u.host !== "" ? u.host : `${u.protocol}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The site's own favicon, best-effort — no third-party service, hidden on error. */
function faviconOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    const u = new URL(url);
    return u.protocol.startsWith("http") ? new URL("/favicon.ico", u.origin).href : undefined;
  } catch {
    return undefined;
  }
}

export function TargetTab(props: {
  targeting: SurfaceTargeting;
  /** The transport's page-event feed (optional): a same-tab `navigation` on
   * the leader refreshes the chip, so an SPA route change or reload shows up
   * without a tab switch — the same signal the turn's navigation events ride. */
  onPageEvent?: (handler: (event: PageEvent) => void) => () => void;
}) {
  const [tab, setTab] = createSignal<number | undefined>(props.targeting.activeTab(), {
    ownedWrite: true,
  });
  const [info, setInfo] = createSignal<{ url?: string; title?: string } | undefined>(undefined, {
    ownedWrite: true,
  });
  const [favBroken, setFavBroken] = createSignal(false, { ownedWrite: true });

  /** The leader an in-flight `tabInfo` was requested for — a plain variable
   * (not the signal) so the stale-win guard is an untracked comparison. */
  let want: number | undefined = props.targeting.activeTab();

  /** Refresh identity for the current leader; guard against a stale async win. */
  const load = (which: number | undefined): void => {
    want = which;
    setFavBroken(false);
    if (which === undefined || props.targeting.tabInfo === undefined) {
      setInfo(undefined);
      return;
    }
    void props.targeting.tabInfo(which).then((got) => {
      if (want === which) {
        setInfo(got);
      }
    });
  };

  load(want);
  const off = props.targeting.onActiveTabChange((next) => {
    setTab(next);
    load(next);
  });
  onCleanup(off);
  if (props.onPageEvent !== undefined) {
    const offNav = props.onPageEvent((event) => {
      if (event.kind === "navigation" && event.tab === want) {
        load(want); // the leader navigated in place — re-read its identity
      }
    });
    onCleanup(offNav);
  }

  const host = () => shortHost(info()?.url);
  const favicon = () => (favBroken() ? undefined : faviconOf(info()?.url));

  return (
    <Show when={props.targeting.tabInfo !== undefined}>
      <div class="aiui-target" data-testid="target-tab">
        <span class="aiui-target-chip" title="the tab this panel is driving (shots land here)">
          <span class="aiui-target-eye">👁</span>
          <Show when={favicon()}>
            {(src) => (
              <img class="aiui-target-fav" src={src()} alt="" onError={() => setFavBroken(true)} />
            )}
          </Show>
          <Show
            when={tab() !== undefined}
            fallback={<span class="aiui-target-none">no tab in view</span>}
          >
            <span class="aiui-target-host">{host() ?? "(unknown page)"}</span>
            <Show when={info()?.title}>
              <span class="aiui-target-title">{info()?.title}</span>
            </Show>
            <span class="aiui-target-id">#{tab()}</span>
          </Show>
        </span>
      </div>
    </Show>
  );
}
