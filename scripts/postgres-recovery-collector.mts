import { parseArgs } from "node:util";
import {
  RECOVERY_INPUT_SCHEMA,
  RECOVERY_POLICY,
  RECOVERY_RECEIPT_SCHEMA,
  collectRecoveryReceipt,
} from "./lib/postgres-recovery-collector";

const { values } = parseArgs({
  options: {
    "input-root": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/postgres-recovery-collector.mts --input-root <absolute-directory>",
      "",
      `Input schema: ${RECOVERY_INPUT_SCHEMA}`,
      `Receipt schema: ${RECOVERY_RECEIPT_SCHEMA}`,
      `Policy v1: ${RECOVERY_POLICY.maximum_unarchived_data_seconds}/${RECOVERY_POLICY.maximum_observation_age_seconds}/${RECOVERY_POLICY.maximum_scratch_restore_age_seconds}`,
      "",
      "Reads closed, caller-captured JSON projections only. This held v1 cannot acquire",
      "collector execution authority, contact a service, or run a database/guest command.",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

if (!values["input-root"]) {
  throw new Error("--input-root is required");
}

const receipt = await collectRecoveryReceipt(values["input-root"]);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = receipt.decision === "MALFORMED" ? 2 : 1;
