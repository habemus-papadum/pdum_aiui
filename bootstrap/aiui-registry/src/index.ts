/**
 * @habemus-papadum/aiui-registry — the aiui channel registry, single-sourced.
 *
 * On-disk entry schema (v2), atomic write API, liveness with recycled-pid
 * detection, the enriched channel listing every consumer surface returns, the
 * shared `claude agents` cache, and the native-messaging host built on all of
 * it. This package is the cross-process protocol between independently
 * installed aiui versions — see docs/proposals/aiui-registry.md in the
 * pdum_aiui repo.
 *
 * @packageDocumentation
 */

export * from "./agents.ts";
export * from "./cache.ts";
export * from "./host.ts";
export * from "./host-binary.ts";
export * from "./list.ts";
export * from "./liveness.ts";
export * from "./paths.ts";
export * from "./rank.ts";
export * from "./read.ts";
export * from "./types.ts";
export * from "./write.ts";
