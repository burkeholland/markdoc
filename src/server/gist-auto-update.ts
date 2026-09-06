import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb, schema, withGistPublicationLock, withGistSettingsLock } from "@/server/db";
import type { SessionUser } from "@/server/documents";
import { readLiveText } from "@/server/livedoc";
import { HttpError } from "@/server/http";
import { previewGistAutoUpdate, publishSavedGist, savedCleanText, type LinkedDocument } from "@/server/publish";
import type { GistAutoUpdateDestination, GistAutoUpdateSettings, GistAutoUpdateStatus } from "@/lib/gist-auto-update";

const jobs = schema.gistAutoUpdates;
type Job = typeof jobs.$inferSelect;
type OwnedDocument = LinkedDocument & { ownerId: string };
export const GIST_SAVE_DEBOUNCE_MS = 2000;
export const GIST_WORKER_SHUTDOWN_MS = 2000;

function destination(job: Job): GistAutoUpdateDestination {
  return { gistId: job.gistId, filename: job.filename, url: `https://gist.github.com/${job.gistId}`, visibility: job.isPublic ? "public" : "secret", owner: job.accountLogin };
}

function sameDestination(a: GistAutoUpdateDestination, b: GistAutoUpdateDestination) {
  return a.gistId === b.gistId && a.filename === b.filename && a.visibility === b.visibility && a.owner.toLowerCase() === b.owner.toLowerCase() && a.url === b.url;
}

const off = (): GistAutoUpdateStatus => ({ enabled: false, status: "off", syncedAt: null, message: null, pending: false, destination: null });

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
}

export async function gistAutoUpdateStatus(doc: OwnedDocument): Promise<GistAutoUpdateStatus> {
  const db = await getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.documentId, doc.id));
  if (!job || doc.storage !== "gist" || doc.gistId !== job.gistId || doc.gistFile !== job.filename || doc.ownerId !== job.publisherId) return off();
  const queueUnavailable = job.enabled && globalWorker.__markdocGistWorker?.stopped && globalWorker.__markdocGistWorker.failures >= 5;
  return {
    enabled: job.enabled,
    status: queueUnavailable ? "failed" : job.enabled ? job.status : "off",
    syncedAt: job.syncedAt?.toISOString() ?? null,
    message: queueUnavailable ? "Automatic publishing paused after repeated queue errors. Retry to resume the queue; your saved edits are retained."
      : !job.enabled && job.activeVersion !== null ? "Auto-update is off. An update already in progress may still finish." : job.message,
    pending: job.enabled && job.queuedVersion > (job.activeVersion ?? job.syncedVersion),
    destination: destination(job),
  };
}

export async function configureGistAutoUpdate(doc: OwnedDocument, user: SessionUser, settings: GistAutoUpdateSettings): Promise<GistAutoUpdateStatus> {
  if (doc.ownerId !== user.id) throw new HttpError(403, "Only the document owner can configure auto-update.");
  const locked = await withGistSettingsLock(doc.id, (signal) => configureWithinSettingsLock(doc, user, settings, signal));
  if (!locked.acquired) throw new HttpError(409, "Auto-update settings are already being changed. Try again after that request finishes.");
  return locked.value;
}

