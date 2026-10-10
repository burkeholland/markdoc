import { getGitHubToken, getPublishedContent, updateDocument, addVersion, type DocumentMeta, type SessionUser } from "@/server/documents";
import type { Document } from "@/server/db/schema";
import { HttpError, actorName } from "@/server/http";
import {
  githubClient,
  updateGist,
  createGist,
  commitRepoFile,
  readGistFile,
  readRepoFile,
  currentGitHubLogin,
  gistContent,
  isGitHubMock,
  GitHubFileTooLargeError,
} from "@/server/github";
import { cleanTextOf, readLiveText, replaceLiveText } from "@/server/livedoc";
import { hydrateDoc } from "@/server/collab/seed";
import * as Y from "yjs";
import type { CollabContext } from "@/server/collab/hocuspocus";
import { warnTail, type WarningCode } from "@/server/warnings";
import { managedAccountGistRefusal } from "@/server/github/managed-account";
import { diff3Merge, diffIndices } from "node-diff3";
import type { GistAutoUpdatePreview } from "@/lib/gist-auto-update";
import { getDb, schema, withGistPublicationLock } from "@/server/db";
import { eq } from "drizzle-orm";

export interface PublishResult {
  url: string | null;
  commitSha: string | null;
  publishedAt: string;
  skipped?: boolean;
  status: SyncState;
  /**
   * Post-write bookkeeping that failed (the commit and the base stand); omitted when nothing did. A 500 here would
   * break the API's "a non-2xx status means nothing changed" promise: GitHub (or the live text, or the link) did
   * change, and only a version or activity row is missing — so the route answers 2xx with `warnings` instead.
   */
  warnings?: WarningCode[];
}

/** Where the document lives on GitHub; the metadata an access check returns is enough. */
export type LinkedDocument = Pick<DocumentMeta, "id" | "title" | "storage" | "gistId" | "gistFile" | "repoOwner" | "repoName" | "repoBranch" | "repoPath" | "githubSha" | "publishedAt">;

export function githubUrlFor(doc: Pick<LinkedDocument, "storage" | "gistId" | "repoOwner" | "repoName" | "repoBranch" | "repoPath">): string | null {
  if (doc.storage === "gist" && doc.gistId) return `https://gist.github.com/${doc.gistId}`;
  if (doc.storage === "repo" && doc.repoOwner && doc.repoName && doc.repoPath) {
    return `https://github.com/${doc.repoOwner}/${doc.repoName}/blob/${doc.repoBranch ?? "main"}/${doc.repoPath}`;
  }
  return null;
}

async function publishingTokenFor(user: SessionUser) {
  if (isGitHubMock()) return "mock";
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "Your account has no GitHub token. Sign in with GitHub to use gists and repositories.");
  return token;
}

async function octokitFor(user: SessionUser, signal?: AbortSignal) {
  return githubClient(await publishingTokenFor(user), signal);
}

