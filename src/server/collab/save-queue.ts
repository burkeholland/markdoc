import { CONTENT_AUTOSAVE_IDLE_MS, type PersistenceState } from "@/lib/document-persistence";

const RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

/** One writer per live server document. Yjs owns the merged pending operations, not this timer. */
export class DocumentSaveQueue<T> {
  revision = 0;
  savedRevision = 0;
  saved: T | null = null;
  error: Error | null = null;
  private deadline = 0;
  private retryAt = 0;
  private failures = 0;
  private forceThrough = 0;
  private priorityThrough = 0;
  private composing = new Set<unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private waiters: { revision: number; resolve: (saved: T | null) => void; reject: (error: Error) => void }[] = [];
  private lastState: PersistenceState = "saved";

  constructor(
    private readonly write: (revision: number) => Promise<T>,
    private readonly changed: (committed: boolean) => void,
    private readonly idleMs: () => number = () => CONTENT_AUTOSAVE_IDLE_MS,
  ) {}

  get dirty(): boolean {
    return this.revision > this.savedRevision;
  }

  get inFlight(): boolean {
    return this.running;
  }

  get state(): PersistenceState {
    if (this.running) return "saving";
    if (this.error) return "error";
    return this.dirty ? "pending" : "saved";
  }

  edit(content: boolean) {
    this.revision++;
    this.deadline = content ? Date.now() + this.idleMs() : Date.now();
    // Non-content operations (comments, title, etc.) are never held behind content typing.
    if (!content) this.priorityThrough = this.revision;
    this.publish();
    this.schedule();
  }

  composition(owner: unknown, active: boolean) {
    if (active) this.composing.add(owner);
    else if (this.composing.delete(owner) && this.dirty) this.deadline = Date.now() + this.idleMs();
    this.schedule();
  }

  /** Capture the caller's pending revision; a later edit must not be acknowledged by an older write. */
  flush(): Promise<T | null> {
    if (!this.dirty) return Promise.resolve(this.saved);
    this.forceThrough = this.revision;
    this.failures = 0;
    this.retryAt = 0;
    const promise = new Promise<T | null>((resolve, reject) => {
      this.waiters.push({ revision: this.revision, resolve, reject });
    });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) void this.run();
    return promise;
  }

  private publish(committed = false) {
    const state = this.state;
    if (committed || state !== this.lastState) {
      this.lastState = state;
      this.changed(committed);
    }
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running || !this.dirty || this.failures > RETRY_DELAYS.length) return;
    const forced = Math.max(this.forceThrough, this.priorityThrough) > this.savedRevision;
    if (this.composing.size && !forced) return;
    const due = Math.max(forced ? 0 : this.deadline, this.retryAt);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, Math.max(0, due - Date.now()));
  }

  private async run() {
    if (this.running || !this.dirty) return;
    const revision = this.revision;
    this.running = true;
    this.publish();
    let committed = false;
    try {
      this.saved = await this.write(revision);
      this.savedRevision = revision;
      this.error = null;
      this.failures = 0;
      this.retryAt = 0;
      committed = true;
      const complete = this.waiters.filter((waiter) => waiter.revision <= revision);
      this.waiters = this.waiters.filter((waiter) => waiter.revision > revision);
      complete.forEach((waiter) => waiter.resolve(this.saved));
    } catch (error) {
      this.error = error instanceof Error ? error : new Error("Document persistence failed");
      this.failures++;
      this.retryAt = Date.now() + (RETRY_DELAYS[this.failures - 1] ?? 0);
      this.waiters.splice(0).forEach((waiter) => waiter.reject(this.error!));
      // A failed explicit save retries like autosave, rather than continually forcing writes.
      this.forceThrough = this.savedRevision;
    } finally {
      this.running = false;
      this.publish(committed);
      this.schedule();
    }
  }
}
