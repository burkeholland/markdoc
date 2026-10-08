/**
 * Letting other requests in while one long piece of work runs (#2290 for the PDF page, #2341 for large writes).
 *
 * Node serves every request from one thread. A step that comes back without the event loop having turned
 * (the embedded database answers in this thread; so does anything computed) kept everybody else waiting
 * for as long as it took, and several such steps in a row add up: a write of a 2,000,000 character
 * document loaded, changed, stored and versioned it in one unbroken run of 2 to 4.6 s. A step that waited
 * for a socket (PostgreSQL) lets the loop turn by itself and costs nothing here.
 */

/** How much unbroken work may add up before the others get a turn. */
export const MAX_UNBROKEN_WORK_MS = 50;
/**
 * How long they get. A real wait and not one turn of the event loop: a request needs several turns
 * (accept, read, answer), and one turn between two long steps would let it advance one step each time.
 */
export const STEP_ASIDE_MS = 25;

export interface PaceClock {
  now(): number;
  /** Resolves after `ms`; the event loop turns meanwhile. */
  wait(ms: number): Promise<void>;
}

const realClock: PaceClock = {
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Wait `STEP_ASIDE_MS` so that requests that came in meanwhile are served. */
export function stepAside(clock: PaceClock = realClock): Promise<void> {
  return clock.wait(STEP_ASIDE_MS);
}

/**
 * Runs the steps of one longer piece of work. A step that came back before the event loop could turn is
 * timed, and whenever `MAX_UNBROKEN_WORK_MS` of such steps have added up, the pace steps aside for
 * `STEP_ASIDE_MS` before it returns. So between two steps that each block for long there is always a wait,
 * many short ones share one, and steps that let the loop turn by themselves are never followed by one.
 */
export class Pace {
  private unbroken = 0;
  /** Waits so far (tests). */
  waits = 0;

  constructor(private readonly clock: PaceClock = realClock) {}

  async step<T>(work: () => T | Promise<T>): Promise<T> {
    const startedAt = this.clock.now();
    let turned = false;
    const turn = setImmediate(() => (turned = true));
    try {
      return await work();
    } finally {
      clearImmediate(turn);
      if (!turned) this.unbroken += this.clock.now() - startedAt;
      if (this.unbroken >= MAX_UNBROKEN_WORK_MS) {
        this.unbroken = 0;
        this.waits++;
        await stepAside(this.clock);
      }
    }
  }
}
