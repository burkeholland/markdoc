import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { devOrigins, lanAddressDetails, localAccess, stableHostnames } from "../scripts/lib/dev-origins.mjs";

const ipv4 = (address: string): NetworkInterfaceInfo => ({
  address,
  family: "IPv4",
  internal: false,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: `${address}/24`,
});

const interfaces = {
  "vEthernet (WSL)": [ipv4("172.30.96.1")],
  WiFi: [ipv4("192.168.100.71")],
  "Default Switch": [ipv4("172.18.32.1")],
  Loopback: [{ ...ipv4("127.0.0.1"), internal: true }],
};

describe("stable local access", () => {
  it.each(["SURF", "SURF.local", "SURF.local."])("keeps SURF canonical for %s", (hostname) => {
    const access = localAccess(3000, { hostname, interfaces });

    expect(access.canonicalHost).toBe("SURF");
    expect(access.canonicalUrl).toBe("http://SURF:3000");
    expect(access.aliases).toEqual([{ host: "SURF.local", url: "http://SURF.local:3000" }]);
  });

  it("keeps WSL and other virtual adapters out of canonical selection", () => {
    const access = localAccess(3000, { hostname: "SURF", interfaces });

    expect(access.canonicalUrl).toBe("http://SURF:3000");
    expect(access.numeric.map(({ address, virtual }) => ({ address, virtual }))).toEqual([
      { address: "192.168.100.71", virtual: false },
      { address: "172.18.32.1", virtual: true },
      { address: "172.30.96.1", virtual: true },
    ]);
  });

  it("allows both stable names and all deterministic numeric diagnostics in development", () => {
    expect(stableHostnames("SURF.local")).toEqual(["SURF", "SURF.local"]);
    expect(lanAddressDetails(interfaces).map((entry) => entry.address)).toEqual([
      "192.168.100.71",
      "172.18.32.1",
      "172.30.96.1",
    ]);
    expect(devOrigins({ hostname: "SURF.local", interfaces, extras: "previewbox" })).toEqual([
      "192.168.100.71",
      "172.18.32.1",
      "172.30.96.1",
      "surf",
      "surf.local",
      "127.0.0.1",
      "[::1]",
      "previewbox",
    ]);
  });

  it("does not duplicate a loopback literal that ALLOWED_DEV_ORIGINS also lists", () => {
    const withoutExtras = devOrigins({ hostname: "SURF", interfaces, extras: "" });
    const withLoopbackExtra = devOrigins({ hostname: "SURF", interfaces, extras: "127.0.0.1" });

    expect(withoutExtras).toHaveLength(7);
    expect(withLoopbackExtra).toEqual(withoutExtras);
    expect(withLoopbackExtra.filter((name) => name === "127.0.0.1")).toHaveLength(1);
  });
});
