import { browserVendorKey } from "@habemus-papadum/aiui-viz/vendor-keys";
import {
  connectUrl,
  ELEVENLABS_CREDENTIALS_PATH,
  mintScribeToken,
  type ScribeSocketOptions,
  scribeSocketUrl,
} from "@habemus-papadum/cf-creds-elevenlabs";
import { type BrokerOptions, brokerRoute } from "./shared";

export interface ScribeConnectOptions extends BrokerOptions, ScribeSocketOptions {}

/**
 * A ready-to-open scribe WebSocket URL: fresh single-use token from the
 * broker route, then the vendor socket URL with the token riding the query
 * param (browsers can't set WebSocket headers). Call immediately before
 * EVERY connect — the token dies at first use; there is nothing to reuse.
 */
export function scribeConnectUrl(options: ScribeConnectOptions = {}): Promise<string> {
  const { brokerUrl, key, ...socket } = options;
  return connectUrl(brokerRoute(ELEVENLABS_CREDENTIALS_PATH, brokerUrl, key), socket);
}

/** Demo composition: pasted key → dev key → explicitly configured broker.
 * Resolve afresh for EVERY connect; never persist a single-use token. */
export async function standardScribeConnectUrl(
  options: ScribeConnectOptions & { apiKey?: () => string | undefined } = {},
): Promise<string> {
  const { apiKey, ...broker } = options;
  const key = apiKey ? apiKey() : browserVendorKey("elevenlabs");
  if (key) {
    const minted = await mintScribeToken(key);
    return scribeSocketUrl(minted.token, broker);
  }
  if (!broker.brokerUrl && !broker.key)
    throw new Error("Add an ElevenLabs key or configure a credential broker");
  return scribeConnectUrl(broker);
}
