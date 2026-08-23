import { getGitHubToken, updateDocument, addVersion, type SessionUser } from "@/server/documents";
import type { Document } from "@/server/db/schema";
import { HttpError, actorName } from "@/server/http";
import {
  githubClient,
  updateGist,
  createGist,
  commitRepoFile,
  readGistFile,
  readRepoFile,
  isGitHubMock,
} from "@/server/github";
import { readLiveText, replaceLiveText } from "@/server/livedoc";
import type { CollabContext } from "@/server/collab/hocuspocus";
import { diff3Merge, diffIndices } from "node-diff3";

export interface PublishResult {
  url: string | null;
  commitSha: string | null;
  publishedAt: string;
  skipped?: boolean;
  status: SyncState;
}

export function githubUrlFor(doc: Document): string | null {
  if (doc.storage === "gist" && doc.gistId) return `https://gist.github.com/${doc.gistId}`;
  if (doc.storage === "repo" && doc.repoOwner && doc.repoName && doc.repoPath) {
    return `https://github.com/${doc.repoOwner}/${doc.repoName}/blob/${doc.repoBranch ?? "main"}/${doc.repoPath}`;
  }
  return null;
}

async function octokitFor(user: SessionUser) {
  if (isGitHubMock()) return githubClient("mock");
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "Your account has no GitHub token. Sign in with GitHub to use gists and repositories.");
  return githubClient(token);
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

async function fetchRemote(doc: Document, user: SessionUser): Promise<RemoteFile> {
  const octokit = await octokitFor(user);
  try {
    if (doc.storage === "gist") {
      if (!doc.gistId) throw new HttpError(400, "Gist link is incomplete.");
      const file = await readGistFile(octokit, doc.gistId, doc.gistFile ?? undefined);
      return { content: file.content, revision: file.revision, url: file.htmlUrl, updatedAt: file.updatedAt };
    }
    if (!doc.repoOwner || !doc.repoName || !doc.repoPath) throw new HttpError(400, "Repository link is incomplete.");
    const file = await readRepoFile(octokit, doc.repoOwner, doc.repoName, doc.repoPath, doc.repoBranch ?? "main");
    return { content: file.content, revision: file.sha, url: file.htmlUrl, updatedAt: file.updatedAt ?? null };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { content: null, revision: null, url: githubUrlFor(doc), updatedAt: null };
    throw err;
  }
}

/** Read the linked file, reusing a read made in the last 30 s unless `fresh`. */
async function readRemote(doc: Document, user: SessionUser, fresh = false): Promise<RemoteFile> {
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

function classify(base: string | null, local: string, remote: RemoteFile): Omit<SyncStatus, "remote"> {
  const baseText = base ?? "";
  const remoteText = remote.content ?? "";
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

/** Where the document stands against its GitHub file: in-sync, local-ahead, remote-ahead or diverged. */
export async function syncStatus(doc: Document, user: SessionUser, options: { fresh?: boolean; content?: boolean } = {}): Promise<SyncStatus> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const [remote, live] = await Promise.all([readRemote(doc, user, options.fresh), readLiveText(doc.id)]);
  const status = toStatus(doc.publishedContent, live.clean, remote);
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

/** Commit the document's current clean text to its linked gist or repository file. */
export async function publishDocument(doc: Document, user: SessionUser, messageOrOptions?: string | PublishOptions): Promise<PublishResult> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const options: PublishOptions = typeof messageOrOptions === "string" ? { message: messageOrOptions } : (messageOrOptions ?? {});
  const message = options.message;
  const octokit = await octokitFor(user);
  const live = await readLiveText(doc.id);
  const content = live.clean;
  const remote = await readRemote(doc, user, true);
  const status = toStatus(doc.publishedContent, content, remote);
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
    if (doc.githubSha !== remote.revision) await updateDocument(doc.id, { githubSha: remote.revision });
    return { url: githubUrlFor(doc), commitSha: null, publishedAt: (doc.publishedAt ?? new Date()).toISOString(), skipped: true, status: "in-sync" };
  }

  let url: string | null = null;
  let commitSha: string | null = null;
  let githubSha: string | null = doc.githubSha;
  if (doc.storage === "gist") {
    if (!doc.gistId || !doc.gistFile) throw new HttpError(400, "Gist link is incomplete.");
    const result = await updateGist(octokit, doc.gistId, doc.gistFile, content, message);
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
  await updateDocument(doc.id, { publishedContent: content, publishedAt, githubSha });
  rememberRemote(doc.id, { content, revision: githubSha, url: url ?? remote.url, updatedAt: publishedAt.toISOString() });
  await addVersion({
    documentId: doc.id,
    content,
    kind: "publish",
    createdBy: user.id,
    createdByName: actorName(user),
    title: options.force ? "Force-published" : message?.trim() || (doc.storage === "gist" ? "Published to gist" : `Committed to ${doc.repoBranch ?? "main"}`),
    commitSha,
  });
  return { url, commitSha, publishedAt: publishedAt.toISOString(), status: "in-sync" };
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
}

/**
 * Bring GitHub's copy into the live document. Refuses (409) when local edits would be lost unless
 * `force`; with `merge` a diverged document is three-way merged, and conflicts come back as a 409
 * with the marked text so the UI can hand them to the user.
 */
export async function pullDocument(doc: Document, user: SessionUser, options: PullOptions = {}): Promise<PullResult> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const remote = await readRemote(doc, user, true);
  const live = await readLiveText(doc.id);
  const status = toStatus(doc.publishedContent, live.clean, remote);
  const remoteText = remote.content ?? "";
  const url = remote.url ?? githubUrlFor(doc);
  const recordBase = () => updateDocument(doc.id, { publishedContent: remoteText, publishedAt: new Date(), githubSha: remote.revision });

  if (status.status === "in-sync") {
    await recordBase();
    return { changed: false, url, status: "in-sync" };
  }

  if (status.status === "diverged" && options.merge && !options.force) {
    const merged = mergeTexts(doc.publishedContent ?? "", live.clean, remoteText);
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
    await addVersion({ documentId: doc.id, content: merged.text, kind: "import", createdBy: user.id, createdByName: actorName(user), title: "Merged from GitHub" });
    await recordBase();
    return { changed: true, url, status: "local-ahead", merged: true };
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
    await addVersion({
      documentId: doc.id,
      content: remoteText,
      kind: "import",
      createdBy: user.id,
      createdByName: actorName(user),
      title: options.force && status.localChanged ? "Force-pulled from GitHub" : "Pulled from GitHub",
    });
  }
  await recordBase();
  return { changed, url, status: "in-sync" };
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

/** Link a document to a gist (existing or new) or a repository file, then publish. */
export async function linkDocument(doc: Document, user: SessionUser, input: LinkInput): Promise<Document> {
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
      const file = await readGistFile(octokit, input.gistId, input.filename).catch(() => null);
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
    });
    await addVersion({ documentId: doc.id, content: live.clean, kind: "publish", createdBy: user.id, createdByName: actorName(user), title: "Published to new gist" });
    return (await updateDocument(doc.id, {
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
  }
  const path = input.path.replace(/^\/+/, "");
  if (!path) throw new HttpError(400, "A file path is required");
  const existing = await readRepoFile(octokit, input.owner, input.repo, path, input.branch).catch(() => null);
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


