/**
 * stt.ts — the credential side of both STT engine flavors (the coming
 * `aiui-stt` component's seam; see docs/proposals/aiui-stt.md). Its contract
 * with this module is "give me something I can open a socket with" — nothing
 * more.
 *
 * **The DEFAULT engine is ElevenLabs Scribe** ({@link scribeConnectUrl}) —
 * the stack-wide decision (the aiui-stt proposal's primary engine; the intent
 * pipeline's `DEFAULT_INTENT_CONFIG.transcriber`): word timestamps + logprobs
 * make it the richest engine. The OpenAI `transcription`-type flavor
 * ({@link transcriptionKeySource}) is the ALTERNATE, for apps that want one
 * vendor or `ek_` semantics.
 *
 * Two species, deliberately different shapes (D4 — species semantics are API
 * shape, not documentation):
 *
 *  - ElevenLabs scribe tokens are SINGLE-USE (dead at first connect, fixed
 *    15-minute mint-to-connect TTL). {@link scribeConnectUrl} is one call =
 *    one connect; no caching surface exists here or in the kit, so a future
 *    reader cannot hold a token wrong.
 *  - OpenAI `transcription`-type client secrets are ordinary `ek_`s — one
 *    opens multiple sessions until TTL — so {@link transcriptionKeySource}
 *    is a {@link KeySource} like any other, correct under `cachingKeySource`.
 */
import type { KeySource, OracleCredential } from "@habemus-papadum/aiui-oracle";
import {
  connectUrl,
  ELEVENLABS_CREDENTIALS_PATH,
  type ScribeSocketOptions,
} from "@habemus-papadum/cf-creds-elevenlabs";
import { type FederatedMintOptions, federatedKeySource } from "./oracle";
import { type BrokerOptions, brokerRoute } from "./shared";

/**
 * The ALTERNATE (OpenAI) flavor's default transcription model — the channel's
 * proven whisper (`aiui-claude-channel/src/realtime.ts`). This is an OpenAI
 * model id inside an OpenAI mint; it cannot name the default engine's model
 * (Scribe's `scribe_v2_realtime` rides {@link scribeConnectUrl}'s socket URL).
 */
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

export interface ScribeConnectOptions extends BrokerOptions, ScribeSocketOptions {}

/**
 * A ready-to-open scribe WebSocket URL: fresh single-use token from the
 * broker route, then the vendor socket URL with the token riding the query
 * param (browsers can't set WebSocket headers). Call immediately before
 * EVERY connect — the token dies at first use; there is nothing to reuse.
 */
export function scribeConnectUrl(options: ScribeConnectOptions = {}): Promise<string> {
  const { brokerUrl, ...socket } = options;
  return connectUrl(brokerRoute(ELEVENLABS_CREDENTIALS_PATH, brokerUrl), socket);
}

export interface TranscriptionKeySourceOptions extends FederatedMintOptions {
  /** Baked into the minted secret's session config. Default
   * {@link DEFAULT_TRANSCRIPTION_MODEL}. */
  transcriptionModel?: string;
}

/**
 * A {@link KeySource} whose minted secrets carry a `transcription`-type
 * session config — the mint-attached config applies to sessions the `ek_`
 * opens, so the socket connects with a bare URL. A caller-supplied session
 * config is spread over the default (its `audio` block, when present,
 * replaces the default's whole); the session TYPE is this source's one
 * non-negotiable fact.
 */
export function transcriptionKeySource(options: TranscriptionKeySourceOptions): KeySource {
  const inner = federatedKeySource(options);
  return {
    describe: () => "cf-federation:transcription",
    async credential(session): Promise<OracleCredential> {
      const base = {
        audio: {
          input: {
            transcription: {
              model: options.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL,
            },
          },
        },
      };
      const minted = await inner.credential({ ...base, ...session, type: "transcription" });
      return { ...minted, source: "cf-federation:transcription" };
    },
  };
}
