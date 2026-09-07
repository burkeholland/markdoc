import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createNpmAuditExecutor,
  dependencyPolicyFailure,
  evaluateTemporaryAuditFile,
  formatDependencyPolicyReport,
  runDependencyAudit,
  type AuditExecutor,
  type DependencyPolicyReport,
} from "./lib/dependency-policy.ts";

interface CliOutput {
  log(message: string): void;
}

interface RunMainDependencies {
  cwd?: string;
  executor?: AuditExecutor;
  now?: number;
  output?: CliOutput;
}

function printReport(output: CliOutput, report: DependencyPolicyReport): number {
  output.log(formatDependencyPolicyReport(report));
  return report.status === "pass" ? 0 : 1;
}

export async function runMain(argv: string[], dependencies: RunMainDependencies = {}): Promise<number> {
  const output = dependencies.output ?? console;
  let values: {
    "audit-json"?: string;
    "lock-sha256"?: string;
    "run-audit": boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "audit-json": { type: "string" },
        "lock-sha256": { type: "string" },
        "run-audit": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return printReport(output, dependencyPolicyFailure("invalid_request"));
  }

  const expectedLockSha256 = values["lock-sha256"];
  const hasAuditFile = values["audit-json"] !== undefined;
  if (!expectedLockSha256 || hasAuditFile === values["run-audit"]) {
    return printReport(output, dependencyPolicyFailure("invalid_request"));
  }

  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const lockPath = path.join(cwd, "package-lock.json");
  const report = hasAuditFile
    ? await evaluateTemporaryAuditFile({
        auditPath: path.resolve(values["audit-json"] as string),
        lockPath,
        expectedLockSha256,
        now: dependencies.now,
      })
    : await runDependencyAudit({
        cwd,
        lockPath,
        expectedLockSha256,
        executor: dependencies.executor ?? createNpmAuditExecutor(),
      });
  return printReport(output, report);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const modulePath = fileURLToPath(import.meta.url).toLowerCase();
if (invokedPath === modulePath) {
  process.exitCode = await runMain(process.argv.slice(2));
}
