/**
 * The machine's LAN-facing network interfaces — the addresses a host-bound
 * channel (`0.0.0.0`) is actually reachable on from another device (an iPad on
 * the same Wi-Fi). Surfaced on `/health` so the console dashboard can offer a
 * copy button per interface instead of guessing which one an iPad shares.
 *
 * Only non-internal IPv4 is returned: loopback (`127.0.0.1`) is added by the
 * dashboard itself, and IPv6 link-local addresses aren't something you paste
 * into Safari. The order is whatever the OS reports.
 */
import { networkInterfaces } from "node:os";

export interface LanInterface {
  /** The OS interface name (`en0`, `eth0`, …) — the label the dashboard shows. */
  name: string;
  /** Its non-internal IPv4 address. */
  address: string;
}

/**
 * List the non-internal IPv4 interfaces. `ifaces` is injectable so the shape
 * can be unit-tested without depending on the test host's real network.
 */
export function listLanInterfaces(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push({ name, address: addr.address });
      }
    }
  }
  return out;
}