/** Read-only preparation, not permission to PATCH: a fresh GET cannot close the gist write race. */
export async function previewGistAutoUpdate(doc: LinkedDocument & { ownerId: string }, user: SessionUser): Promise<GistAutoUpdatePreview & { revision: string }> {
  if (doc.ownerId !== user.id) throw new HttpError(403, "Only the document owner can configure auto-update.");
  if (doc.storage !== "gist" || !doc.gistId || !doc.gistFile || !doc.publishedAt) {
    throw new HttpError(409, "Publish and link this document to a gist before configuring auto-update.", { status: "failed" });
  }
  const octokit = await octokitFor(user);
  let file: Awaited<ReturnType<typeof readGistFile>>;
  let login: string;
  try {
    login = await currentGitHubLogin(octokit);
    file = await readGistFile(octokit, doc.gistId, doc.gistFile);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
    if (status === 404) throw new HttpError(409, "The linked gist or file is missing or inaccessible. Check the connection; auto-update remains off.", { status: "failed" });
    if (status === 401 || status === 403) throw new HttpError(403, "GitHub access was lost. Sign in with the account that owns the gist; auto-update remains off.", { status: "failed" });
    if (status === 429) throw new HttpError(429, "GitHub is rate limiting requests. Try checking the destination later; auto-update remains off.", { status: "failed" });
    if (typeof status === "number" && status >= 500) throw new HttpError(502, "GitHub could not check the destination. Try again later; auto-update remains off.", { status: "failed" });
    throw new HttpError(502, "The gist destination could not be verified. Check GitHub access and try again; auto-update remains off.", { status: "failed" });
  }
  if (file.gistId !== doc.gistId || file.filename !== doc.gistFile) {
    throw new HttpError(409, "The linked gist destination changed. Review the connection; auto-update remains off.", { status: "conflict" });
  }
  if (!file.owner || file.owner.toLowerCase() !== login.toLowerCase()) {
    throw new HttpError(403, "The connected GitHub account does not own this gist. Auto-update remains off.", { status: "failed" });
  }
  const base = await getPublishedContent(doc.id);
  if (file.truncated || file.contentKnown === false || file.visibilityKnown === false || file.revision === null || base === null || file.content !== gistContent(base) || (doc.githubSha !== null && file.revision !== doc.githubSha)) {
    throw new HttpError(409, "The gist changed outside Markdoc or its last synced version is unknown. Review it with Sync before publishing; auto-update remains off.", { status: "conflict" });
  }
  return {
    revision: file.revision,
    destination: {
      gistId: doc.gistId,
      filename: doc.gistFile,
      url: githubUrlFor(doc)!,
      visibility: file.isPublic ? "public" : "secret",
      owner: file.owner,
    },
  };
}

function contextFor(user: SessionUser, docId: string): CollabContext {
  return { userId: user.id, docId, role: "owner", name: user.name ?? user.login ?? "User", login: user.login, avatar: user.image ?? null };
}

// ---------------------------------------------------------------------------
// Three-way sync. `publishedContent` is the merge base (last content both sides agreed on);
// `githubSha` is the remote revision at that point (file blob sha for repos, latest gist history
// version for gists — gists have no per-file sha, so the column is reused).
// ---------------------------------------------------------------------------

export type SyncState = "in-sync" | "local-ahead" | "remote-ahead" | "diverged";

export interface RemoteFile {
  content: string | null;
  /** Blob sha (repo) or gist history version; null when the file does not exist yet. */
  revision: string | null;
  url: string | null;
  updatedAt: string | null;
  gist?: { id: string; filename: string; owner: string | null; isPublic: boolean; truncated: boolean; contentKnown: boolean; visibilityKnown: boolean };
  /**
   * Set when the file exists but Markdoc could not read its text (larger than the 2 MB bound);
   * `content` is null then. Status, pull and a plain publish refuse with `413`; only a force-publish
   * may overwrite it.
   */
  unreadable?: { message: string; size: number | null; limit: number };
}

export interface SyncStatus {
  status: SyncState;
  remote: { sha: string | null; revision: string | null; url: string | null; updatedAt: string | null };
  localChanged: boolean;
  remoteChanged: boolean;
  /** Line counts for the UI summary: how far each side moved from the base. */
  lines: { local: number; remote: number };
  /** Only when asked for (`content`): the GitHub file as it is now. */
  remoteContent?: string;
}

export const SYNC_CACHE_MS = Math.max(0, Number(process.env.SYNC_CACHE_MS) || 30_000);
const remoteCache = new Map<string, { remote: RemoteFile; at: number }>();

/** Drop the cached remote read for a document (or all, in tests). */
export function clearSyncCache(docId?: string) {
  if (docId) remoteCache.delete(docId);
  else remoteCache.clear();
}

