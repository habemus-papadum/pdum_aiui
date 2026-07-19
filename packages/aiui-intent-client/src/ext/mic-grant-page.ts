/**
 * mic-grant-page.ts — the script behind mic.html, the one-time microphone grant
 * page (see mic-grant.ts for why the side panel needs a proxy at all). This
 * page runs in a REAL TAB, which is what makes it able to show the prompt the
 * panel cannot; the grant it wins is keyed to the extension origin, so the
 * panel inherits it — `PermissionStatus.onchange` flips the open panel live.
 *
 * Asks on load (no gesture needed for a mic prompt) AND from the button, so a
 * dismissed prompt can be retried without reloading. A sticky DENIED cannot be
 * re-prompted at all — for that the settings button opens the extension's own
 * mic site-settings, the only place a denial can be undone.
 */

const TAG = "[mic]";

const statusEl = document.getElementById("status") as HTMLElement;
const enableButton = document.getElementById("enable") as HTMLButtonElement;
const settingsButton = document.getElementById("settings") as HTMLButtonElement;

settingsButton.onclick = () => {
  // chrome:// URLs can't be <a href>-ed, but an extension page may tabs.create
  // them — straight to THIS extension's mic row.
  void chrome.tabs.create({
    url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`,
  });
};

async function closeSelf(): Promise<void> {
  // window.close() is unreliable for a tab the user could have navigated;
  // the tabs API always works for our own tab.
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) {
    await chrome.tabs.remove(tab.id);
  } else {
    window.close();
  }
}

async function request(): Promise<void> {
  statusEl.textContent = "asking for the microphone…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    console.info(
      TAG,
      "grant page: getUserMedia succeeded — the grant is persisted for this origin; the panel picks it up live",
    );
    statusEl.textContent = "microphone enabled ✓ — closing…";
    enableButton.hidden = true;
    settingsButton.hidden = true;
    setTimeout(() => void closeSelf(), 1200);
  } catch (error) {
    const name = error instanceof Error ? error.name : String(error);
    console.info(TAG, `grant page: getUserMedia failed (${name})`);
    if (name === "NotAllowedError") {
      // Either the prompt was dismissed (retry works) or the mic is sticky-
      // DENIED for the extension (only settings can undo that) — offer both.
      statusEl.textContent = "not granted — retry, or open settings and allow the microphone";
      settingsButton.hidden = false;
    } else {
      statusEl.textContent = `microphone failed: ${name}`;
    }
  }
}

enableButton.onclick = () => void request();
void request();
