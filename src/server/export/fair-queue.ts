/**
 * Who gets the PDF renderer next, and who may wait for it (#2290). No Playwright and no I/O in here: a
 * request enters under the name of its caller, holds a turn while it renders, and hands the turn back.
 *
 * Places: while there is room, everybody may wait. When every place is taken, a caller who holds at least
 * two places fewer than the caller who holds the most takes the newest place of that caller, whose request
 * is refused (`place-given`); otherwise the asker is refused (`queue-full`). So one caller alone may fill
 * the queue, and no caller can keep the others out of it. A caller is never made to give up its only
 * place, and a turn that is held is never taken away.
 *
 * Turns: a free renderer goes to the waiting caller that has used it least, counted as the time it held
 * the renderer, halved every `halfLifeMs` so that old use is forgotten. Between callers that have used it
 * equally the one whose oldest request arrived first goes first, and one caller's requests are served in
 * the order they came.
 *
 * The bound: a waiting caller is passed over only by a caller that has used the renderer less than it has
 * (or as much, with an older request). The others therefore get ahead of it by no more than the difference
 * in use plus one render each, and `maxWaitMs` ends its wait in any case.
 */

export type RefusalReason = "queue-full" | "queue-wait" | "place-given";

/** Rejects `enter` when the queue has no place for this caller, took its place away, or kept it waiting too long. */
export class QueueRefusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`refused: ${reason}`);
  }
}

/** Rejects `enter` when the caller's `signal` aborted before it had its turn. */
export class QueueCancelled extends Error {
  constructor() {
    super("cancelled while waiting");
  }
}

export interface FairQueueOptions {
  /** Turns that may be held at once. */
  maxRunning: number;
  /** Requests that may wait, all callers together. */
  maxWaiting: number;
  /** Longest one request waits before it is refused (`queue-wait`). */
  maxWaitMs: number;
  /** Time after which a caller's past use counts half. */
  halfLifeMs: number;
  /** Most callers whose use is remembered; past this the one charged longest ago is forgotten. */
  maxAccounts?: number;
  now?: () => number;
}

/** A turn at the renderer. `release` hands it on and charges the caller for the time it was held; a second call does nothing. */
export interface Turn {
  release: () => void;
}

interface Waiter {
  caller: string;
  grant: () => void;
  refuse: (error: Error) => void;
}

interface Account {
  /** Time the renderer was held, as of `at`. */
  used: number;
  at: number;
}

/** Use that has decayed below this many milliseconds is nothing: the account is dropped. */
const FORGOTTEN_BELOW_MS = 1;

export class FairQueue {
  private running = 0;
  /** In order of arrival. */
  private readonly waiting: Waiter[] = [];
  /** By caller, least recently charged first. */
  private readonly accounts = new Map<string, Account>();
  private readonly now: () => number;
  private readonly maxAccounts: number;

  constructor(private readonly options: FairQueueOptions) {
    this.now = options.now ?? (() => performance.now());
    this.maxAccounts = options.maxAccounts ?? 1024;
  }

  /** Requests that wait right now. */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** Turns held right now. */
  get runningCount(): number {
    return this.running;
  }

  /** Callers whose use is remembered right now. */
  get accountCount(): number {
    return this.accounts.size;
  }

  /** How long `caller` has held the renderer, with old use counted less. */
  usage(caller: string, at = this.now()): number {
    const account = this.accounts.get(caller);
    return account ? account.used * 2 ** (-Math.max(0, at - account.at) / this.options.halfLifeMs) : 0;
  }

  /**
   * Ask for a turn. Resolves when it is this request's; rejects with `QueueRefusal` or, when `signal`
   * aborts first, `QueueCancelled`: a caller that went away leaves the queue and is never given a turn.
   */
  enter(caller: string, signal?: AbortSignal): Promise<Turn> {
    if (signal?.aborted) return Promise.reject(new QueueCancelled());
    if (this.running < this.options.maxRunning) {
      this.running++;
      return Promise.resolve(this.turn(caller));
    }
    if (this.waiting.length >= this.options.maxWaiting) {
      const giver = this.placeToTake(caller);
      if (!giver) return Promise.reject(new QueueRefusal("queue-full"));
      giver.refuse(new QueueRefusal("place-given"));
    }
    return new Promise<Turn>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        return at >= 0;
      };
      const refuse = (error: Error) => {
        if (leave()) reject(error);
      };
      const onAbort = () => refuse(new QueueCancelled());
      const timer = setTimeout(() => refuse(new QueueRefusal("queue-wait")), this.options.maxWaitMs);
      timer.unref?.();
      const waiter: Waiter = {
        caller,
        refuse,
        grant: () => {
          leave();
          resolve(this.turn(caller));
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private turn(caller: string): Turn {
    const since = this.now();
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        const at = this.now();
        this.charge(caller, at - since, at);
        const next = this.next(at);
        if (next) next.grant();
        else this.running--;
      },
    };
  }

  private charge(caller: string, ms: number, at: number) {
    const used = this.usage(caller, at) + Math.max(0, ms);
    // Deleted first so that the map stays in the order the callers were last charged in.
    this.accounts.delete(caller);
    this.accounts.set(caller, { used, at });
    for (const key of this.accounts.keys()) if (this.usage(key, at) < FORGOTTEN_BELOW_MS) this.accounts.delete(key);
    if (this.accounts.size > this.maxAccounts) this.accounts.delete(this.accounts.keys().next().value as string);
  }

  /** The waiting request whose turn it is: the oldest one of the caller that has used the renderer least. */
  private next(at: number): Waiter | undefined {
    let next: Waiter | undefined;
    let least = Infinity;
    // Oldest first, and only a smaller use replaces the choice: between equals the older request stays.
    for (const waiter of this.waiting) {
      const used = this.usage(waiter.caller, at);
      if (used < least) [next, least] = [waiter, used];
    }
    return next;
  }

  /** With every place taken: the waiting request that gives its place to a new one from `caller`, if any must. */
  private placeToTake(caller: string): Waiter | undefined {
    const places = new Map<string, number>();
    for (const waiter of this.waiting) places.set(waiter.caller, (places.get(waiter.caller) ?? 0) + 1);
    const most = Math.max(0, ...places.values());
    // At least two more than the asker: the giver keeps a place, and the asker does not end up with more than it.
    if (most <= (places.get(caller) ?? 0) + 1) return undefined;
    // Newest first: of two callers that hold the most, the one whose newest request came last.
    return this.waiting.findLast((waiter) => places.get(waiter.caller) === most);
  }
}
