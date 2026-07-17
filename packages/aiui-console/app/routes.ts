/**
 * The console's own routes and the sibling surfaces it links to. All
 * same-origin absolute paths (the console rides the channel's one port), so a
 * link is just an `href` — no port, no origin, no discovery.
 *
 * `CONSOLE_PREFIX` is duplicated from the sidecar (Node) deliberately: the
 * browser app must not import the Node sidecar module, and a one-line constant
 * is cheaper than a shared package just to hold a string. Keep them in step.
 */

/** Where the console app is mounted (mirrors the sidecar's `CONSOLE_PREFIX`). */
export const CONSOLE_PREFIX = "/__aiui";

/** The dashboard (the app's home route). */
export const CONSOLE_HOME_PATH = `${CONSOLE_PREFIX}/`;
/** The trace debugger (a client-side route in this same app). */
export const CONSOLE_DEBUG_PATH = `${CONSOLE_PREFIX}/debug`;

/** The remote pencil client, served by the pencil sidecar. */
export const PENCIL_PATH = "/pencil/";
/** The standalone intent panel, served by the intent sidecar. */
export const INTENT_PATH = "/intent/";
