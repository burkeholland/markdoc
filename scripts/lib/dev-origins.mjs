// Hosts a browser may use to reach a dev server on this machine besides localhost. The machine
// name is the stable LAN identity; numeric interface addresses remain available as diagnostics.
import os from "node:os";

const VIRTUAL_INTERFACE = /\b(?:wsl|hyper-v|vethernet|virtual|vmware|virtualbox|docker|default switch)\b/i;

// Loopback spellings other than `localhost` (the only one Next exempts itself). Next compares
// `new URL(origin).hostname`, which keeps the IPv6 brackets, so the entry is `[::1]`, not `::1`.
const LOOPBACK_LITERALS = ["127.0.0.1", "[::1]"];

function compareText(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function addressKey(address) {
  return address
    .split(".")
    .map((part) => part.padStart(3, "0"))
    .join(".");
}

/** Bare machine name followed by its mDNS alias. A `.local` input still selects the bare name. */
export function stableHostnames(hostname = os.hostname()) {
  let canonical = String(hostname ?? "").trim().replace(/\.+$/, "");
  if (canonical.toLowerCase().endsWith(".local")) canonical = canonical.slice(0, -".local".length);
  if (!canonical) return ["localhost"];
  return [canonical, `${canonical}.local`];
}

/** Non-internal IPv4 interfaces, physical first and then virtual, with deterministic ordering. */
export function lanAddressDetails(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      out.push({
        address: entry.address,
        interfaceName,
        virtual: VIRTUAL_INTERFACE.test(interfaceName),
      });
    }
  }
  out.sort(
    (a, b) =>
      Number(a.virtual) - Number(b.virtual) ||
      compareText(a.interfaceName, b.interfaceName) ||
      compareText(addressKey(a.address), addressKey(b.address)),
  );
  return out.filter((entry, index) => out.findIndex((candidate) => candidate.address === entry.address) === index);
}

/** Non-internal IPv4 addresses of this machine in physical-before-virtual diagnostic order. */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  return lanAddressDetails(interfaces).map((entry) => entry.address);
}

/** Stable and diagnostic URLs shown by the custom server and covered by the LAN regression. */
export function localAccess(port, options = {}) {
  const [canonicalHost, ...aliasHosts] = stableHostnames(options.hostname ?? os.hostname());
  const details = lanAddressDetails(options.interfaces ?? os.networkInterfaces());
  return {
    canonicalHost,
    canonicalUrl: `http://${canonicalHost}:${port}`,
    aliases: aliasHosts.map((host) => ({ host, url: `http://${host}:${port}` })),
    numeric: details.map((entry) => ({ ...entry, url: `http://${entry.address}:${port}` })),
  };
}

/** Hostnames (no ports) for `allowedDevOrigins`, de-duplicated and lower-cased. */
export function devOrigins(options = {}) {
  const names = [
    ...lanAddresses(options.interfaces ?? os.networkInterfaces()),
    ...stableHostnames(options.hostname ?? os.hostname()),
    ...LOOPBACK_LITERALS,
  ];
  for (const extra of (options.extras ?? process.env.ALLOWED_DEV_ORIGINS ?? "").split(",")) {
    if (extra.trim()) names.push(extra.trim());
  }
  return [...new Set(names.map((n) => n.toLowerCase()))];
}