async function fetchRemote(doc: LinkedDocument, user: SessionUser, client?: Awaited<ReturnType<typeof octokitFor>>): Promise<RemoteFile> {
  const octokit = client ?? await octokitFor(user);
  try {
    if (doc.storage === "gist") {
      if (!doc.gistId) throw new HttpError(400, "Gist link is incomplete.");
      const file = await readGistFile(octokit, doc.gistId, doc.gistFile ?? undefined);
      return {
        content: file.content, revision: file.revision, url: file.htmlUrl, updatedAt: file.updatedAt,
        gist: {
          id: file.gistId, filename: file.filename, owner: file.owner, isPublic: file.isPublic, truncated: !!file.truncated,
          contentKnown: file.contentKnown !== false, visibilityKnown: file.visibilityKnown !== false,
        },
      };
    }
    if (!doc.repoOwner || !doc.repoName || !doc.repoPath) throw new HttpError(400, "Repository link is incomplete.");
    const file = await readRepoFile(octokit, doc.repoOwner, doc.repoName, doc.repoPath, doc.repoBranch ?? "main");
    return { content: file.content, revision: file.sha, url: file.htmlUrl, updatedAt: file.updatedAt ?? null };
  } catch (err) {
    if (err instanceof GitHubFileTooLargeError) {
      return { content: null, revision: err.revision, url: githubUrlFor(doc), updatedAt: null, unreadable: { message: err.message, size: err.size, limit: err.limit } };
    }
    const status = (err as { status?: number }).status;
    if (status === 404) return { content: null, revision: null, url: githubUrlFor(doc), updatedAt: null };
    throw err;
  }
}

/**
 * `413 { error, status: "remote-unreadable", size, limit, remote }`: the GitHub file is there but over
 * the document bound, so there is no remote text to compare with or pull.
 */
function unreadableRemote(remote: RemoteFile): HttpError {
  const u = remote.unreadable!;
  return new HttpError(413, u.message, {
    status: "remote-unreadable",
    size: u.size,
    limit: u.limit,
    remote: { sha: remote.revision, revision: remote.revision, url: remote.url, updatedAt: remote.updatedAt },
  });
}

/** Read the linked file, reusing a read made in the last 30 s unless `fresh`. */
async function readRemote(doc: LinkedDocument, user: SessionUser, fresh = false): Promise<RemoteFile> {
  const hit = remoteCache.get(doc.id);
  if (!fresh && hit && Date.now() - hit.at < SYNC_CACHE_MS) return hit.remote;
  const remote = await fetchRemote(doc, user);
  remoteCache.set(doc.id, { remote, at: Date.now() });
  return remote;
}

function rememberRemote(docId: string, remote: RemoteFile) {
  remoteCache.set(docId, { remote, at: Date.now() });
}

function changedLines(from: string, to: string): number {
  if (from === to) return 0;
  let n = 0;
  for (const hunk of diffIndices(from.split("\n"), to.split("\n"))) n += Math.max(hunk.buffer1[1], hunk.buffer2[1]);
  return n;
}

/**
 * Three-way classification. `base` is the last content both sides agreed on (`publishedContent`).
 *
 * | base | local | remote  | status       |
 * |------|-------|---------|--------------|
 * | B    | B     | B/none  | in-sync      |
 * | B    | L     | B/none  | local-ahead  |
 * | B    | B     | R       | remote-ahead |
 * | B    | L     | R (≠L)  | diverged     |
 * | B    | L     | L       | in-sync      | ← the base is merely behind
 *
 * The last row is a publish or pull that wrote GitHub (or the live text) and crashed before recording
 * the base: the texts agree, so nothing is diverged and a plain retry must be allowed to heal the
 * bookkeeping instead of being refused. `localChanged` / `remoteChanged` and `lines` are then
 * computed against the remote text as the effective base — i.e. all false / `0/0`, the same answer a
 * fully in-sync document gives — rather than against the stale stored base, so `in-sync` always
 * means "no changes on either side" to the UI and the MCP tools.
 */
function classify(base: string | null, local: string, remote: RemoteFile): Omit<SyncStatus, "remote"> {
  const remoteText = remote.content ?? "";
  // Only a file that exists counts: a missing file with an empty local text is the plain in-sync row.
  const baseText = remote.content !== null && local === remoteText ? remoteText : (base ?? "");
  const localChanged = local !== baseText;
  // A file that does not exist yet (fresh link, nothing published) is not "changed".
  const remoteChanged = remote.content !== null && remoteText !== baseText;
  const status: SyncState = localChanged && remoteChanged ? "diverged" : localChanged ? "local-ahead" : remoteChanged ? "remote-ahead" : "in-sync";
  return {
    status,
    localChanged,
    remoteChanged,
    lines: { local: localChanged ? changedLines(baseText, local) : 0, remote: remoteChanged ? changedLines(baseText, remoteText) : 0 },
  };
}

