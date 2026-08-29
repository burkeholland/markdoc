/**
 * Read-only checks that a custom domain is ready to be bound to the production Container App
 * (`docs/custom-domain.md`): the DNS records Azure asks for, and TLS + `/api/health` on the new
 * name once it is bound. Everything that touches the network is injected so the checks can be unit
 * tested, and the CLI (`scripts/custom-domain-preflight.mts`) supplies the real resolver and fetch.
 */

export type CheckStatus = "PASS" | "FAIL" | "PENDING";

export interface CheckResult {
  /** Short stable id, e.g. `dns:cname`, `dns:txt`, `health`. */
  name: string;
  status: CheckStatus;
  /** What was looked at, e.g. the record name or URL. */
  subject: string;
  /** Human-readable outcome; never contains env values, tokens or connection strings. */
  detail: string;
}

export interface DnsResolver {
  resolveCname(hostname: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

export interface AzureFacts {
  /** Default ingress FQDN of the app, the CNAME target for a subdomain. */
  fqdn?: string;
  /** `customDomainVerificationId`: the `asuid.<host>` TXT value. */
  verificationId?: string;
  /** Static inbound IP of the managed environment, the A record for an apex. */
  staticIp?: string;
  /** The environment's `*.azurecontainerapps.io` default domain (informational). */
  defaultDomain?: string;
}

export interface PreflightOptions {
  domain: string;
  expectCname?: string;
  expectIp?: string;
  expectAsuid?: string;
  /** Force apex mode (A records); otherwise inferred from the flags and the label count. */
  apex?: boolean;
  /** When set, missing expectations are filled from `readAzureFacts` (read-only `az … show`). */
  fromAzure?: boolean;
  resolver: DnsResolver;
  fetch: FetchLike;
  readAzureFacts?: () => Promise<AzureFacts>;
  healthTimeoutMs?: number;
}

export interface PreflightReport {
  domain: string;
  mode: "apex" | "subdomain";
  checks: CheckResult[];
  /** 0 when every check is PASS, 1 otherwise. */
  exitCode: 0 | 1;
}

const DNS_PENDING_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/** Node's TLS/OpenSSL failure codes: the name resolves and answers but the certificate is not usable. */
const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_TLSV1_UNRECOGNIZED_NAME",
  "EPROTO",
]);

/** Lowercase, without a trailing dot, so `Foo.Example.` and `foo.example` compare equal. */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * A bare hostname: labels of letters, digits and hyphens joined by dots. Wildcards, schemes, ports
 * and paths are refused so a copy-paste of a URL is caught before any lookup.
 */
