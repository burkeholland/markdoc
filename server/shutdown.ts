export async function shutdownServices(stopPublishing: () => Promise<void>, flushDocuments: () => Promise<void>): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(stopPublishing),
    Promise.resolve().then(flushDocuments),
  ]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Service shutdown failed");
}
