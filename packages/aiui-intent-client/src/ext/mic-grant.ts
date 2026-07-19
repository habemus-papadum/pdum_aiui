/**
 * mic-grant.ts — the extension tier's one-time microphone grant (M9's deferred
 * "options-page dance", built 2026-07-19 when the first non-flagged target — an
 * everyday Chrome — arrived).
 *
 * Why the mic needs this and screenshots never did: `tabCapture` is an
 * EXTENSION API, gated by the manifest permission + the invocation gesture, so
 * no site-permission prompt exists on that path. The mic is a SITE permission
 * keyed to this `chrome-extension://` origin — there is no MV3 manifest key for
 * it ("audioCapture" was Chrome Apps, not extensions) — and a side panel
 * document cannot render the permission prompt, so `getUserMedia` from the
 * panel just rejects. The remedy is origin-keyed persistence: grant it ONCE
 * from an extension page in a real tab (mic.html), and the side panel — same
 * origin — inherits it forever after.
 *
 * The startup probe below tells the two browsers apart with zero configuration:
 *
 *  - session browser (`--auto-accept-camera-and-microphone-capture`): the probe
 *    succeeds silently on every panel open (the flag auto-accepts PER CALL,
 *    nothing persists — measured, M9). No UI, no page, no dance.
 *  - stock Chrome, after the dance: `permissions.query` says "granted" — the
 *    probe is skipped entirely (no mic-indicator blip).
 *  - stock Chrome, before the dance: the probe rejects at once, and the grant
 *    page auto-opens. Answer the prompt there once and talk works from then on
 *    (`PermissionStatus.onchange` flips the panel live — no reload).
 *
 * Every pathway logs under `[mic]` so a console glance says which browser
 * situation this is.
 */

const TAG = "[mic]";

/** If the probe neither resolves nor rejects in this window, a REAL prompt is
 * probably showing (a promptable panel — some Chrome versions can) — say so
 * and keep waiting rather than opening a redundant grant page. */
const PROBE_PENDING_MS = 3000;

/** The seams, injectable for jsdom (which has neither mic nor permissions). */
export interface MicGrantEnv {
  /** `navigator.mediaDevices` — absent in jsdom. */
  media: Pick<MediaDevices, "getUserMedia"> | undefined;
  /** `navigator.permissions` — absent in older jsdom. */
  permissions: Pick<Permissions, "query"> | undefined;
  /** Open mic.html in a real tab (the promptable context). */
  openGrantPage: () => void;
}

const realEnv = (): MicGrantEnv => ({
  media: typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
  permissions: typeof navigator !== "undefined" ? navigator.permissions : undefined,
  openGrantPage: () => {
    console.info(
      TAG,
      "opening mic.html in a tab — extension TABS can show the prompt; the grant persists for this origin",
    );
    void chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
  },
});

export interface MicGrantHooks {
  /** Feeds `ctx.micGranted` — the mic pill's fact. */
  setGranted: (granted: boolean) => void;
  /** The panel-footer status line + toast, when the mic is unusable. */
  onBlocked: (message: string) => void;
}

/**
 * Probe the microphone on panel startup, and supervise the grant from then on.
 * Resolves when the initial verdict is in (the onchange listener keeps living).
 */
export async function superviseMicGrant(
  hooks: MicGrantHooks,
  env: MicGrantEnv = realEnv(),
): Promise<void> {
  // 1. The permission STATUS — free: no device touch, no prompt, no blip.
  let status: PermissionStatus | undefined;
  try {
    status = await env.permissions?.query({ name: "microphone" as PermissionName });
  } catch {
    // This browser's permissions.query doesn't know "microphone" — the probe
    // below still settles the question.
  }

  // 2. Track changes for the panel's whole life: the grant lands in the
  // mic.html TAB, and this fires HERE the moment it does — no reload needed.
  if (status !== undefined) {
    const tracked = status;
    tracked.onchange = () => {
      console.info(TAG, `permission state changed → "${tracked.state}"`);
      if (tracked.state === "granted") {
        console.info(
          TAG,
          "the grant dance completed — talk works from now on, and on every reopen",
        );
        hooks.setGranted(true);
      } else if (tracked.state === "denied") {
        hooks.setGranted(false);
        hooks.onBlocked("microphone DENIED for the extension — the grant page names the fix");
      }
    };
  }

  if (status?.state === "granted") {
    console.info(
      TAG,
      'state "granted" — a persisted grant from a previous dance; skipping the probe',
    );
    hooks.setGranted(true);
    return;
  }
  if (status?.state === "denied") {
    // A real prompt was refused earlier. The grant page cannot re-ask (denied
    // is sticky) — but it CAN open the extension's mic site-settings, so it is
    // still the one remedy surface.
    console.info(
      TAG,
      'state "denied" — the mic was refused for this extension; opening the grant page (it links site settings)',
    );
    hooks.setGranted(false);
    hooks.onBlocked("microphone denied for the extension — fix it in the opened tab");
    env.openGrantPage();
    return;
  }

  // 3. State "prompt" (or unknowable) — the ONE call that tells the browsers
  // apart. The flagged session browser auto-accepts it; a stock-Chrome side
  // panel cannot show the prompt and rejects it immediately.
  console.info(
    TAG,
    `state "${status?.state ?? "unknown"}" — probing getUserMedia (flagged session browser auto-accepts; a stock side panel rejects)`,
  );
  if (env.media?.getUserMedia === undefined) {
    console.info(TAG, "no mediaDevices here — nothing to probe (jsdom / stripped context)");
    return;
  }
  const probe: Promise<MediaStream | Error> = env.media.getUserMedia({ audio: true }).then(
    (stream) => stream,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  let verdict = await Promise.race([
    probe,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), PROBE_PENDING_MS)),
  ]);
  if (verdict === "pending") {
    // Neither outcome yet: a REAL prompt is probably on screen (this panel can
    // prompt after all). Don't open a redundant grant page — wait it out.
    console.info(
      TAG,
      "probe still pending after 3s — a real prompt may be showing; waiting for its answer",
    );
    verdict = await probe;
  }
  if (verdict instanceof Error) {
    console.info(
      TAG,
      `probe FAILED (${verdict.name}) — this side panel cannot show the mic prompt (stock Chrome); opening the grant page`,
    );
    hooks.setGranted(false);
    hooks.onBlocked(
      "microphone blocked in this browser — complete the one-time grant in the opened tab",
    );
    env.openGrantPage();
    return;
  }
  for (const track of verdict.getTracks()) {
    track.stop();
  }
  console.info(
    TAG,
    "probe SUCCEEDED with no persisted grant — the auto-accept flag (session browser), or a prompt answered live; mic is usable",
  );
  hooks.setGranted(true);
}