export function isValidHostname(value: string): boolean {
  const host = normalizeHostname(value);
  if (!host || host.length > 253) return false;
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function inferMode(options: Pick<PreflightOptions, "domain" | "apex" | "expectCname" | "expectIp">): "apex" | "subdomain" {
  if (options.apex) return "apex";
  if (options.expectIp && !options.expectCname) return "apex";
  if (options.expectCname) return "subdomain";
  return normalizeHostname(options.domain).split(".").length <= 2 ? "apex" : "subdomain";
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function missingExpectation(flag: string): string {
  return `record exists but no expected value was given (pass ${flag} or --from-azure)`;
}

async function checkCname(resolver: DnsResolver, domain: string, expected: string | undefined): Promise<CheckResult> {
  const name = "dns:cname";
  let records: string[];
  try {
    records = await resolver.resolveCname(domain);
  } catch (error) {
    const code = errorCode(error) ?? "lookup failed";
    if (DNS_PENDING_CODES.has(code)) return { name, status: "PENDING", subject: domain, detail: `no CNAME record yet (${code})` };
    return { name, status: "FAIL", subject: domain, detail: `lookup error ${code}` };
  }
  const found = records.map(normalizeHostname);
  if (found.length === 0) return { name, status: "PENDING", subject: domain, detail: "no CNAME record yet" };
  if (!expected) return { name, status: "FAIL", subject: domain, detail: `${missingExpectation("--expect-cname")}: found ${found.join(", ")}` };
  const want = normalizeHostname(expected);
  if (found.includes(want)) return { name, status: "PASS", subject: domain, detail: `CNAME -> ${want}` };
  return { name, status: "FAIL", subject: domain, detail: `CNAME -> ${found.join(", ")} (expected ${want})` };
}

async function checkA(resolver: DnsResolver, domain: string, expected: string | undefined): Promise<CheckResult> {
  const name = "dns:a";
  let records: string[];
  try {
    records = await resolver.resolve4(domain);
  } catch (error) {
    const code = errorCode(error) ?? "lookup failed";
    if (DNS_PENDING_CODES.has(code)) return { name, status: "PENDING", subject: domain, detail: `no A record yet (${code})` };
    return { name, status: "FAIL", subject: domain, detail: `lookup error ${code}` };
  }
  if (records.length === 0) return { name, status: "PENDING", subject: domain, detail: "no A record yet" };
  if (!expected) return { name, status: "FAIL", subject: domain, detail: `${missingExpectation("--expect-ip")}: found ${records.join(", ")}` };
  const want = expected.trim();
  if (records.length === 1 && records[0] === want) return { name, status: "PASS", subject: domain, detail: `A -> ${want}` };
  if (records.includes(want)) return { name, status: "FAIL", subject: domain, detail: `A -> ${records.join(", ")}: extra addresses besides ${want} (remove them)` };
  return { name, status: "FAIL", subject: domain, detail: `A -> ${records.join(", ")} (expected ${want})` };
}

async function checkAsuid(resolver: DnsResolver, domain: string, expected: string | undefined): Promise<CheckResult> {
  const name = "dns:txt";
  const subject = `asuid.${domain}`;
  let records: string[][];
  try {
    records = await resolver.resolveTxt(subject);
  } catch (error) {
    const code = errorCode(error) ?? "lookup failed";
    if (DNS_PENDING_CODES.has(code)) return { name, status: "PENDING", subject, detail: `no TXT record yet (${code})` };
    return { name, status: "FAIL", subject, detail: `lookup error ${code}` };
  }
  const found = records.map((chunks) => chunks.join("").trim());
  if (found.length === 0) return { name, status: "PENDING", subject, detail: "no TXT record yet" };
  if (!expected) return { name, status: "FAIL", subject, detail: `${missingExpectation("--expect-asuid")}: ${found.length} TXT record(s)` };
  const want = expected.trim().toLowerCase();
  if (found.some((value) => value.toLowerCase() === want)) return { name, status: "PASS", subject, detail: "TXT matches the verification id" };
  return { name, status: "FAIL", subject, detail: `${found.length} TXT record(s), none equals the verification id` };
}

async function checkHealth(fetchImpl: FetchLike, domain: string, timeoutMs: number): Promise<CheckResult> {
  const name = "health";
  const url = `https://${domain}/api/health`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  } catch (error) {
    const code = errorCode(error);
    if (code && (DNS_PENDING_CODES.has(code) || code === "EAI_AGAIN")) return { name, status: "PENDING", subject: url, detail: `name does not resolve yet (${code})` };
    if (code && TLS_ERROR_CODES.has(code)) return { name, status: "FAIL", subject: url, detail: `tls=not ok (${code}); the managed certificate is not serving for this name yet` };
    if (isTimeout(error)) return { name, status: "FAIL", subject: url, detail: `no answer within ${timeoutMs} ms` };
    return { name, status: "FAIL", subject: url, detail: `request failed (${code ?? "unknown error"})` };
  }
  let ok: unknown;
  let version: unknown;
  try {
    const body = (await response.json()) as { ok?: unknown; version?: unknown };
    ok = body.ok;
    version = body.version;
  } catch {
    ok = undefined;
  }
  const summary = `${response.status} ok=${typeof ok === "boolean" ? ok : "?"} version=${typeof version === "string" ? version : "?"} tls=ok`;
  if (response.status === 200 && ok === true) return { name, status: "PASS", subject: url, detail: summary };
  return { name, status: "FAIL", subject: url, detail: summary };
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const domain = normalizeHostname(options.domain);
  if (!isValidHostname(domain)) throw new Error("--domain must be a bare hostname such as markdoc.example.com");
  const mode = inferMode(options);

  let expectCname = options.expectCname;
  let expectIp = options.expectIp;
  let expectAsuid = options.expectAsuid;
  const checks: CheckResult[] = [];

  const needsAzure = (mode === "subdomain" && !expectCname) || (mode === "apex" && !expectIp) || !expectAsuid;
  if (options.fromAzure && needsAzure) {
    if (!options.readAzureFacts) throw new Error("--from-azure needs an Azure reader");
    try {
      const facts = await options.readAzureFacts();
      expectCname ??= facts.fqdn;
      expectIp ??= facts.staticIp;
      expectAsuid ??= facts.verificationId;
      checks.push({ name: "azure", status: "PASS", subject: "az containerapp show / env show", detail: `fqdn=${facts.fqdn ?? "?"} staticIp=${facts.staticIp ?? "?"} verificationId=${facts.verificationId ? "read" : "?"}` });
    } catch (error) {
      checks.push({ name: "azure", status: "FAIL", subject: "az containerapp show / env show", detail: error instanceof Error ? error.message : "read failed" });
    }
  }

  checks.push(mode === "apex" ? await checkA(options.resolver, domain, expectIp) : await checkCname(options.resolver, domain, expectCname));
  checks.push(await checkAsuid(options.resolver, domain, expectAsuid));
  checks.push(await checkHealth(options.fetch, domain, options.healthTimeoutMs ?? 10_000));

  return { domain, mode, checks, exitCode: checks.every((check) => check.status === "PASS") ? 0 : 1 };
}

export function formatCheck(check: CheckResult): string {
  return `${check.status.padEnd(7)} ${check.name.padEnd(9)} ${check.subject}  ${check.detail}`;
}

export function formatReport(report: PreflightReport): string {
  const lines = [`custom-domain preflight for ${report.domain} (${report.mode})`, ...report.checks.map(formatCheck)];
  lines.push(report.exitCode === 0 ? "all checks passed" : "not ready: see FAIL/PENDING lines above");
  return lines.join("\n");
}

/**
 * Parse the exact fields we allow ourselves to read from `az containerapp show` and
 * `az containerapp env show`; anything else in the JSON is dropped here and never printed.
 */
export function parseAzureAppFacts(json: string): { fqdn?: string; verificationId?: string; environmentId?: string } {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    fqdn: typeof parsed.fqdn === "string" ? parsed.fqdn : undefined,
    verificationId: typeof parsed.verificationId === "string" ? parsed.verificationId : undefined,
    environmentId: typeof parsed.env === "string" ? parsed.env : undefined,
  };
}