function toStatus(base: string | null, local: string, remote: RemoteFile): SyncStatus {
  return { ...classify(base, local, remote), remote: { sha: remote.revision, revision: remote.revision, url: remote.url, updatedAt: remote.updatedAt } };
}

/**
 * Where the document stands against its GitHub file: in-sync, local-ahead, remote-ahead or diverged.
 * The merge base (`publishedContent`) is read here, not carried on `doc`: access checks leave it out.
 * A remote Markdoc cannot read (over the 2 MB bound) is a `413`, never an empty "remote-ahead".
 */
export async function syncStatus(doc: LinkedDocument, user: SessionUser, options: { fresh?: boolean; content?: boolean } = {}): Promise<SyncStatus> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const [remote, live, base] = await Promise.all([readRemote(doc, user, options.fresh), readLiveText(doc.id), getPublishedContent(doc.id)]);
  if (remote.unreadable) throw unreadableRemote(remote);
  const status = toStatus(base, live.clean, remote);
  return options.content ? { ...status, remoteContent: remote.content ?? "" } : status;
}

export interface MergeOutcome {
  text: string;
  conflicts: number;
}

/** Line-based three-way merge; conflicts are written as `<<<<<<< local` / `=======` / `>>>>>>> github` blocks. */
export function mergeTexts(base: string, local: string, remote: string): MergeOutcome {
  const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), { excludeFalseConflicts: true });
  const out: string[] = [];
  let conflicts = 0;
  for (const region of regions) {
    if ("ok" in region && region.ok) {
      out.push(...region.ok);
      continue;
    }
    const c = region.conflict;
    if (!c) continue;
    conflicts++;
    out.push("<<<<<<< local", ...c.a, "=======", ...c.b, ">>>>>>> github");
  }
  return { text: out.join("\n"), conflicts };
}

function syncConflict(message: string, details: Record<string, unknown>): HttpError {
  return new HttpError(409, message, details);
}

export interface PublishOptions {
  message?: string;
  /** Overwrite the GitHub file even when it changed since the last sync. */
  force?: boolean;
}

export interface SavedGistPublish {
  content: string;
  baseline: string | null;
  accountLogin: string;
  isPublic: boolean;
  signal?: AbortSignal;
  /** Last check of the durable opt-in, after all remote reads and immediately before a send. */
  beforeSend: () => Promise<void>;
  /** Commit bookkeeping only while the original document/destination generation still matches. */
  recordPublished: (patch: Partial<Pick<Document, "publishedContent" | "publishedAt" | "githubSha">>) => Promise<void>;
  /** Serialize the final grant check and request initiation with settings changes. */
  dispatch: <T>(send: () => Promise<T>) => Promise<T>;
}

export function savedCleanText(doc: Pick<Document, "ystate" | "content" | "title">): string {
  const snapshot = new Y.Doc();
  try {
    hydrateDoc(snapshot, doc.ystate ?? null, doc.content, doc.title);
    return cleanTextOf(snapshot);
  } finally {
    snapshot.destroy();
  }
}

async function assertManualGistSaved(doc: LinkedDocument, content: string) {
  if (doc.storage !== "gist") return;
  const db = await getDb();
  const [current] = await db.select({ job: schema.gistAutoUpdates, doc: schema.documents }).from(schema.gistAutoUpdates)
    .innerJoin(schema.documents, eq(schema.gistAutoUpdates.documentId, schema.documents.id))
    .where(eq(schema.gistAutoUpdates.documentId, doc.id));
  if (current?.job.enabled && savedCleanText(current.doc) !== content) {
    throw new HttpError(409, "Wait for Markdoc to finish saving before manually updating an auto-updating gist, or turn auto-update off.");
  }
}

async function assertGistLinkCurrent(doc: LinkedDocument) {
  if (doc.storage !== "gist") return;
  const db = await getDb();
  const [current] = await db.select({
    storage: schema.documents.storage, gistId: schema.documents.gistId, gistFile: schema.documents.gistFile, deletedAt: schema.documents.deletedAt,
  }).from(schema.documents).where(eq(schema.documents.id, doc.id));
  if (!current || current.deletedAt || current.storage !== "gist" || current.gistId !== doc.gistId || current.gistFile !== doc.gistFile) {
    throw new HttpError(409, "The gist connection changed. Reopen publishing controls before trying again.");
  }
}

