/**
 * Offscreen-document guard: MV3 allows exactly one offscreen document per
 * extension, and concurrent `createDocument` calls race. Single-flight +
 * existence check, factored from the capture-probe spike.
 */

let creating: Promise<void> | undefined;

/**
 * Ensure the extension's offscreen document exists. `url` is extension-relative
 * (e.g. `"src/offscreen/index.html"`). Safe to call from any context that has
 * the `offscreen` permission; concurrent calls share one creation.
 */
export async function ensureOffscreenDocument(
  url: string,
  reasons: chrome.offscreen.Reason[],
  justification: string,
): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) {
    return;
  }
  creating ??= chrome.offscreen.createDocument({ url, reasons, justification }).finally(() => {
    creating = undefined;
  });
  await creating;
}