export function parseAzureEnvFacts(json: string): { staticIp?: string; defaultDomain?: string } {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return {
    staticIp: typeof parsed.ip === "string" ? parsed.ip : undefined,
    defaultDomain: typeof parsed.defaultDomain === "string" ? parsed.defaultDomain : undefined,
  };
}

export const AZURE_APP_QUERY = "{fqdn:properties.configuration.ingress.fqdn, verificationId:properties.customDomainVerificationId, env:properties.environmentId}";
export const AZURE_ENV_QUERY = "{ip:properties.staticIp, defaultDomain:properties.defaultDomain}";

/** Public resolvers used when the system's list is unusable (loopback-only, or refuses connections). */
export const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

/** c-ares errors that mean "no server answered", as opposed to a server saying the name is missing. */
const DNS_TRANSPORT_CODES = new Set(["ECONNREFUSED", "ETIMEOUT", "EREFUSED", "ECANCELLED", "EDESTRUCTION"]);

export function isLoopbackServer(server: string): boolean {
  let host = server.trim().toLowerCase();
  // IPv6 with a port is bracketed (`[::1]:53`); a bare IPv6 address has more than one colon.
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else if (host.split(":").length === 2) host = host.split(":")[0];
  return host === "::1" || host.startsWith("127.");
}

/** The system's resolver addresses worth asking: a loopback stub (a VPN or container proxy) is dropped. */
export function usableSystemServers(servers: string[]): string[] {
  return servers.filter((server) => !isLoopbackServer(server));
}

/**
 * Ask `primary` first and, only when no server answered at all, repeat the query on `fallback`.
 * NXDOMAIN and other real answers from `primary` are final. `onFallback` fires once, for the note line.
 */
export function withFallbackResolver(primary: DnsResolver, fallback: DnsResolver, onFallback?: () => void): DnsResolver {
  let announced = false;
  const wrap = <T>(method: (resolver: DnsResolver) => Promise<T>): Promise<T> =>
    method(primary).catch((error: unknown) => {
      const code = errorCode(error);
      if (!code || !DNS_TRANSPORT_CODES.has(code)) throw error;
      if (!announced) {
        announced = true;
        onFallback?.();
      }
      return method(fallback);
    });
  return {
    resolveCname: (hostname) => wrap((r) => r.resolveCname(hostname)),
    resolve4: (hostname) => wrap((r) => r.resolve4(hostname)),
    resolveTxt: (hostname) => wrap((r) => r.resolveTxt(hostname)),
  };
}

export type AzRunner = (args: string[]) => Promise<string>;

/** Read the three published facts through `az` (read-only `show` calls only). */
export async function readAzureFactsWith(az: AzRunner, app = "markdoc", resourceGroup = "markdoc-rg"): Promise<AzureFacts> {
  const appFacts = parseAzureAppFacts(await az(["containerapp", "show", "-n", app, "-g", resourceGroup, "--query", AZURE_APP_QUERY, "-o", "json"]));
  if (!appFacts.environmentId) throw new Error("az containerapp show did not return the environment id");
  const envFacts = parseAzureEnvFacts(await az(["containerapp", "env", "show", "--ids", appFacts.environmentId, "--query", AZURE_ENV_QUERY, "-o", "json"]));
  return { fqdn: appFacts.fqdn, verificationId: appFacts.verificationId, staticIp: envFacts.staticIp, defaultDomain: envFacts.defaultDomain };
}
