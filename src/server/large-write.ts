/**
 * Large document writes take turns (#2341).
 *
 * A write of a whole document costs time in proportion to its size on the one thread that serves every
 * request: the body is parsed, the text hashed, the shared document changed and encoded, and all of it
 * stored. For 2,000,000 characters that was 0.5 to 2.7 s on a build with the embedded database even with
 * the diff bounded, and 20 of them at once used to run back to back. So a write is LARGE from
 * `LARGE_WRITE_SIZE` on, and large writes are bounded three ways:
 *
 * - One runs at a time. Between two of them the server steps aside (`stepAside`), so other requests are
 *   answered in between.
 * - One caller holds at most `LARGE_WRITE_MAX_PER_CALLER` places, running and waiting together. A caller
 *   is the signed-in user by the id the access check verified: a session and every API token of that user
 *   are the same caller. One more is refused at once.
 * - At most `LARGE_WRITE_MAX_WAITING` wait, all callers together, and none longer than
 *   `LARGE_WRITE_QUEUE_WAIT_MS`. Who goes next and who gives up a place when all are taken is the PDF
 *   export's `FairQueue`: the caller that has used the turn least goes first.
 *
 * A refusal is `503` with `Retry-After`, the answer the PDF export gives when it is busy: nothing is wrong
 * with the request, and the same request succeeds a few seconds later. (`429` here means an empty rate
 * limit bucket and comes with `X-RateLimit-*` headers; this bound is about work in progress, not a rate.)
 * A caller that went away while it waited leaves the queue and writes nothing.
 *
 * Writes below `LARGE_WRITE_SIZE` never come here: they are not counted, queued or refused.
 */
import { FairQueue, QueueCancelled, QueueRefusal, type RefusalReason, type Turn } from "@/server/export/fair-queue";
import { HttpError } from "@/server/http";
import { stepAside } from "@/server/pace";

/**
 * From this size on a write is large: the bytes of a request body (its `Content-Length`), or the
 * characters of a text that does not come in a body (a version that is restored). A body of fewer bytes
 * cannot hold a text of this many characters.
 */
export const LARGE_WRITE_SIZE = 200_000;
/** Large writes that run at once. */
export const LARGE_WRITE_MAX_RUNNING = 1;
/** Large writes that may wait, all callers together. */
export const LARGE_WRITE_MAX_WAITING = 8;
/** Places one caller may hold, running and waiting together. */
export const LARGE_WRITE_MAX_PER_CALLER = 2;
/** Longest one large write waits for its turn before it is refused. */
export const LARGE_WRITE_QUEUE_WAIT_MS = 30_000;
/** `Retry-After`, in seconds, of a refusal. A large write took 0.5 to 2.7 s when measured, so the queue is soon shorter. */
export const LARGE_WRITE_RETRY_AFTER_SECONDS = 5;
/** Time after which a caller's past use of the turn counts half. */
export const LARGE_WRITE_USAGE_HALF_LIFE_MS = 60_000;

export type LargeWriteRefusal = RefusalReason | "caller-full";

/** `503 { error, retryAfter }` with `Retry-After`: the caller has too many large writes in progress, or the server has. */
export class LargeWriteBusyError extends HttpError {
  constructor(readonly reason: LargeWriteRefusal) {
    super(
      503,
      reason === "caller-full"
        ? `You already have ${LARGE_WRITE_MAX_PER_CALLER} large document writes in progress (${LARGE_WRITE_SIZE.toLocaleString("en-US")} bytes or more each). Wait for one to finish, then try again`
        : "The server is busy with large document writes. Try again in a few seconds",
      { retryAfter: LARGE_WRITE_RETRY_AFTER_SECONDS },
      { "Retry-After": String(LARGE_WRITE_RETRY_AFTER_SECONDS) },
    );
  }
}

/** `499`: the caller closed the connection. Nobody reads the answer; the status is for the request log. */
export class LargeWriteCancelledError extends HttpError {
  constructor() {
    super(499, "The request was cancelled");
  }
}

export interface LargeWriteOptions {
  maxRunning?: number;
  maxWaiting?: number;
  maxPerCaller?: number;
  maxWaitMs?: number;
  halfLifeMs?: number;
  now?: () => number;
  /** What happens between two large writes; the real one waits `STEP_ASIDE_MS`. */
  stepAside?: () => Promise<void>;
}

/** Who may write a large document now. One instance serves the whole server (`largeWrites`); tests make their own. */
export class LargeWrites {
  private readonly queue: FairQueue;
  /** Places held by caller, running and waiting together. */
  private readonly places = new Map<string, number>();
  private readonly maxPerCaller: number;
  private readonly aside: () => Promise<void>;

