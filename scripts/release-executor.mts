import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AUTHORITY_SCOPES,
  executeProductionRootedRelease,
  ReleaseStop,
  type AuthorityFileInput,
  type ExecuteReleaseOptions,
  type ExecuteReleaseResult,
} from "./lib/release-executor";

export const usage = `usage: npm run release:execute -- \\
  --controller-authority <canonical-json> --controller-root <sha256> \\
  --source-authority <canonical-json> --source-root <sha256> \\
  --payload-authority <canonical-json> --payload-root <sha256> \\
  --package-authority <canonical-json> --package-root <sha256> \\
  --package-json <file> --package-lock <file> (--output <new-directory> | --check)

Local production-rooted source executor. It never selects a ref, creates a ref, queries a
package source, builds an image or calls GitHub/Azure. All six input files and the output
must be outside the clean controller checkout.

Each authority file is independently pinned by the SHA-256 root supplied beside it. It
must be canonical JSON, carry its matching controller/source/payload/package scope and
decision=allow, and bind one identical controller/source/payload/package release tuple.
The executor stops before creating a staging directory if any authority, Git identity,
package blob or output boundary is absent or different.

--check performs the same quarantined Git composition but removes it instead of retaining
the payload. Exit 0 means the exact two-path payload was checked or staged; exit 1 is STOP;
exit 2 is invalid command syntax.`;

interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

interface RunMainDependencies {
  output?: CliOutput;
  repoRoot?: string;
  execute?: (options: ExecuteReleaseOptions) => ExecuteReleaseResult;
}

export function parseArguments(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "controller-authority": { type: "string" },
      "controller-root": { type: "string" },
      "source-authority": { type: "string" },
      "source-root": { type: "string" },
      "payload-authority": { type: "string" },
      "payload-root": { type: "string" },
      "package-authority": { type: "string" },
      "package-root": { type: "string" },
      "package-json": { type: "string" },
      "package-lock": { type: "string" },
      output: { type: "string" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return values;
}

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "..");

export function runMain(argv: string[], dependencies: RunMainDependencies = {}): number {
  const output = dependencies.output ?? console;
  let values: ReturnType<typeof parseArguments>;
  try {
    values = parseArguments(argv);
  } catch (error) {
    output.error(error instanceof Error ? error.message : "invalid arguments");
    output.error(usage);
    return 2;
  }
  if (values.help) {
    output.log(usage);
    return 0;
  }

  const required = [
    "controller-authority",
    "controller-root",
    "source-authority",
    "source-root",
    "payload-authority",
    "payload-root",
    "package-authority",
    "package-root",
    "package-json",
    "package-lock",
  ] as const;
  const missing = required.find((name) => !values[name]);
  if (missing) {
    output.error(`release-executor: STOP missing --${missing}`);
    return 1;
  }
  if (!values.check && !values.output) {
    output.error("release-executor: STOP missing --output (or use --check)");
    return 1;
  }

  const authorities: AuthorityFileInput[] = AUTHORITY_SCOPES.map((scope) => ({
    scope,
    file: values[`${scope}-authority`]!,
    root: values[`${scope}-root`]!,
  }));
  const execute = dependencies.execute ?? executeProductionRootedRelease;
  try {
    const result = execute({
      repoRoot: dependencies.repoRoot ?? defaultRepoRoot,
      authorities,
      packageJsonFile: values["package-json"]!,
      packageLockFile: values["package-lock"]!,
      output: values.output,
      checkOnly: values.check,
    });
    output.log(
      `release-executor: ${result.mode.toUpperCase()} payload-tree=${result.payloadTree} package=${result.packageBlob} package-lock=${result.packageLockBlob} authorities=${result.authorityCount}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ReleaseStop) {
      output.error(`release-executor: STOP ${error.message}`);
      return 1;
    }
    output.error("release-executor: STOP unexpected executor failure");
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
if (invokedPath === modulePath.toLowerCase()) {
  process.exitCode = runMain(process.argv.slice(2));
}
