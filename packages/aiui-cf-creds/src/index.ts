/**
 * @habemus-papadum/aiui-cf-creds — broker-backed ephemeral credentials for
 * aiui apps: adapters from the `cf_browser_credentials` kit
 * (`@habemus-papadum/cf-*`) to aiui's existing credential seams. A bridge in
 * the strict sense — it implements one contract against the other and adds no
 * seam of its own. Contract of record: the aiui-cf-creds proposal (pdum_aiui
 * git history).
 *
 * The target apps are serverless/static aiui deployments behind a
 * broker-fronted origin (a Cloudflare Worker owning `/api/credentials/*`,
 * both behind Cloudflare Access): a static page that mints its own
 * short-lived credentials with no vendor key existing anywhere.
 *
 * The bridges live on subpaths so each app pays only for what it uses:
 *
 *  - `aiui-cf-creds/oracle` — `federatedKeySource`: `ek_` client secrets
 *    minted browser-side over workload identity federation (no parent key).
 *  - `aiui-cf-creds/stt`    — both STT credential flavors: single-use scribe
 *    connect URLs and `transcription`-type `ek_` sources.
 *  - `aiui-cf-creds/mosaic` — `brokerConnector`: the app's Mosaic connector
 *    wrapped so every query runs with current credentials installed.
 *
 * This root holds only what the bridges share: the broker-origin convention,
 * the key-contract `key` option (kit ≥0.4 — the app names ITSELF and every
 * id rides the broker's mint response), and the app-wide AWS credential
 * manager (create ONE, pass it to each bridge's `manager` option).
 */
export type { BrokerAwsManagerOptions, BrokerOptions } from "./shared";
export { brokerAwsManager, brokerRoute } from "./shared";