async function configureWithinSettingsLock(doc: OwnedDocument, user: SessionUser, settings: GistAutoUpdateSettings, settingsSignal: AbortSignal): Promise<GistAutoUpdateStatus> {
  const db = await getDb();
  settingsSignal.throwIfAborted();
  if (!settings.enabled) {
    settingsSignal.throwIfAborted();
    await db.update(jobs).set({ enabled: false, status: "off", message: null }).where(and(eq(jobs.documentId, doc.id), eq(jobs.publisherId, user.id)));
    return gistAutoUpdateStatus(doc);
  }
  if (settings.acknowledgeRisk !== true) throw new HttpError(400, "Acknowledge the publishing and concurrent-edit risks before enabling auto-update.");
  if (doc.storage !== "gist" || !doc.gistId || !doc.gistFile || !doc.publishedAt) throw new HttpError(409, "Publish and link a gist first.");
  const locked = await withGistPublicationLock(doc.gistId, doc.gistFile, async (signal) => {
    const preview = await previewGistAutoUpdate(doc, user);
    signal.throwIfAborted();
    if (!sameDestination(preview.destination, settings.destination)) throw new HttpError(409, "The gist destination, visibility, or account changed. Review it and acknowledge again.", { status: "conflict" });
    const live = await readLiveText(doc.id);
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).for("update");
      if (!current || current.deletedAt || current.ownerId !== user.id || current.storage !== "gist" || current.gistId !== doc.gistId || current.gistFile !== doc.gistFile || !current.publishedAt) {
        throw new HttpError(409, "The document connection changed. Reopen publishing controls.");
      }
      if (savedCleanText(current) !== live.clean) {
        throw new HttpError(409, "Wait for Markdoc to finish saving before enabling auto-update, then check the linked gist again. The auto-update setting has not changed.");
      }
      const values = {
        documentId: doc.id, publisherId: user.id, gistId: doc.gistId!, filename: doc.gistFile!,
        accountLogin: preview.destination.owner, isPublic: preview.destination.visibility === "public",
        enabled: true, acknowledgedAt: new Date(), generation: randomUUID(),
        queuedVersion: 1, syncedVersion: 0, activeVersion: null, dueAt: new Date(Date.now() + GIST_SAVE_DEBOUNCE_MS),
        status: "pending" as const, syncedAt: null, message: null,
      };
      settingsSignal.throwIfAborted();
      signal.throwIfAborted();
      if (current.githubSha === null) {
        await tx.update(schema.documents).set({ githubSha: preview.revision }).where(eq(schema.documents.id, doc.id));
      }
      signal.throwIfAborted();
      await tx.insert(jobs).values(values).onConflictDoUpdate({ target: jobs.documentId, set: values });
      signal.throwIfAborted();
    });
  }, settingsSignal);
  if (!locked.acquired) throw new HttpError(409, "A gist update is already in progress. Wait for it to finish before enabling auto-update.");
  resumeUnavailableQueue();
  return gistAutoUpdateStatus(doc);
}

export async function retryGistAutoUpdate(doc: OwnedDocument, user: SessionUser): Promise<GistAutoUpdateStatus> {
  if (doc.ownerId !== user.id) throw new HttpError(403, "Only the document owner can retry auto-update.");
  if (!(await gistAutoUpdateStatus(doc)).enabled) throw new HttpError(409, "Enable auto-update before retrying.");
  if (resumeUnavailableQueue()) return gistAutoUpdateStatus(doc);
  const db = await getDb();
  const changed = await db.update(jobs).set({ generation: randomUUID(), status: "pending", message: null, dueAt: new Date() }).where(and(
    eq(jobs.documentId, doc.id), eq(jobs.publisherId, user.id), eq(jobs.enabled, true), inArray(jobs.status, ["failed", "conflict"]),
  )).returning();
  if (!changed.length) throw new HttpError(409, "Auto-update must be enabled and paused before retrying.");
  return gistAutoUpdateStatus(doc);
}

function failure(error: unknown): { status: "failed" | "conflict"; message: string } {
  const code = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (code === 409 || code === 404 || code === 413) return { status: "conflict", message: "The linked gist changed, disappeared, or cannot be compared with its baseline. Review it with Sync before retrying. Your Markdoc edits are saved." };
  if (code === 401 || code === 403 || code === 400) return { status: "failed", message: "GitHub authorization is unavailable or changed. Reconnect the account that owns the gist, then retry. Your Markdoc edits are saved." };
  if (code === 429) return { status: "failed", message: "GitHub is rate limiting requests. Retry the latest saved version later." };
  return { status: "failed", message: "The gist update failed or its completion is unknown. Review the gist, then retry the latest saved version. Your Markdoc edits are saved." };
}