/** Commit the document's current clean text to its linked gist or repository file. */
export async function publishDocument(doc: LinkedDocument, user: SessionUser, messageOrOptions?: string | PublishOptions): Promise<PublishResult> {
  const run = async (signal?: AbortSignal) => {
    await assertGistLinkCurrent(doc);
    return publishWithinLock(doc, user, messageOrOptions, undefined, signal);
  };
  if (doc.storage !== "gist" || !doc.gistId || !doc.gistFile) return run();
  const lock = await withGistPublicationLock(doc.gistId, doc.gistFile, run);
  if (!lock.acquired) throw new HttpError(409, "A gist update is already in progress. Try again after it finishes.");
  return lock.value;
}

/** The queue holds the same destination lock as manual publishing and supplies a persisted snapshot. */
export function publishSavedGist(doc: LinkedDocument, user: SessionUser, saved: SavedGistPublish): Promise<PublishResult> {
  return publishWithinLock(doc, user, undefined, saved);
}

async function publishWithinLock(doc: LinkedDocument, user: SessionUser, messageOrOptions?: string | PublishOptions, saved?: SavedGistPublish, coordinationSignal?: AbortSignal): Promise<PublishResult> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const options: PublishOptions = typeof messageOrOptions === "string" ? { message: messageOrOptions } : (messageOrOptions ?? {});
  const message = options.message;
  const token = await publishingTokenFor(user);
  const signal = saved ? AbortSignal.any([AbortSignal.timeout(15_000), ...(saved.signal ? [saved.signal] : [])]) : coordinationSignal;
  signal?.throwIfAborted();
  const octokit = githubClient(token, signal);
  const [content, base] = saved ? [saved.content, saved.baseline] as const : await Promise.all([
    readLiveText(doc.id).then((live) => live.clean), getPublishedContent(doc.id),
  ]);
  if (!saved) await assertManualGistSaved(doc, content);
  const remote = saved ? await fetchRemote(doc, user, octokit) : await readRemote(doc, user, true);
  signal?.throwIfAborted();
  if (saved) {
    if (!remote.gist || remote.gist.id !== doc.gistId || remote.gist.filename !== doc.gistFile || remote.content === null) {
      throw new HttpError(409, "The linked gist file is missing, replaced, or unavailable. Review the connection.", { status: "conflict" });
    }
    const login = await currentGitHubLogin(octokit);
    signal?.throwIfAborted();
    if (login.toLowerCase() !== saved.accountLogin.toLowerCase() || remote.gist.owner?.toLowerCase() !== login.toLowerCase()) {
      throw new HttpError(403, "GitHub authorization changed. Reconnect the account that owns the gist.");
    }
    if (remote.gist.truncated || !remote.gist.contentKnown || !remote.gist.visibilityKnown || remote.revision === null || remote.unreadable || base === null || remote.content !== gistContent(base) ||
        (doc.githubSha !== null && remote.revision !== doc.githubSha) || remote.gist.isPublic !== saved.isPublic) {
      throw new HttpError(409, "The gist changed outside Markdoc or its baseline cannot be verified. Review it with Sync before retrying.", { status: "conflict" });
    }
    if (await publishingTokenFor(user) !== token) throw new HttpError(403, "GitHub authorization changed before sending. Reconnect and retry.");
    await saved.beforeSend();
    if (gistContent(content) === remote.content) {
      if (doc.githubSha !== remote.revision) await saved.recordPublished({ githubSha: remote.revision });
      return { url: githubUrlFor(doc), commitSha: null, publishedAt: (doc.publishedAt ?? new Date()).toISOString(), skipped: true, status: "in-sync" };
    }
  }
  if (remote.unreadable) {
    // No remote text to compare with: overwriting an unreadable file is an explicit choice.
    if (!options.force) throw unreadableRemote(remote);
  } else if (!saved) {
    const status = toStatus(base, content, remote);
    if (!options.force && (status.status === "remote-ahead" || status.status === "diverged")) {
      throw syncConflict("The file changed on GitHub since it was last synced. Pull or merge first, or force-publish to overwrite.", {
        status: status.status,
        remote: status.remote,
        localChanged: status.localChanged,
        remoteChanged: status.remoteChanged,
        lines: status.lines,
      });
    }
    if (status.status === "in-sync" && remote.content === content) {
      // Nothing to commit. The base may still be behind — a publish (or pull) that wrote GitHub and then
      // crashed before recording it — so a plain retry repairs it here; a failure of this write is a
      // 500 the next retry heals the same way.
      const heal: Partial<Document> = {};
      if (base !== content) {
        heal.publishedContent = content;
        heal.publishedAt = new Date();
      }
      if (doc.githubSha !== remote.revision) heal.githubSha = remote.revision;
      if (Object.keys(heal).length) await updateDocument(doc.id, heal);
      return { url: githubUrlFor(doc), commitSha: null, publishedAt: (heal.publishedAt ?? doc.publishedAt ?? new Date()).toISOString(), skipped: true, status: "in-sync" };
    }
  }

  let url: string | null = null;
  let commitSha: string | null = null;
  let githubSha: string | null = doc.githubSha;
  if (doc.storage === "gist") {
    const gistId = doc.gistId;
    const filename = doc.gistFile;
    if (!gistId || !filename) throw new HttpError(400, "Gist link is incomplete.");
    const send = () => {
      signal?.throwIfAborted();
      return updateGist(octokit, gistId, filename, content, message);
    };
    const result = saved ? await saved.dispatch(send) : await send();
    signal?.throwIfAborted();
    url = result.htmlUrl;
    githubSha = result.revision;
  } else {
    if (!doc.repoOwner || !doc.repoName || !doc.repoPath) throw new HttpError(400, "Repository link is incomplete.");
    const result = await commitRepoFile(octokit, {
      owner: doc.repoOwner,
      repo: doc.repoName,
      path: doc.repoPath,
      branch: doc.repoBranch ?? "main",
      content,
      message: message?.trim() || `Update ${doc.repoPath} via Markdoc`,
      // Force-publish writes over whatever is there now; a normal publish still guards with the base sha.
      sha: options.force ? remote.revision : doc.githubSha,
    });
    url = result.htmlUrl;
    commitSha = result.commitSha;
    githubSha = result.sha;
  }
  const publishedAt = new Date();
  // GitHub has the text from here on: the cache says so even if the base write below fails, so a
  // status read in the next 30 s sees in-sync (texts agree) rather than a stale local-ahead.
  if (!saved) rememberRemote(doc.id, { content, revision: githubSha, url: url ?? remote.url, updatedAt: publishedAt.toISOString() });
  // The base record is the state the sync promise is about: it stays fatal. Should it fail, the plain
  // retry above finds local == remote and heals it.
  if (saved) {
    await saved.recordPublished({ publishedContent: content, publishedAt, githubSha });
    signal?.throwIfAborted();
    rememberRemote(doc.id, { content, revision: githubSha, url: url ?? remote.url, updatedAt: publishedAt.toISOString() });
  } else {
    await updateDocument(doc.id, { publishedContent: content, publishedAt, githubSha });
  }
  // The version row is bookkeeping: its failure never fails a publish whose commit and base already stand.
  const { tail, answer } = warnTail("publish");
  await tail("version-not-saved", async () => {
    try {
      return await addVersion({
        documentId: doc.id,
        content,
        kind: "publish",
        createdBy: user.id,
        createdByName: actorName(user),
        title: options.force ? "Force-published" : message?.trim() || (doc.storage === "gist" ? "Published to gist" : `Committed to ${doc.repoBranch ?? "main"}`),
        commitSha,
      });
    } catch (error) {
      // Database errors can embed content parameters; automatic work must not log them.
      if (saved) throw new Error("Automatic gist version history could not be recorded");
      throw error;
    }
  });
  return answer({ url, commitSha, publishedAt: publishedAt.toISOString(), status: "in-sync" });
}

