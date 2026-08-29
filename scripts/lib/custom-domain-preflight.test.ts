import { describe, expect, it } from "vitest";
import {
  formatReport,
  inferMode,
  isValidHostname,
  parseAzureAppFacts,
  readAzureFactsWith,
  runPreflight,
  usableSystemServers,
  withFallbackResolver,
  type AzureFacts,
  type DnsResolver,
  type FetchLike,
} from "./custom-domain-preflight";

const FQDN = "markdoc.delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io";
const IP = "57.165.73.191";
const ASUID = "17C7704DD90906C1933411DDBE9839A0ABF7CEE1D2007B0842758C7F87C450C9";

const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
const nxdomain = () => Promise.reject(dnsError("ENOTFOUND"));

function resolver(overrides: Partial<DnsResolver> = {}): DnsResolver {
  return {
    resolveCname: () => Promise.resolve([`${FQDN}.`]),
    resolve4: () => Promise.resolve([IP]),
    resolveTxt: () => Promise.resolve([[ASUID.slice(0, 30), ASUID.slice(30)]]),
    ...overrides,
  };
}

const healthy: FetchLike = async () => Response.json({ ok: true, db: true, version: "abc123" });
const fetchFailing = (code: string): FetchLike => async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: dnsError(code) });
};

const status = (report: Awaited<ReturnType<typeof runPreflight>>) => Object.fromEntries(report.checks.map((c) => [c.name, c.status]));