async function processJob(candidate: Job, cancellation?: AbortSignal): Promise<void> {
  cancellation?.throwIfAborted();
  await withGistPublicationLock(candidate.gistId, candidate.filename, async (signal) => {
    signal.throwIfAborted();
    const db = await getDb();
    signal.throwIfAborted();
    const [snapshot] = await db.select({ job: jobs, doc: schema.documents, user: schema.users }).from(jobs)
      .innerJoin(schema.documents, eq(jobs.documentId, schema.documents.id))
      .innerJoin(schema.users, eq(jobs.publisherId, schema.users.id))
      .where(eq(jobs.documentId, candidate.documentId));
    signal.throwIfAborted();
    if (!snapshot || !snapshot.job.enabled) return;
    const { job, doc, user } = snapshot;
    if (job.generation !== candidate.generation || job.gistId !== candidate.gistId || job.filename !== candidate.filename) return;
    const currentJob = and(eq(jobs.documentId, doc.id), eq(jobs.generation, job.generation));
    if (doc.deletedAt || doc.ownerId !== job.publisherId || doc.storage !== "gist" || doc.gistId !== job.gistId || doc.gistFile !== job.filename) {
      await db.update(jobs).set({ enabled: false, status: "off", activeVersion: null, message: "The document or its gist connection changed." }).where(currentJob);
      return;
    }
    // The database lock is free, so a durable "syncing" row was left by an interrupted worker.
    // Do not silently resend a request whose provider-side completion is unknown.
    if (job.status === "syncing") {
      await db.update(jobs).set({ status: "failed", activeVersion: null, message: "The previous update was interrupted. Review the gist, then retry the latest saved version." }).where(currentJob);
      return;
    }
    if (job.status !== "pending" || job.dueAt.getTime() > Date.now()) return;
    const claimed = await db.update(jobs).set({ status: "syncing", activeVersion: job.queuedVersion, message: null }).where(and(
      currentJob, eq(jobs.enabled, true), eq(jobs.status, "pending"), eq(jobs.queuedVersion, job.queuedVersion), lte(jobs.dueAt, new Date()),
    )).returning();
    if (!claimed.length) return;
    const claimedJob = and(currentJob, eq(jobs.activeVersion, job.queuedVersion));
    const beforeSend = async () => {
      signal.throwIfAborted();
      const [grant] = await db.select({ enabled: jobs.enabled }).from(jobs).where(and(claimedJob, eq(jobs.enabled, true)));
      signal.throwIfAborted();
      if (!grant) throw new HttpError(410, "Auto-update was disabled or superseded before sending.");
    };
    try {
      signal.throwIfAborted();
      const result = await publishSavedGist(doc, { id: user.id, name: user.name, login: user.login, image: user.image }, {
        content: savedCleanText(doc), baseline: doc.publishedContent, accountLogin: job.accountLogin, isPublic: job.isPublic, signal,
        beforeSend,
        dispatch: async <T>(send: () => Promise<T>) => {
          let completion: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
          try {
            const dispatch = await withGistSettingsLock(doc.id, async (settingsSignal) => {
              await beforeSend();
              settingsSignal.throwIfAborted();
              // Release the settings lock after initiation, not after the HTTP response. Attach both
              // handlers immediately so a fast rejection is retained while the lock session closes.
              completion = send().then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
              return { completion };
            }, signal);
            if (!dispatch.acquired) throw new HttpError(503, "Publishing settings are changing. Retry the latest saved version.");
            const result = await dispatch.value.completion;
            if (!result.ok) throw result.error;
            return result.value;
          } finally {
            // A settings-lock failure must not release the publication lock while HTTP is still active.
            await completion;
          }
        },
        recordPublished: async (patch) => {
          signal.throwIfAborted();
          await db.transaction(async (tx) => {
            const [current] = await tx.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).for("update");
            const [grant] = await tx.select({ generation: jobs.generation }).from(jobs).where(claimedJob).for("update");
            signal.throwIfAborted();
            if (!current || !grant || current.ownerId !== job.publisherId || current.storage !== "gist" || current.gistId !== job.gistId || current.gistFile !== job.filename) {
              throw new HttpError(409, "The publishing destination changed before the completed update could be recorded.");
            }
            await tx.update(schema.documents).set({ ...patch, updatedAt: new Date() }).where(eq(schema.documents.id, doc.id));
            signal.throwIfAborted();
          });
        },
      });
      signal.throwIfAborted();
      await db.transaction(async (tx) => {
        signal.throwIfAborted();
        await tx.update(jobs).set({
          syncedVersion: job.queuedVersion, syncedAt: new Date(result.publishedAt), activeVersion: null,
          status: sql`CASE WHEN NOT ${jobs.enabled} THEN 'off' WHEN ${jobs.queuedVersion} > ${job.queuedVersion} THEN 'pending' ELSE 'synced' END`,
          message: result.warnings?.length ? "The gist was updated, but its version history could not be recorded." : null,
        }).where(claimedJob);
        signal.throwIfAborted();
      });
    } catch (error) {
      // Cancellation leaves a claimed receipt unresolved for explicit recovery, never "synced".
      if (signal.aborted) throw error;
      const failed = failure(error);
      await db.update(jobs).set({
        activeVersion: null,
        status: sql`CASE WHEN ${jobs.enabled} THEN ${failed.status} ELSE 'off' END`,
        message: sql`CASE WHEN ${jobs.enabled} THEN ${failed.message} ELSE NULL END`,
      }).where(claimedJob);
      // Never log provider errors: they can contain the request body or authorization headers.
      if (!(error instanceof HttpError) || error.status !== 410) console.error("[gist-auto-update] publication-paused", doc.id, failed.status);
    }
  }, cancellation);
}

