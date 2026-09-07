export const SHUTDOWN_DEADLINE_MS = 10_000;

export type ShutdownTrigger = "SIGINT" | "SIGTERM" | "startup";
type ShutdownPhase = "intake" | "publishing" | "collaboration" | "database";
type PhaseResult = "pending" | "ok" | "failed";

export interface ShutdownDependencies {
  stopIntake: () => Promise<void>;
  stopPublishing: () => Promise<void>;
  stopCollaboration: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  error: (message: string) => void;
}

const phases: readonly ShutdownPhase[] = ["intake", "publishing", "collaboration", "database"];

/**
 * Owns process shutdown from the first signal through the final exit. Phase
 * failures are deliberately reduced to names and results before logging.
 */
export function createShutdownOwner(
  dependencies: ShutdownDependencies,
  deadlineMs = SHUTDOWN_DEADLINE_MS,
) {
  const controller = new AbortController();
  let shutdown: Promise<number> | undefined;

  const request = (trigger: ShutdownTrigger): Promise<number> => {
    if (shutdown) return shutdown;
    controller.abort();
    dependencies.log(`> [exit] shutdown started: trigger=${trigger} deadline=${deadlineMs}ms`);
    shutdown = run(trigger);
    void shutdown.then(dependencies.exit);
    return shutdown;
  };

  const run = async (trigger: ShutdownTrigger): Promise<number> => {
    const results: Record<ShutdownPhase, PhaseResult> = {
      intake: "pending",
      publishing: "pending",
      collaboration: "pending",
      database: "pending",
    };
    const runPhase = async (phase: ShutdownPhase, operation: () => Promise<void>) => {
      const result = await Promise.resolve().then(operation).then(
        () => "ok" as const,
        () => "failed" as const,
      );
      results[phase] = result;
    };
    const operations = Promise.all([
      runPhase("intake", dependencies.stopIntake),
      runPhase("publishing", dependencies.stopPublishing),
      runPhase("collaboration", dependencies.stopCollaboration),
    ]).then(() => runPhase("database", dependencies.closeDatabase));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), deadlineMs);
    });
    const outcome = await Promise.race([
      operations.then(() => "settled" as const),
      deadline,
    ]);
    if (outcome === "settled" && timer !== undefined) clearTimeout(timer);

    const deadlineResult = outcome === "deadline" ? "failed" : "ok";
    const summary = [
      `trigger=${trigger}`,
      ...phases.map((phase) => `${phase}=${results[phase]}`),
      `deadline=${deadlineResult}`,
    ].join(" ");
    const failed = trigger === "startup" || deadlineResult === "failed" ||
      phases.some((phase) => results[phase] === "failed");
    if (failed) dependencies.error(`> [exit] shutdown failed: ${summary}`);
    else dependencies.log(`> [exit] shutdown complete: ${summary}`);
    return failed ? 1 : 0;
  };

  return { request, signal: controller.signal };
}

export async function shutdownServices(stopPublishing: () => Promise<void>, flushDocuments: () => Promise<void>): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(stopPublishing),
    Promise.resolve().then(flushDocuments),
  ]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Service shutdown failed");
}
