/**
 * Runs the Markdown pipeline on a worker thread with a time-out, so one pathological document
 * can never stall the event loop (health probes, collaboration WebSocket, other users).
 *
 * One lazily started worker handles jobs in FIFO order; a job that exceeds its budget gets the
 * worker terminated (the only way to stop synchronous parsing) and a fresh one started for the
 * next job. The worker exits on its own after a quiet period and never keeps the process alive.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { WORKER_ROLE, type RenderedFragment, type WorkerRequest, type WorkerResponse } from "./render-markdown";

/**
 * Default budget for one render (`MARKDOWN_RENDER_TIMEOUT_MS` overrides). The guard keeps ordinary
 * documents far below this; the pipeline itself needs ~5 s per MB of link-dense text, so a legal
 * 2 MB document still fits. Because parsing is off the event loop, the budget only bounds wasted
 * CPU on a worker, not how long other requests wait.
 */
export const RENDER_TIMEOUT_MS = Number(process.env.MARKDOWN_RENDER_TIMEOUT_MS) || 15_000;
const IDLE_EXIT_MS = 30_000;

export class RenderTimeoutError extends Error {
  constructor(ms: number) {
    super(`Markdown rendering exceeded ${ms} ms`);
    this.name = "RenderTimeoutError";
  }
}

interface Job {
  id: number;
  markdown: string;
  assetBaseUrl: string;
  timeoutMs: number;
  resolve: (r: RenderedFragment) => void;
  reject: (e: Error) => void;
}

/**
 * The worker entry. In development (tsx / vitest) Node runs the TypeScript source directly (type
 * stripping, Node ≥ 22.18); the production bundle is emitted next to `dist/server.mjs` by
 * `scripts/build-server.mjs`. `MARKDOWN_WORKER_PATH` overrides both.
 */
function workerPath(): string {
  if (process.env.MARKDOWN_WORKER_PATH) return process.env.MARKDOWN_WORKER_PATH;
  const candidates =
    process.env.NODE_ENV === "production"
      ? ["dist/render-worker.mjs", "src/server/export/render-markdown.ts"]
      : ["src/server/export/render-markdown.ts", "dist/render-worker.mjs"];
  for (const rel of candidates) {
    const abs = path.resolve(/* turbopackIgnore: true */ process.cwd(), rel);
    if (existsSync(abs)) return abs;
  }
  throw new Error(`Markdown render worker not found (looked for ${candidates.join(", ")} under ${process.cwd()})`);
}

/**
 * Resolved at runtime rather than imported: Turbopack statically analyses `new Worker(<dynamic>)`
 * from a `worker_threads` import and tries to bundle every file under the project root as a
 * possible worker entry, which breaks the dev build on Markdown/JSONC files.
 */
const { Worker: WorkerCtor } = process.getBuiltinModule("node:worker_threads") as typeof import("node:worker_threads");

class RenderPool {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private timer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  render(markdown: string, assetBaseUrl: string, timeoutMs: number): Promise<RenderedFragment> {
    return new Promise<RenderedFragment>((resolve, reject) => {
      this.queue.push({ id: ++this.seq, markdown, assetBaseUrl, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const job = this.queue.shift()!;
    this.current = job;
    try {
      const worker = this.ensureWorker();
      this.timer = setTimeout(() => {
        if (this.worker !== worker || this.current !== job) return;
        this.fail(job, new RenderTimeoutError(job.timeoutMs), true);
        this.pump();
      }, job.timeoutMs);
      const req: WorkerRequest = { id: job.id, markdown: job.markdown, assetBaseUrl: job.assetBaseUrl };
      worker.postMessage(req);
    } catch (err) {
      this.fail(job, err instanceof Error ? err : new Error(String(err)), true);
      // A backlog of setup failures must not recurse or monopolize this event-loop turn.
      if (this.queue.length) setImmediate(() => this.pump());
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new WorkerCtor(workerPath(), { workerData: { role: WORKER_ROLE }, stderr: false, stdout: false });
    // Never keep the server (or a test runner) alive just because a render thread exists.
    worker.unref();
    worker.on("message", (msg: WorkerResponse) => {
      if (this.worker !== worker) return;
      const job = this.current;
      if (!job || msg.id !== job.id) return;
      this.finish();
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error));
      this.pump();
    });
    worker.on("error", (err) => {
      if (this.worker !== worker) return;
      const job = this.current;
      this.discardWorker(worker);
      if (job) this.fail(job, err instanceof Error ? err : new Error(String(err)), false);
      this.pump();
    });
    worker.on("exit", () => {
      if (this.worker !== worker) return;
      const job = this.current;
      this.discardWorker(worker);
      if (job) this.fail(job, new Error("Markdown render worker exited unexpectedly"), false);
      this.pump();
    });
    this.worker = worker;
    return worker;
  }

  private discardWorker(worker: Worker) {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private finish() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    if (this.queue.length === 0 && this.worker) {
      const worker = this.worker;
      this.idleTimer = setTimeout(() => {
        if (this.worker === worker && !this.current) {
          this.discardWorker(worker);
          void worker.terminate();
        }
      }, IDLE_EXIT_MS);
      this.idleTimer.unref();
    }
  }

  private fail(job: Job, err: Error, terminate: boolean) {
    if (this.current !== job) return;
    const worker = this.worker;
    if (terminate && worker) this.discardWorker(worker);
    this.finish();
    if (terminate && worker) void worker.terminate();
    job.reject(err);
  }
}

const pool = new RenderPool();

/** Render on the worker thread; rejects with `RenderTimeoutError` after `timeoutMs`. */
export function renderOffThread(markdown: string, assetBaseUrl: string, timeoutMs = RENDER_TIMEOUT_MS): Promise<RenderedFragment> {
  return pool.render(markdown, assetBaseUrl, timeoutMs);
}