/** Poll durable save receipts, not editor events. The trigger and document save commit together. */
export async function runGistAutoUpdateQueue(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const db = await getDb();
  signal?.throwIfAborted();
  const candidates = await db.select().from(jobs).where(and(
    eq(jobs.enabled, true), inArray(jobs.status, ["pending", "syncing"]), lte(jobs.dueAt, new Date()),
  )).orderBy(jobs.dueAt).limit(4);
  signal?.throwIfAborted();
  const results = await Promise.allSettled(candidates.map((candidate) => processJob(candidate, signal)));
  const failed = results.find((result) => result.status === "rejected" && (!signal || !isCancellation(result.reason, signal)))
    ?? results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

type Worker = {
  timer: ReturnType<typeof setTimeout> | null;
  pending: Promise<void> | null;
  stopped: boolean;
  failures: number;
  controller: AbortController;
  shutdown?: Promise<void>;
  shutdownFailed?: boolean;
};
const globalWorker = globalThis as typeof globalThis & { __markdocGistWorker?: Worker };

function resumeUnavailableQueue(): boolean {
  if (!globalWorker.__markdocGistWorker?.stopped || globalWorker.__markdocGistWorker.controller.signal.aborted || globalWorker.__markdocGistWorker.failures < 5) return false;
  startGistAutoUpdateWorker();
  return true;
}

export function startGistAutoUpdateWorker(): void {
  if (globalWorker.__markdocGistWorker && !globalWorker.__markdocGistWorker.stopped) return;
  if (globalWorker.__markdocGistWorker?.pending) throw new Error("The previous gist worker is still stopping");
  const worker: Worker = { timer: null, pending: null, stopped: false, failures: 0, controller: new AbortController() };
  globalWorker.__markdocGistWorker = worker;
  const tick = () => {
    if (worker.stopped) return;
    worker.pending = runGistAutoUpdateQueue(worker.controller.signal).then(() => { worker.failures = 0; }).catch((error: unknown) => {
      if (worker.controller.signal.aborted) {
        if (!isCancellation(error, worker.controller.signal)) {
          worker.shutdownFailed = true;
          console.error("[gist-auto-update] shutdown-failed");
        }
        return;
      }
      worker.failures++;
      console.error("[gist-auto-update] queue-unavailable", worker.failures);
      if (worker.failures >= 5) worker.stopped = true;
    }).finally(() => {
      worker.pending = null;
      if (!worker.stopped) worker.timer = setTimeout(tick, worker.failures ? Math.min(30_000, 1000 * 2 ** worker.failures) : 250).unref();
    });
  };
  worker.timer = setTimeout(tick, 250).unref();
}

export function stopGistAutoUpdateWorker(): Promise<void> {
  const worker = globalWorker.__markdocGistWorker;
  if (!worker) return Promise.resolve();
  if (worker.shutdown) return worker.shutdown;
  worker.stopped = true;
  if (worker.timer) clearTimeout(worker.timer);
  worker.controller.abort();
  worker.shutdown = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error("[gist-auto-update] shutdown-timeout");
      reject(new Error("Gist worker shutdown exceeded its deadline; canceled work remains fenced"));
    }, GIST_WORKER_SHUTDOWN_MS);
    // Retain the pending promise until it actually settles: no replacement poller may overlap it.
    Promise.resolve(worker.pending).then(() => {
      clearTimeout(timer);
      if (worker.shutdownFailed) reject(new Error("Gist worker coordination did not stop cleanly"));
      else resolve();
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return worker.shutdown;
}
