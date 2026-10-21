/** Shared credential-service location and grant selection.
 * Routes are relative unless brokerUrl supplies a service origin.
 * Provider identifiers come from the response, not this package. */
import { type CredentialManager, credentialsUrl } from "@habemus-papadum/cf-browser-credentials";
import {
  AWS_CREDENTIALS_PATH,
  type AwsCredentials,
  createAwsCredentialManager,
} from "@habemus-papadum/cf-creds-aws";

export interface BrokerOptions {
  /** Credential-service origin. Omit it to use same-origin routes. */
  brokerUrl?: string;
  /** Public grant path. The service authorizes it against the caller's identity. */
  grantPath?: string;
}

/** Build a credential route with the released browser SDK's grant-path contract. */
export function brokerRoute(path: string, brokerUrl?: string, grantPath?: string): string {
  return credentialsUrl(path, { base: brokerUrl, grantPath });
}

export interface BrokerAwsManagerOptions extends BrokerOptions {
  /** Refresh this long before expiration (the kit's default: 10 minutes). */
  refreshMarginMs?: number;
}

/**
 * The app's AWS credential manager, on the conventional broker route. Session
 * credentials: cached, margin-refreshed, rotation-observable. An app composing
 * several bridge pieces (`/oracle` + `/mosaic`, say) should create ONE and
 * pass it to each — every `manager?` option here exists for that reuse.
 */
export function brokerAwsManager(
  options: BrokerAwsManagerOptions = {},
): CredentialManager<AwsCredentials> {
  return createAwsCredentialManager({
    url: brokerRoute(AWS_CREDENTIALS_PATH, options.brokerUrl, options.grantPath),
    refreshMarginMs: options.refreshMarginMs,
  });
}