  constructor(options: LargeWriteOptions = {}) {
    this.queue = new FairQueue({
      maxRunning: options.maxRunning ?? LARGE_WRITE_MAX_RUNNING,
      maxWaiting: options.maxWaiting ?? LARGE_WRITE_MAX_WAITING,
      maxWaitMs: options.maxWaitMs ?? LARGE_WRITE_QUEUE_WAIT_MS,
      halfLifeMs: options.halfLifeMs ?? LARGE_WRITE_USAGE_HALF_LIFE_MS,
      now: options.now,
    });
    this.maxPerCaller = options.maxPerCaller ?? LARGE_WRITE_MAX_PER_CALLER;
    this.aside = options.stepAside ?? (() => stepAside());
  }

  /** Large writes that run right now. */
  get runningCount(): number {
    return this.queue.runningCount;
  }

  /** Large writes that wait right now. */
  get waitingCount(): number {
    return this.queue.waitingCount;
  }

  /** Places `userId` holds right now, running and waiting together. */
  placesOf(userId: string): number {
    return this.places.get(callerOf(userId)) ?? 0;
  }

  /**
   * Wait for the turn. Resolves when it is this write's; rejects with `LargeWriteBusyError` when the caller
   * or the queue is full, its place went to a caller with fewer, or it waited too long, and with
   * `LargeWriteCancelledError` when `signal` aborts first. `release` hands the turn on after the server has
   * stepped aside once; a second call does nothing.
   */
  async enter(userId: string, signal?: AbortSignal): Promise<{ release: () => Promise<void> }> {
    const caller = callerOf(userId);
    const held = this.places.get(caller) ?? 0;
    if (held >= this.maxPerCaller) {
      console.warn(`[large-write] refused: caller-full, ${this.queue.waitingCount} waiting`);
      throw new LargeWriteBusyError("caller-full");
    }
    this.places.set(caller, held + 1);
    const leave = () => {
      const left = (this.places.get(caller) ?? 1) - 1;
      if (left > 0) this.places.set(caller, left);
      else this.places.delete(caller);
    };
    let turn: Turn;
    try {
      turn = await this.queue.enter(caller, signal);
    } catch (err) {
      leave();
      if (err instanceof QueueCancelled) throw new LargeWriteCancelledError();
      if (!(err instanceof QueueRefusal)) throw err;
      // One line per refusal says why; of the caller nothing.
      console.warn(`[large-write] refused: ${err.reason}, ${this.queue.waitingCount} waiting`);
      throw new LargeWriteBusyError(err.reason);
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          // The next large write starts in the same turn of the event loop as this one ends, unless the
          // server steps aside first.
          await this.aside();
        } finally {
          leave();
          turn.release();
        }
      },
    };
  }
}

/** The name a write waits under: the user, whatever credential (session or token) spoke for it. */
const callerOf = (userId: string): string => `user:${userId}`;

export const largeWrites = new LargeWrites();

/**
 * The size a request declares for its body (`Content-Length`), before any of it is read; 0 when it does not
 * say (a chunked body). Such a request is sized by its text once the body is parsed (`WriteTurn.sized`).
 */
export function declaredSize(req: Request): number {
  const header = req.headers.get("content-length")?.trim();
  return header && /^\d+$/.test(header) ? Number(header) : 0;
}

/**
 * One request's place among the large writes. `begin` takes the turn at once when the body the request
 * declares is large, before the body is read; `sized` takes it later for a text whose size is only known
 * then; `end` (always, in a `finally`) hands it on. For a write that is not large none of them waits.
 */
export class WriteTurn {
  private turn: { release: () => Promise<void> } | null = null;

  private constructor(
    private readonly userId: string,
    private readonly signal: AbortSignal | undefined,
    private readonly writes: LargeWrites,
  ) {}

  static async begin(req: Request, userId: string, writes: LargeWrites = largeWrites): Promise<WriteTurn> {
    const write = new WriteTurn(userId, req.signal, writes);
    await write.sized(declaredSize(req));
    return write;
  }

  /** True once this write holds the turn of a large write. */
  get large(): boolean {
    return this.turn !== null;
  }

  /** `size` is now known (characters of a text, bytes of a body): take the turn if that makes this write large. */
  async sized(size: number): Promise<void> {
    if (this.turn || size < LARGE_WRITE_SIZE) return;
    this.turn = await this.writes.enter(this.userId, this.signal);
  }

  /**
   * Call right before the document is changed. A large write whose caller went away while it waited or was
   * read stops here, with nothing written.
   */
  assertWanted(): void {
    if (this.turn && this.signal?.aborted) throw new LargeWriteCancelledError();
  }

  async end(): Promise<void> {
    const turn = this.turn;
    this.turn = null;
    await turn?.release();
  }
}