export interface PullOptions {
  /** Replace the local text even when it has unpublished edits. */
  force?: boolean;
  /** When both sides changed, three-way merge instead of refusing. */
  merge?: boolean;
}

export interface PullResult {
  changed: boolean;
  url: string | null;
  status: SyncState;
  /** Set when the pull merged GitHub's edits into local ones. */
  merged?: boolean;
  /** Post-write bookkeeping that failed (the text and the base stand); omitted when nothing did. */
  warnings?: WarningCode[];
}

/**
 * Bring GitHub's copy into the live document. Refuses (409) when local edits would be lost unless
 * `force`; with `merge` a diverged document is three-way merged, and conflicts come back as a 409
 * with the marked text so the UI can hand them to the user.
 *
 * Order of writes: live text (broadcast to every editor) → version row (non-fatal, `warnings`) →
 * base record (fatal). A crash before the base record leaves local == remote, which `classify`
 * reads as in-sync, so the plain retry lands in the first branch and records the base.
 */
export async function pullDocument(doc: LinkedDocument, user: SessionUser, options: PullOptions = {}): Promise<PullResult> {
  const run = async () => {
    await assertGistLinkCurrent(doc);
    return pullWithinLock(doc, user, options);
  };
  if (doc.storage !== "gist" || !doc.gistId || !doc.gistFile) return run();
  const lock = await withGistPublicationLock(doc.gistId, doc.gistFile, run);
  if (!lock.acquired) throw new HttpError(409, "A gist update is already in progress. Try syncing after it finishes.");
  return lock.value;
}

