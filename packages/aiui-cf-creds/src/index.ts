/**
 * Credential adapters for AIUI apps, backed by the cf_browser_credentials SDK.
 * OpenAI Realtime, ElevenLabs, Mosaic, and MotherDuck adapters have separate
 * subpaths. The root exports shared brokerUrl/grantPath options and an AWS
 * credential manager that callers can reuse across adapters.
 */
export type { BrokerAwsManagerOptions, BrokerOptions } from "./shared";
export { brokerAwsManager, brokerRoute } from "./shared";
