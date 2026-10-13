import type { ProxyOptions } from "vite";

/** One path owner: target supplies the origin; rewrite adds the gateway prefix. */
export function gatewayProxy(gatewayUrl: string): Record<string, ProxyOptions> {
  const gateway = new URL(gatewayUrl);
  const prefix = gateway.pathname.replace(/\/$/, "");
  return {
    "^/api(?:/|\\?|$)": {
      // A target containing the prefix would prepend it again after rewrite.
      target: gateway.origin,
      rewrite: (path) => `${prefix}${path}`,
      changeOrigin: true,
    },
  };
}