async function pullWithinLock(doc: LinkedDocument, user: SessionUser, options: PullOptions): Promise<PullResult> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const remote = await readRemote(doc, user, true);
  // Nothing readable to pull — with or without `force` the live text stays as it is.
  if (remote.unreadable) throw unreadableRemote(remote);
  const [live, base] = await Promise.all([readLiveText(doc.id), getPublishedContent(doc.id)]);
  const status = toStatus(base, live.clean, remote);
  const remoteText = remote.content ?? "";
  const url = remote.url ?? githubUrlFor(doc);
  const recordBase = () => updateDocument(doc.id, { publishedContent: remoteText, publishedAt: new Date(), githubSha: remote.revision });
  const { tail, answer } = warnTail("pull");
  const saveVersion = (content: string, title: string) =>
    tail("version-not-saved", () => addVersion({ documentId: doc.id, content, kind: "import", createdBy: user.id, createdByName: actorName(user), title }));

  if (status.status === "in-sync") {
    // Also the heal for a stale base whose texts already agree (see classify).
    await recordBase();
    return { changed: false, url, status: "in-sync" };
  }

  if (status.status === "diverged" && options.merge && !options.force) {
    const merged = mergeTexts(base ?? "", live.clean, remoteText);
    if (merged.conflicts > 0) {
      throw syncConflict(`Merge has ${merged.conflicts} conflict${merged.conflicts === 1 ? "" : "s"}.`, {
        status: "conflict",
        merged: merged.text,
        conflicts: merged.conflicts,
        remoteContent: remoteText,
        remote: status.remote,
        lines: status.lines,
      });
    }
    await replaceLiveText(doc.id, contextFor(user, doc.id), merged.text);
    await saveVersion(merged.text, "Merged from GitHub");
    await recordBase();
    return answer({ changed: true, url, status: "local-ahead", merged: true });
  }

  if ((status.status === "local-ahead" || status.status === "diverged") && !options.force) {
    throw syncConflict(
      status.status === "local-ahead"
        ? "This document has unpublished changes; pulling would discard them. Publish first, or force-pull to replace them."
        : "Both this document and the GitHub file changed. Merge, or force-pull to take GitHub's copy.",
      { status: status.status, remoteContent: remoteText, remote: status.remote, localChanged: status.localChanged, remoteChanged: status.remoteChanged, lines: status.lines },
    );
  }

  // remote-ahead, or forced over local edits.
  const changed = live.text !== remoteText;
  if (changed) {
    await replaceLiveText(doc.id, contextFor(user, doc.id), remoteText);
    await saveVersion(remoteText, options.force && status.localChanged ? "Force-pulled from GitHub" : "Pulled from GitHub");
  }
  await recordBase();
  return answer({ changed, url, status: "in-sync" });
}

export interface LinkGistInput {
  storage: "gist";
  gistId?: string;
  filename?: string;
  isPublic?: boolean;
  description?: string;
}

