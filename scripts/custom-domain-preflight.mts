import { execFile } from "node:child_process";
import { getServers } from "node:dns";
import { Resolver } from "node:dns/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  formatReport,
  PUBLIC_DNS_SERVERS,
  readAzureFactsWith,
  runPreflight,
  usableSystemServers,
  withFallbackResolver,
  type AzRunner,
  type DnsResolver,
} from "./lib/custom-domain-preflight";

export const usage = `usage: npm run domain:preflight -- --domain <host> [--expect-cname <fqdn> | --expect-ip <ip>] [--expect-asuid <id>] [--from-azure] [--apex] [--dns-server <ip>]...

Read-only checks before/after binding a custom domain to the production Container App:
  dns:cname / dns:a   <host> points at the app's default FQDN (subdomain) or the environment's static IP (apex)
  dns:txt             asuid.<host> carries the app's customDomainVerificationId
  health              https://<host>/api/health answers 200 ok=true over a valid certificate (10 s timeout)

Expected values come from the flags. With --from-azure, a missing one is read from
"az containerapp show" / "az containerapp env show" (read-only; --app and --resource-group
default to markdoc / markdoc-rg). DNS is asked of the system resolvers (loopback stubs are
skipped), falling back to ${PUBLIC_DNS_SERVERS.join(" and ")} when none answers; --dns-server pins the list.
Exit 0 when every line is PASS, 1 otherwise.`;

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

interface RunMainDependencies {
  output?: CliOutput;
  resolver?: DnsResolver;
  fetch?: typeof fetch;
  az?: AzRunner;
}

export function parseArguments(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      domain: { type: "string" },
      "expect-cname": { type: "string" },
      "expect-ip": { type: "string" },
      "expect-asuid": { type: "string" },
      "from-azure": { type: "boolean", default: false },
      apex: { type: "boolean", default: false },
      "dns-server": { type: "string", multiple: true },
      app: { type: "string", default: "markdoc" },
      "resource-group": { type: "string", default: "markdoc-rg" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

/** Run `az` and hand back stdout. Windows ships `az.cmd`, which Node refuses to spawn without a shell. */
export const runAz: AzRunner = (args) =>
  new Promise((resolve, reject) => {
    // Every dynamic argument (app, resource group, environment id) is a resource name or id.
    for (const arg of args) {
      if (!/^[A-Za-z0-9._\-/{}:, ]+$/.test(arg)) return reject(new Error("refusing to pass an unexpected character to az"));
    }
    const done = (error: Error | null, stdout: string) => {
      // stderr is deliberately dropped: only the queried fields may ever be printed.
      if (error) reject(new Error(`az ${args[0]} ${args[1]} failed (exit ${(error as { code?: unknown }).code ?? "?"}); is az logged in?`));
      else resolve(stdout);
    };
    const options = { windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" as const };
    if (process.platform !== "win32") return void execFile("az", args, options, done);
    const commandLine = ["az", ...args.map((arg) => (/[\s{},]/.test(arg) ? `"${arg}"` : arg))].join(" ");
    execFile(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], { ...options, windowsVerbatimArguments: true }, done);
  });

const RESOLVER_OPTIONS = { timeout: 4000, tries: 2 };

/** `--dns-server` pins the list; otherwise the system's non-loopback servers with a public fallback. */
export function buildResolver(pinned: string[] | undefined, output: CliOutput): DnsResolver {
  if (pinned?.length) {
    const resolver = new Resolver(RESOLVER_OPTIONS);
    resolver.setServers(pinned);
    return resolver;
  }
  const system = usableSystemServers(getServers());
  const fallback = new Resolver(RESOLVER_OPTIONS);
  fallback.setServers(PUBLIC_DNS_SERVERS);
  if (system.length === 0) {
    output.log(`note: system DNS servers are loopback-only; asking ${PUBLIC_DNS_SERVERS.join(", ")} instead`);
    return fallback;
  }
  const primary = new Resolver(RESOLVER_OPTIONS);
  primary.setServers(system);
  return withFallbackResolver(primary, fallback, () => output.log(`note: system DNS did not answer; retrying on ${PUBLIC_DNS_SERVERS.join(", ")}`));
}

export async function runMain(argv: string[], dependencies: RunMainDependencies = {}): Promise<number> {
  const output = dependencies.output ?? console;
  let values: ReturnType<typeof parseArguments>;
  try {
    values = parseArguments(argv);
  } catch (error) {
    output.error(error instanceof Error ? error.message : "invalid arguments");
    output.error(usage);
    return 1;
  }
  if (values.help) {
    output.log(usage);
    return 0;
  }
  if (!values.domain) {
    output.error("--domain is required");
    output.error(usage);
    return 1;
  }

  const resolver = dependencies.resolver ?? buildResolver(values["dns-server"], output);
  const fetchImpl = dependencies.fetch ?? fetch;
  const az = dependencies.az ?? runAz;
  try {
    const report = await runPreflight({
      domain: values.domain,
      expectCname: values["expect-cname"],
      expectIp: values["expect-ip"],
      expectAsuid: values["expect-asuid"],
      apex: values.apex,
      fromAzure: values["from-azure"],
      resolver,
      fetch: (url, init) => fetchImpl(url, init),
      readAzureFacts: () => readAzureFactsWith(az, values.app, values["resource-group"]),
    });
    output.log(formatReport(report));
    return report.exitCode;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "preflight failed");
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = fileURLToPath(import.meta.url).toLowerCase();
if (invokedPath === modulePath) {
  process.exitCode = await runMain(process.argv.slice(2));
}
