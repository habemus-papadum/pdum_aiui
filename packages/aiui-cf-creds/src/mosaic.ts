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
 * data layer: the app constructs its own base connector (seismos: aiui-viz's
 * `duckdbConnector({ duckdb, connection })` over its `instantiateDuckDB`)
 * and hands the wrapped result to the coordinator it
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

/** The two operations used at the query boundary. The app owns authentication,
 * caching, renewal and disposal; a concrete CredentialManager is optional. */
export type AwsCredentialSource = Pick<CredentialManager<AwsCredentials>, "get" | "refresh">;

export interface BrokerConnectorOptions extends BrokerOptions, CredentialAwareOptions {
  /** Use the app's credential source. When omitted, construct a manager against
   * `brokerUrl` and the grant selected by `grantPath`. */
  manager?: AwsCredentialSource;
  /** The S3 region installed with each credential set. Use the region from the credential response
   * by default. Set this only to override it. */
  region?: string;
}

/**
 * Wrap the app's base connector so every query runs with current broker
 * credentials installed. Compose at the app's data-layer root:
 *
 * ```ts
 * coordinator.databaseConnector(
 *   brokerConnector(duckdbConnector({ duckdb: db, connection }), { grantPath: "app" }),
 * );
 * ```
 */
export function brokerConnector(base: Connector, options: BrokerConnectorOptions = {}): Connector {
  const { manager, brokerUrl, grantPath, ...aware } = options;
  const source = manager ?? brokerAwsManager({ brokerUrl, grantPath });
  // cf-creds-mosaic 0.7 declares a concrete manager, but its runtime calls only
  // get/refresh. Keep this assertion at that boundary until the dependency's
  // declarations accept the structural source; no manager state is accessed.
  return credentialAwareConnector(
    base,
    source as Parameters<typeof credentialAwareConnector>[1],
    aware,
  );
}