export interface LinkRepoInput {
  storage: "repo";
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export type LinkInput = LinkGistInput | LinkRepoInput | { storage: "local" };

/** `null` for a file that is not there (or unreadable for any reason but its size); an oversized file is a `413` the caller must see. */
const missingUnlessTooLarge = (err: unknown) => {
  if (err instanceof GitHubFileTooLargeError) throw err;
  return null;
};

/** The linked row, plus `warnings` when the version row of a new gist could not be written. */
export type LinkResult = Document & { warnings?: WarningCode[] };

/** Link a document to a gist (existing or new) or a repository file, then publish. */
export async function linkDocument(doc: LinkedDocument, user: SessionUser, input: LinkInput): Promise<LinkResult> {
  const run = async () => {
    await assertGistLinkCurrent(doc);
    return linkWithinLock(doc, user, input);
  };
  if (doc.storage !== "gist" || !doc.gistId || !doc.gistFile) return run();
  const lock = await withGistPublicationLock(doc.gistId, doc.gistFile, run);
  if (!lock.acquired) throw new HttpError(409, "A gist update is in progress. Turn off auto-update, then retry disconnecting or changing the connection after it finishes.");
  return lock.value;
}

async function linkWithinLock(doc: LinkedDocument, user: SessionUser, input: LinkInput): Promise<LinkResult> {
  const db = await getDb();
  await db.update(schema.gistAutoUpdates).set({ enabled: false, status: "off", message: null }).where(eq(schema.gistAutoUpdates.documentId, doc.id));
  if (input.storage === "local") {
    return (await updateDocument(doc.id, {
      storage: "local",
      gistId: null,
      gistFile: null,
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubSha: null,
      publishedContent: null,
      publishedAt: null,
    }))!;
  }
  const octokit = await octokitFor(user);
  const live = await readLiveText(doc.id);
  if (input.storage === "gist") {
    const filename = (input.filename?.trim() || `${slugFile(doc.title)}.md`).replace(/[\\/]/g, "-");
    if (input.gistId) {
      const file = await readGistFile(octokit, input.gistId, input.filename).catch(missingUnlessTooLarge);
      return (await updateDocument(doc.id, {
        storage: "gist",
        gistId: input.gistId,
        gistFile: file?.filename ?? filename,
        repoOwner: null,
        repoName: null,
        repoBranch: null,
        repoPath: null,
        githubSha: null,
        publishedContent: file?.content ?? null,
        publishedAt: file ? new Date() : null,
      }))!;
    }
    const created = await createGist(octokit, {
      filename,
      content: live.clean,
      description: input.description ?? doc.title,
      isPublic: !!input.isPublic,
    }).catch((error: unknown) => {
      throw managedAccountGistRefusal(user, error) ?? error;
    });
    // The gist exists now: write the link first so it is durable (a failure here is a 500 with the
    // document still local and the gist orphaned — nothing more can be done without a transaction
    // spanning GitHub). The version row is bookkeeping and must not undo that.
    const linked = (await updateDocument(doc.id, {
      storage: "gist",
      gistId: created.gistId,
      gistFile: created.filename,
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubSha: null,
      publishedContent: live.clean,
      publishedAt: new Date(),
    }))!;
    const { tail, answer } = warnTail("link");
    await tail("version-not-saved", () =>
      addVersion({ documentId: doc.id, content: live.clean, kind: "publish", createdBy: user.id, createdByName: actorName(user), title: "Published to new gist" }),
    );
    return answer(linked);
  }
  const path = input.path.replace(/^\/+/, "");
  if (!path) throw new HttpError(400, "A file path is required");
  const existing = await readRepoFile(octokit, input.owner, input.repo, path, input.branch).catch(missingUnlessTooLarge);
  return (await updateDocument(doc.id, {
    storage: "repo",
    repoOwner: input.owner,
    repoName: input.repo,
    repoBranch: input.branch,
    repoPath: path,
    gistId: null,
    gistFile: null,
    githubSha: existing?.sha ?? null,
    publishedContent: existing?.content ?? null,
    publishedAt: existing ? new Date() : null,
  }))!;
}

function slugFile(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}
