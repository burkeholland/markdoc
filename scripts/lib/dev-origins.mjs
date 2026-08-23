// Hosts a browser may use to reach a dev server on this machine besides localhost: every
// non-loopback IPv4 address, the machine name (Windows clients resolve it over the LAN) and
// anything listed in ALLOWED_DEV_ORIGINS (comma-separated). next.config.ts feeds this to
// `allowedDevOrigins`; the LAN e2e spec uses lanAddresses() to pick a host to test against.
import os from "node:os";

/** Non-internal IPv4 addresses of this machine (empty when only loopback is up). */
export function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) out.push(entry.address);
    }
  }
  return out;
}

/** Hostnames (no ports) for `allowedDevOrigins`, de-duplicated and lower-cased. */
export function devOrigins() {
  const names = [...lanAddresses(), os.hostname(), `${os.hostname()}.local`];
  for (const extra of (process.env.ALLOWED_DEV_ORIGINS ?? "").split(",")) {
    if (extra.trim()) names.push(extra.trim());
  }
  return [...new Set(names.map((n) => n.toLowerCase()))];
}
