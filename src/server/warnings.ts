/**
 * The stable codes a 2xx may carry in `warnings[]` (see docs/agents.md): a side effect that failed *after* the
 * primary write landed — the write stands, the caller learns exactly what is missing. Nothing else goes in the
 * array: a new kind of tail reuses one of these or is a fatal step.
 */
export type WarningCode = "version-not-saved" | "activity-not-recorded" | "notification-not-sent" | "request-not-attached" | "mentions-not-recorded";

export interface WarnTail {
  /**
   * Run a post-write side effect. A throw is logged once as `[<scope>] <code>` with the error, recorded under
   * `code`, and answered with `false`; it never propagates — the primary write has already happened, and a
   * non-2xx here would claim it had not. Never use it for the primary write itself.
   */
  tail(code: WarningCode, fn: () => Promise<unknown>): Promise<boolean>;
  /** The codes recorded so far, first failure first, each once (a live view — a per-author loop keeps one entry). */
  readonly failed: ReadonlySet<WarningCode>;
  /** `b` untouched when nothing failed; `{ ...b, warnings: [...] }` otherwise. The key is absent, never `[]`. */
  answer<T extends object>(b: T): T & { warnings?: WarningCode[] };
}

/**
 * The one warning tail every write route and service shares. `scope` is the log tag (`[assets]`, `[comments]`,
 * `[requests]`, `[publish]` …). `carried` seeds the set with codes an earlier step already reported on the same
 * write — the publish route carries `publishDocument`'s — so they come first, in write order.
 */
export function warnTail(scope: string, carried: Iterable<WarningCode> = []): WarnTail {
  const failed = new Set<WarningCode>(carried);
  return {
    async tail(code, fn) {
      try {
        await fn();
        return true;
      } catch (err) {
        console.error(`[${scope}] ${code}`, err);
        failed.add(code);
        return false;
      }
    },
    failed,
    answer(b) {
      return failed.size ? { ...b, warnings: [...failed] } : b;
    },
  };
}
