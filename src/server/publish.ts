import { getGitHubToken, updateDocument, addVersion, type SessionUser } from "@/server/documents";
import type { Document } from "@/server/db/schema";
import { HttpError } from "@/server/http";
import {
  githubClient,
  updateGist,
  createGist,
  commitRepoFile,
  readGistFile,
  readRepoFile,
} from "@/server/github";
import { readLiveText, replaceLiveText } from "@/server/livedoc";
import type { CollabContext } from "@/server/collab/hocuspocus";

export interface PublishResult {
  url: string | null;
  commitSha: string | null;
  publishedAt: string;
  skipped?: boolean;
}

export function githubUrlFor(doc: Document): string | null {
  if (doc.storage === "gist" && doc.gistId) return `https://gist.github.com/${doc.gistId}`;
  if (doc.storage === "repo" && doc.repoOwner && doc.repoName && doc.repoPath) {
    return `https://github.com/${doc.repoOwner}/${doc.repoName}/blob/${doc.repoBranch ?? "main"}/${doc.repoPath}`;
  }
  return null;
}

async function octokitFor(user: SessionUser) {
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "Your account has no GitHub token. Sign in with GitHub to use gists and repositories.");
  return githubClient(token);
}

function contextFor(user: SessionUser, docId: string): CollabContext {
  return { userId: user.id, docId, role: "owner", name: user.name ?? user.login ?? "User", login: user.login, avatar: user.image ?? null };
}

/** Commit the document's current clean text to its linked gist or repository file. */
export async function publishDocument(doc: Document, user: SessionUser, message?: string): Promise<PublishResult> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const octokit = await octokitFor(user);
  const live = await readLiveText(doc.id);
  const content = live.clean;
  if (doc.publishedContent === content) {
    return { url: githubUrlFor(doc), commitSha: null, publishedAt: (doc.publishedAt ?? new Date()).toISOString(), skipped: true };
  }

  let url: string | null = null;
  let commitSha: string | null = null;
  let githubSha: string | null = doc.githubSha;
  if (doc.storage === "gist") {
    if (!doc.gistId || !doc.gistFile) throw new HttpError(400, "Gist link is incomplete.");
    const result = await updateGist(octokit, doc.gistId, doc.gistFile, content, message);
    url = result.htmlUrl;
  } else {
    if (!doc.repoOwner || !doc.repoName || !doc.repoPath) throw new HttpError(400, "Repository link is incomplete.");
    const result = await commitRepoFile(octokit, {
      owner: doc.repoOwner,
      repo: doc.repoName,
      path: doc.repoPath,
      branch: doc.repoBranch ?? "main",
      content,
      message: message?.trim() || `Update ${doc.repoPath} via Markdoc`,
      sha: doc.githubSha,
    });
    url = result.htmlUrl;
    commitSha = result.commitSha;
    githubSha = result.sha;
  }
  const publishedAt = new Date();
  await updateDocument(doc.id, { publishedContent: content, publishedAt, githubSha });
  await addVersion({
    documentId: doc.id,
    content,
    kind: "publish",
    createdBy: user.id,
    createdByName: user.name ?? user.login,
    title: message?.trim() || (doc.storage === "gist" ? "Published to gist" : `Committed to ${doc.repoBranch ?? "main"}`),
    commitSha,
  });
  return { url, commitSha, publishedAt: publishedAt.toISOString() };
}

/** Fetch the linked GitHub file and apply it to the live document. */
export async function pullDocument(doc: Document, user: SessionUser): Promise<{ changed: boolean; url: string | null }> {
  if (doc.storage === "local") throw new HttpError(400, "This document is not linked to GitHub yet.");
  const octokit = await octokitFor(user);
  let content: string;
  let githubSha: string | null = doc.githubSha;
  let url: string | null;
  if (doc.storage === "gist") {
    if (!doc.gistId) throw new HttpError(400, "Gist link is incomplete.");
    const file = await readGistFile(octokit, doc.gistId, doc.gistFile ?? undefined);
    content = file.content;
    url = file.htmlUrl;
  } else {
    if (!doc.repoOwner || !doc.repoName || !doc.repoPath) throw new HttpError(400, "Repository link is incomplete.");
    const file = await readRepoFile(octokit, doc.repoOwner, doc.repoName, doc.repoPath, doc.repoBranch ?? "main");
    content = file.content;
    githubSha = file.sha;
    url = file.htmlUrl;
  }
  const live = await readLiveText(doc.id);
  const changed = live.text !== content;
  if (changed) {
    await replaceLiveText(doc.id, contextFor(user, doc.id), content);
    await addVersion({
      documentId: doc.id,
      content,
      kind: "import",
      createdBy: user.id,
      createdByName: user.name ?? user.login,
      title: "Pulled from GitHub",
    });
  }
  await updateDocument(doc.id, { publishedContent: content, publishedAt: new Date(), githubSha });
  return { changed, url };
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
    await addVersion({ documentId: doc.id, content: live.clean, kind: "publish", createdBy: user.id, createdByName: user.name ?? user.login, title: "Published to new gist" });
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
