import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Plugin } from "vite";

/** Choose an advertised address without restricting which interfaces Vite listens on. */
export function ipadUrl(): Plugin {
  return {
    name: "pencil-ipad-url",
    async configureServer(server) {
      const host = server.config.server.host;
      // Leave explicit bindings (including Playwright's loopback server) to Vite.
      if (host !== true && host !== "0.0.0.0" && host !== "::") return;

      const addresses = Object.entries(networkInterfaces())
        .flatMap(([name, entries]) =>
          (entries ?? [])
            .filter((entry) => !entry.internal && entry.family === "IPv4")
            .map((entry) => ({ name, address: entry.address })),
        )
        // Prefer Ethernet/Wi-Fi over tunnels and virtual adapters, but offer all of them.
        .sort(
          (a, b) =>
            Number(/^(en\d|eth|wlan|wlp)/.test(b.name)) -
            Number(/^(en\d|eth|wlan|wlp)/.test(a.name)),
        );

      const requested = process.env.LAB_INTERFACE;
      let selected: { name: string; address: string } | undefined = addresses[0];
      if (requested) {
        selected = addresses.find(
          (entry) => entry.name === requested || entry.address === requested,
        );
        if (!selected) {
          throw new Error(
            `LAB_INTERFACE=${requested} has no active IPv4 address. Available: ${
              addresses.map((entry) => `${entry.name} (${entry.address})`).join(", ") || "none"
            }`,
          );
        }
      } else if (addresses.length > 1 && process.stdin.isTTY && process.stdout.isTTY) {
        console.log("\nChoose the network shared with your iPad:");
        addresses.forEach((entry, index) => {
          console.log(`  ${index + 1}. ${entry.name.padEnd(12)} ${entry.address}`);
        });
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          for (;;) {
            const answer = (await prompt.question("Interface [1]: ")).trim();
            const index = answer === "" ? 0 : /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
            if (addresses[index]) {
              selected = addresses[index];
              break;
            }
            console.log(`Enter a number from 1 to ${addresses.length}.`);
          }
        } finally {
          prompt.close();
        }
      }

      server.printUrls = () => {
        for (const url of server.resolvedUrls?.local ?? []) {
          server.config.logger.info(`  Local: ${url}`);
        }
        const url = server.resolvedUrls?.network.find(
          (url) => new URL(url).hostname === selected?.address,
        );
        if (selected && url) {
          server.config.logger.info(`\n  iPad (${selected.name}): ${url}\n`);
          server.config.logger.info("  Copy the URL and paste it into Safari on your iPad.");
          server.config.logger.info(`  Next time: LAB_INTERFACE=${selected.name} pnpm lab\n`);
        } else {
          server.config.logger.warn(
            "  No IPv4 iPad URL available. Connect to Wi-Fi and restart the lab.",
          );
        }
      };
    },
  };
}
