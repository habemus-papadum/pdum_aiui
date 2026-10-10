/**
 * The sidecar contract — the types a host that mounts sidecars on an Express
 * app hands them and gets back. The client-serving helper for sidecars with a
 * web surface is the separate `./web-surface` entry (it imports Vite lazily,
 * so this main entry never pulls it).
 *
 * @packageDocumentation
 */

export type { MountedSidecar, Sidecar, SidecarContext } from "./sidecar.ts";