describe("custom-domain preflight", () => {
  it("all checks pass for a subdomain with the right CNAME, TXT and a healthy app: exit 0", async () => {
    const report = await runPreflight({ domain: "Markdoc.Example.com", expectCname: FQDN, expectAsuid: ASUID.toLowerCase(), resolver: resolver(), fetch: healthy });
    expect(report.domain).toBe("markdoc.example.com");
    expect(report.mode).toBe("subdomain");
    expect(status(report)).toEqual({ "dns:cname": "PASS", "dns:txt": "PASS", health: "PASS" });
    expect(report.exitCode).toBe(0);
    const text = formatReport(report);
    expect(text).toContain("PASS    dns:cname markdoc.example.com");
    expect(text).toContain("200 ok=true version=abc123 tls=ok");
    expect(text).toContain("all checks passed");
  });

  it("a CNAME pointing somewhere else is FAIL with both values: exit 1", async () => {
    const report = await runPreflight({ domain: "markdoc.example.com", expectCname: FQDN, expectAsuid: ASUID, resolver: resolver({ resolveCname: () => Promise.resolve(["other.example.net"]) }), fetch: healthy });
    const cname = report.checks.find((c) => c.name === "dns:cname")!;
    expect(cname.status).toBe("FAIL");
    expect(cname.detail).toContain("other.example.net");
    expect(cname.detail).toContain(FQDN);
    expect(report.exitCode).toBe(1);
  });

  it("NXDOMAIN everywhere is PENDING, not a crash: exit 1", async () => {
    const report = await runPreflight({
      domain: "example.invalid",
      expectCname: "x.example",
      resolver: resolver({ resolveCname: nxdomain, resolve4: nxdomain, resolveTxt: nxdomain }),
      fetch: fetchFailing("ENOTFOUND"),
    });
    expect(report.mode).toBe("subdomain");
    expect(status(report)).toEqual({ "dns:cname": "PENDING", "dns:txt": "PENDING", health: "PENDING" });
    expect(report.exitCode).toBe(1);
    expect(formatReport(report)).not.toMatch(/\n\s+at /);
  });

  it("health 503 is FAIL and still reports ok/version", async () => {
    const report = await runPreflight({
      domain: "markdoc.example.com",
      expectCname: FQDN,
      expectAsuid: ASUID,
      resolver: resolver(),
      fetch: async () => Response.json({ ok: false, error: "db down" }, { status: 503 }),
    });
    const health = report.checks.find((c) => c.name === "health")!;
    expect(health.status).toBe("FAIL");
    expect(health.detail).toBe("503 ok=false version=? tls=ok");
    expect(health.detail).not.toContain("db down");
    expect(report.exitCode).toBe(1);
  });

  it("an apex checks A records against the static IP and passes", async () => {
    const report = await runPreflight({ domain: "example.com", expectIp: IP, expectAsuid: ASUID, resolver: resolver(), fetch: healthy });
    expect(report.mode).toBe("apex");
    expect(status(report)).toEqual({ "dns:a": "PASS", "dns:txt": "PASS", health: "PASS" });
    expect(report.exitCode).toBe(0);
    expect(formatReport(report)).toContain(`A -> ${IP}`);
  });

  it("an apex with an extra A record, or the wrong one, is FAIL", async () => {
    const extra = await runPreflight({ domain: "example.com", expectIp: IP, expectAsuid: ASUID, resolver: resolver({ resolve4: () => Promise.resolve([IP, "203.0.113.9"]) }), fetch: healthy });
    expect(extra.checks[0]).toMatchObject({ name: "dns:a", status: "FAIL" });
    expect(extra.checks[0].detail).toContain("extra addresses");
    const wrong = await runPreflight({ domain: "example.com", expectIp: IP, expectAsuid: ASUID, resolver: resolver({ resolve4: () => Promise.resolve(["203.0.113.9"]) }), fetch: healthy });
    expect(wrong.checks[0]).toMatchObject({ name: "dns:a", status: "FAIL" });
  });

  it("a TXT record that does not equal the verification id is FAIL; a missing one is PENDING", async () => {
    const wrong = await runPreflight({ domain: "markdoc.example.com", expectCname: FQDN, expectAsuid: ASUID, resolver: resolver({ resolveTxt: () => Promise.resolve([["v=spf1 -all"]]) }), fetch: healthy });
    expect(wrong.checks[1]).toMatchObject({ name: "dns:txt", status: "FAIL" });
    expect(wrong.checks[1].subject).toBe("asuid.markdoc.example.com");
    const missing = await runPreflight({ domain: "markdoc.example.com", expectCname: FQDN, expectAsuid: ASUID, resolver: resolver({ resolveTxt: () => Promise.reject(dnsError("ENODATA")) }), fetch: healthy });
    expect(missing.checks[1]).toMatchObject({ name: "dns:txt", status: "PENDING" });
  });

  it("a certificate error is FAIL with tls=not ok; a timeout is FAIL without a stack", async () => {
    const tls = await runPreflight({ domain: "markdoc.example.com", expectCname: FQDN, expectAsuid: ASUID, resolver: resolver(), fetch: fetchFailing("ERR_TLS_CERT_ALTNAME_INVALID") });
    expect(tls.checks[2]).toMatchObject({ name: "health", status: "FAIL" });
    expect(tls.checks[2].detail).toContain("tls=not ok (ERR_TLS_CERT_ALTNAME_INVALID)");

    const slow: FetchLike = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const timeout = await runPreflight({ domain: "markdoc.example.com", expectCname: FQDN, expectAsuid: ASUID, resolver: resolver(), fetch: slow, healthTimeoutMs: 20 });
    expect(timeout.checks[2]).toMatchObject({ name: "health", status: "FAIL" });
    expect(timeout.checks[2].detail).toBe("no answer within 20 ms");
  });

  it("a record that exists but has nothing to compare against is FAIL and says which flag to pass", async () => {
    const report = await runPreflight({ domain: "markdoc.example.com", resolver: resolver(), fetch: healthy });
    expect(report.checks[0]).toMatchObject({ name: "dns:cname", status: "FAIL" });
    expect(report.checks[0].detail).toContain("--expect-cname");
    expect(report.checks[1].detail).toContain("--expect-asuid");
    expect(report.exitCode).toBe(1);
  });

  it("--from-azure fills only the missing expectations from the injected reader", async () => {
    let reads = 0;
    const readAzureFacts = async (): Promise<AzureFacts> => {
      reads += 1;
      return { fqdn: FQDN, verificationId: ASUID, staticIp: IP, defaultDomain: "delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io" };
    };
    const report = await runPreflight({ domain: "markdoc.example.com", fromAzure: true, readAzureFacts, resolver: resolver(), fetch: healthy });
    expect(reads).toBe(1);
    expect(status(report)).toEqual({ azure: "PASS", "dns:cname": "PASS", "dns:txt": "PASS", health: "PASS" });
    expect(report.exitCode).toBe(0);

    const explicit = await runPreflight({ domain: "markdoc.example.com", expectCname: FQDN, expectAsuid: ASUID, fromAzure: true, readAzureFacts, resolver: resolver(), fetch: healthy });
    expect(reads).toBe(1);
    expect(explicit.checks.map((c) => c.name)).toEqual(["dns:cname", "dns:txt", "health"]);

    const broken = await runPreflight({ domain: "markdoc.example.com", fromAzure: true, readAzureFacts: () => Promise.reject(new Error("az containerapp show failed (exit 1)")), resolver: resolver(), fetch: healthy });
    expect(broken.checks[0]).toMatchObject({ name: "azure", status: "FAIL", detail: "az containerapp show failed (exit 1)" });
    expect(broken.exitCode).toBe(1);
  });

  it("readAzureFactsWith issues exactly the two read-only show commands and keeps only the queried fields", async () => {
    const calls: string[][] = [];
    const az = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "show" && args[0] === "containerapp") {
        return JSON.stringify({ fqdn: FQDN, verificationId: ASUID, env: "/subscriptions/x/resourceGroups/markdoc-rg/providers/Microsoft.App/managedEnvironments/markdoc-prod-env", secrets: "must-not-leak" });
      }
      return JSON.stringify({ ip: IP, defaultDomain: "delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io", other: "dropped" });
    };
    const facts = await readAzureFactsWith(az);
    expect(facts).toEqual({ fqdn: FQDN, verificationId: ASUID, staticIp: IP, defaultDomain: "delightfulbay-4d29ba6f.eastus2.azurecontainerapps.io" });
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 6)).toEqual(["containerapp", "show", "-n", "markdoc", "-g", "markdoc-rg"]);
    expect(calls[1].slice(0, 4)).toEqual(["containerapp", "env", "show", "--ids"]);
    for (const call of calls) expect(call).not.toContain("update");
    expect(parseAzureAppFacts(JSON.stringify({ fqdn: 1 }))).toEqual({ fqdn: undefined, verificationId: undefined, environmentId: undefined });
  });

  it("refuses anything but a bare hostname and infers apex from the flags or the label count", async () => {
    expect(isValidHostname("markdoc.example.com")).toBe(true);
    expect(isValidHostname("example.com.")).toBe(true);
    for (const bad of ["https://markdoc.example.com", "markdoc.example.com/", "markdoc.example.com:443", "*.example.com", "", "-bad.example"]) {
      expect(isValidHostname(bad), bad).toBe(false);
    }
    await expect(runPreflight({ domain: "https://markdoc.example.com", resolver: resolver(), fetch: healthy })).rejects.toThrow(/bare hostname/);
    expect(inferMode({ domain: "example.com" })).toBe("apex");
    expect(inferMode({ domain: "docs.example.com" })).toBe("subdomain");
    expect(inferMode({ domain: "docs.example.com", expectIp: IP })).toBe("apex");
    expect(inferMode({ domain: "example.com", expectCname: FQDN })).toBe("subdomain");
    expect(inferMode({ domain: "docs.example.com", apex: true })).toBe("apex");
  });

  it("a loopback-only system resolver list is dropped, and a refused server falls back once to the public one", async () => {
    expect(usableSystemServers(["127.0.0.1", "::1", "[::1]:53", "127.0.0.53"])).toEqual([]);
    expect(usableSystemServers(["127.0.0.1", "75.75.75.75", "2001:4860:4860::8888"])).toEqual(["75.75.75.75", "2001:4860:4860::8888"]);

    let announced = 0;
    const refused = resolver({ resolveCname: () => Promise.reject(dnsError("ECONNREFUSED")), resolveTxt: () => Promise.reject(dnsError("ECONNREFUSED")) });
    const combined = withFallbackResolver(refused, resolver({ resolveCname: nxdomain, resolveTxt: nxdomain }), () => { announced += 1; });
    const report = await runPreflight({ domain: "example.invalid", expectCname: "x.example", resolver: combined, fetch: fetchFailing("ENOTFOUND") });
    expect(status(report)).toEqual({ "dns:cname": "PENDING", "dns:txt": "PENDING", health: "PENDING" });
    expect(announced).toBe(1);

    // A real answer from the primary (here NXDOMAIN) is final: the fallback is never consulted.
    const primaryAnswers = withFallbackResolver(resolver({ resolveCname: nxdomain }), resolver(), () => { announced += 1; });
    await expect(primaryAnswers.resolveCname("gone.example")).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(announced).toBe(1);
  });
});
