/**
 * mosaic.ts — the credential-installing Mosaic connector for broker-fronted
 * S3 data.
 *
 * The kit's `credentialAwareConnector` does the real work: every query —
 * including SQL Mosaic generates on its own for brushes and linked
 * selections — first ensures the manager's current AWS credentials are
 * installed in DuckDB (`CREATE OR REPLACE SECRET`, `SET s3_*` fallback),
 * because DuckDB stores credential STRINGS, not provider callbacks. Views
 * survive rotation: they hold S3 paths, never credentials.
 *
 * This module only adapts the shape to how aiui apps already build their
 * data layer: the app constructs its own base connector (seismos:
 * `wasmConnector({ duckdb, connection })` over aiui-viz's
 * `instantiateDuckDB`) and hands the wrapped result to the coordinator it
 * already owns. `MosaicView` never learns credentials exist — "the page
 * dials nothing; connectivity arrives from OUTSIDE" stays intact.
 */
import type { CredentialManager } from "@habemus-papadum/cf-browser-credentials";
import type { AwsCredentials } from "@habemus-papadum/cf-creds-aws";
import {
  type CredentialAwareOptions,
  credentialAwareConnector,
} from "@habemus-papadum/cf-creds-mosaic";
import type { Connector } from "@uwdata/mosaic-core";
import { type BrokerOptions, brokerAwsManager } from "./shared";

export type { InstallMode } from "@habemus-papadum/cf-creds-mosaic";

export interface BrokerConnectorOptions extends BrokerOptions, CredentialAwareOptions {
  /** Reuse the app's manager; default constructs one against `brokerUrl`
   * (and `key`, when the broker speaks the key contract). */
  manager?: CredentialManager<AwsCredentials>;
  /** The S3 region installed with each credential set. With `key` it rides
   * the broker's envelope and this override is unnecessary; without one it
   * stays a baked per-deployment fact (D3), like the bucket endpoint the
   * app already owns. */
  region?: string;
}

/**
 * Wrap the app's base connector so every query runs with current broker
 * credentials installed. Compose at the app's data-layer root:
 *
 * ```ts
 * coordinator.databaseConnector(
 *   brokerConnector(wasmConnector({ duckdb: db, connection }), { key: "app" }),
 * );
 * ```
 */
export function brokerConnector(base: Connector, options: BrokerConnectorOptions = {}): Connector {
  const { manager, brokerUrl, key, ...aware } = options;
  return credentialAwareConnector(base, manager ?? brokerAwsManager({ brokerUrl, key }), aware);
}
