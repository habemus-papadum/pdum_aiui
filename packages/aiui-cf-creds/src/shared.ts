/**
 * shared.ts — the one fact every bridge module shares: where the broker is.
 *
 * The kit's deployment shape gives the broker the `/api/credentials/*` path
 * prefix on the app's own origin (the static site owns everything else), so
 * in production no configuration exists — every route is same-origin relative.
 * The single knob is `brokerUrl`, the broker's ORIGIN, for the cross-origin
 * cases: `vite dev` on a loopback port talking to the deployed broker
 * (authenticated by the same Access cookie; the broker echoes CORS for
 * loopback origins only). Passing an origin rather than per-provider route
 * URLs keeps the composition root to one deployment fact — the kit's own
 * convention supplies the paths.
 *
 * NO deployment identity lives in this package (proposal D2): no hostname,
 * provider ID, or account fact outside test fixtures.
 */
import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import {
  AWS_CREDENTIALS_PATH,
  type AwsCredentials,
  createAwsCredentialManager,
} from "@habemus-papadum/cf-creds-aws";

export interface BrokerOptions {
  /**
   * The broker's origin (e.g. `https://app.example.test`) for cross-origin
   * dev. Default: absent — routes stay same-origin relative, the zero-config
   * production case. The kit's conventional `/api/credentials/*` paths are
   * appended; the broker owns that prefix by the kit's own contract.
   */
  brokerUrl?: string;
  /**
   * The app's OWN name under the broker's key contract (kit ≥0.4): the
   * broker maps `(key, identity)` to everything the page needs — role,
   * region, and for OpenAI the whole federation config — so no deployment
   * identity is baked anywhere. Rides every route as `?key=`. With a key,
   * per-provider ids stop being required; without one, the legacy explicit
   * options still work.
   */
  key?: string;
}

/** Resolve a conventional credential route against an optional broker origin,
 * appending the key-contract `?key=` when the app has one. */
export function brokerRoute(path: string, brokerUrl?: string, key?: string): string {
  const url = brokerUrl === undefined ? path : new URL(path, brokerUrl).toString();
  if (key === undefined) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}key=${encodeURIComponent(key)}`;
}

export interface BrokerAwsManagerOptions extends BrokerOptions {
  /** Refresh this long before expiration (the kit's default: 10 minutes). */
  refreshMarginMs?: number;
}

/**
 * The app's AWS credential manager, on the conventional broker route. Session
 * species: cached, margin-refreshed, rotation-observable. An app composing
 * several bridge pieces (`/oracle` + `/mosaic`, say) should create ONE and
 * pass it to each — every `manager?` option here exists for that reuse.
 */
export function brokerAwsManager(
  options: BrokerAwsManagerOptions = {},
): CredentialManager<AwsCredentials> {
  return createAwsCredentialManager({
    url: brokerRoute(AWS_CREDENTIALS_PATH, options.brokerUrl, options.key),
    refreshMarginMs: options.refreshMarginMs,
  });
}
