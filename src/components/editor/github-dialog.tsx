"use client";
import { Dialog, DialogContent, Spinner } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { Check, ExternalLink, FileText, GitBranch, Loader2, Lock, Search, Unlink } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { api, ApiError } from "@/lib/api";

import { cn, relativeTime } from "@/lib/utils";

type Tab = "gist" | "repo";

/** Shown wherever a GitHub entry point is disabled because the server has no GitHub OAuth app (#162). */
export const GITHUB_NOT_CONFIGURED = "GitHub storage is not set up on this server.";

/**
 * Empty state of the GitHub picker for an account without a GitHub token (#162): the action the
 * sentence names, or why there is none. `redirectTo` defaults to the page the user is on.
 */
export function GitHubSignInPrompt({ githubConfigured, redirectTo }: { githubConfigured: boolean; redirectTo?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-2 p-6 text-center text-sm text-ink-3" data-testid="github-signin-prompt">
      <GitHubIcon className="text-ink-4" size={24} />
      {githubConfigured ? (
        <>
          <p>
            Gists and repositories need a GitHub account. You are signed in without one — sign in with GitHub to use them as storage.
          </p>
          <button
            type="button"
            className="btn btn-primary gap-2"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signIn("github", { redirectTo: redirectTo ?? window.location.href }).catch(() => setBusy(false));
            }}
            data-testid="github-signin"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <GitHubIcon size={16} />} Sign in with GitHub
          </button>
        </>
      ) : (
        <p data-testid="github-not-configured">
          {GITHUB_NOT_CONFIGURED} Gists and repositories become available once the administrator sets <code className="font-mono text-xs">AUTH_GITHUB_ID</code> and{" "}
          <code className="font-mono text-xs">AUTH_GITHUB_SECRET</code>.
        </p>
      )}
    </div>
  );
}

interface GistItem {
  id: string;
  description: string | null;
  public: boolean;
  updatedAt: string;
  htmlUrl: string;
  files: { filename: string; language: string | null; size: number }[];
}
interface RepoItem {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
  description: string | null;
}

/** Connect a document to a gist or repository file, or pick a file to import. */
export function GitHubPicker({
  mode,
  doc,
  onLinked,
  onImported,
  githubAvailable,
  githubConfigured,
}: {
  mode: "link" | "import";
  doc?: DocumentDto;
  onLinked?: (doc: DocumentDto) => void;
  onImported?: (docId: string) => void;
  /** The signed-in account has a GitHub token. */
  githubAvailable: boolean;
  /** The server has a GitHub OAuth app, so "Sign in with GitHub" can work. */
  githubConfigured: boolean;
}) {
  const [tab, setTab] = useState<Tab>("gist");
  const [gists, setGists] = useState<GistItem[] | null>(null);
  const [repos, setRepos] = useState<RepoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  // gist state
  const [newGist, setNewGist] = useState(mode === "link");
  const [gistName, setGistName] = useState(`${(doc?.title ?? "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"}.md`);
  const [gistPublic, setGistPublic] = useState(false);
  // repo state
  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("");
  const [files, setFiles] = useState<{ path: string }[] | null>(null);
  const [path, setPath] = useState("");

  useEffect(() => {
    if (!githubAvailable) return;
    setError(null);
    if (tab === "gist" && gists === null) {
      api.github
        .gists()
        .then((r) => setGists(r.gists))
        .catch((e: ApiError) => setError(e.message));
    }
    if (tab === "repo" && repos === null) {
      api.github
        .repos()
        .then((r) => setRepos(r.repos))
        .catch((e: ApiError) => setError(e.message));
    }
  }, [tab, gists, repos, githubAvailable]);

  useEffect(() => {
    if (!repo) return;
    setBranches(null);
    setFiles(null);
    setBranch(repo.defaultBranch);
    api.github
      .branches(repo.owner, repo.name)
      .then((r) => setBranches(r.branches))
      .catch((e: ApiError) => setError(e.message));
  }, [repo]);

  useEffect(() => {
    if (!repo || !branch) return;
    setFiles(null);
    api.github
      .files(repo.owner, repo.name, branch)
      .then((r) => setFiles(r.files))
      .catch((e: ApiError) => setError(e.message));
  }, [repo, branch]);

  const filteredGists = useMemo(() => {
    const q = filter.toLowerCase();
    return (gists ?? []).filter((g) => !q || (g.description ?? "").toLowerCase().includes(q) || g.files.some((f) => f.filename.toLowerCase().includes(q)));
  }, [gists, filter]);
  const filteredRepos = useMemo(() => {
    const q = filter.toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repos, filter]);
  const filteredFiles = useMemo(() => {
    const q = filter.toLowerCase();
    return (files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
  }, [files, filter]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const linkGist = (gistId?: string, filename?: string) =>
    run(async () => {
      if (mode === "import") {
        const res = await api.import({ source: "gist", gistId, filename });
        onImported?.(res.document.id);
        return;
      }
      const res = await api.documents.link(doc!.id, { storage: "gist", gistId, filename: filename ?? gistName, isPublic: gistPublic, description: doc!.title });
      onLinked?.(res.document);
    });

  const linkRepo = (filePath: string) =>
    run(async () => {
      if (!repo) return;
      if (mode === "import") {
        const res = await api.import({ source: "repo", owner: repo.owner, repo: repo.name, branch, path: filePath });
        onImported?.(res.document.id);
        return;
      }
      const res = await api.documents.link(doc!.id, { storage: "repo", owner: repo.owner, repo: repo.name, branch, path: filePath });
      onLinked?.(res.document);
    });

  if (!githubAvailable) {
    return <GitHubSignInPrompt githubConfigured={githubConfigured} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="github-picker">
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg border border-line p-0.5">
          {(["gist", "repo"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium", tab === t ? "bg-inverse text-white" : "text-ink-2 hover:bg-surface-3")}
              onClick={() => {
                setTab(t);
                setFilter("");
              }}
              data-testid={`picker-tab-${t}`}
            >
              {t === "gist" ? "Gist" : "Repository"}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
          <input className="input pl-9" placeholder={tab === "gist" ? "Filter gists" : repo ? "Filter files" : "Filter repositories"} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{error}</div>}

      {tab === "gist" && (
        <div className="flex flex-col gap-3">
          {mode === "link" && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input type="radio" checked={newGist} onChange={() => setNewGist(true)} /> Create a new gist
              </label>
              {newGist && (
                <div className="mt-3 flex items-center gap-2 pl-6">
                  <input className="input flex-1" value={gistName} onChange={(e) => setGistName(e.target.value)} placeholder="filename.md" data-testid="gist-filename" />
                  <label className="flex items-center gap-1.5 text-sm text-ink-2">
                    <input type="checkbox" checked={gistPublic} onChange={(e) => setGistPublic(e.target.checked)} /> Public
                  </label>
                  <button type="button" className="btn btn-primary" disabled={busy || !gistName.trim()} onClick={() => void linkGist()} data-testid="gist-create">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : "Create & publish"}
                  </button>
                </div>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm font-medium text-ink">
                <input type="radio" checked={!newGist} onChange={() => setNewGist(false)} /> Use an existing gist
              </label>
            </div>
          )}
          {(mode === "import" || !newGist) && (
            <div className="scrollbar-thin max-h-72 overflow-y-auto rounded-xl border border-line">
              {gists === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : filteredGists.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown gists found.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {filteredGists.map((g) =>
                    g.files
                      .filter((f) => /\.(md|markdown|mdx)$/i.test(f.filename) || f.language === "Markdown")
                      .map((f) => (
                        <li key={g.id + f.filename}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void linkGist(g.id, f.filename)}
                            data-testid="gist-item"
                          >
                            <FileText size={16} className="shrink-0 text-ink-4" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-ink">{f.filename}</div>
                              <div className="truncate text-xs text-ink-3">{g.description || g.id}</div>
                            </div>
                            <span className="flex items-center gap-2 text-xs text-ink-4">
                              {!g.public && <Lock size={12} />}
                              {relativeTime(g.updatedAt)}
                            </span>
                          </button>
                        </li>
                      )),
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "repo" && (
        <div className="flex flex-col gap-3">
          {!repo ? (
            <div className="scrollbar-thin max-h-80 overflow-y-auto rounded-xl border border-line">
              {repos === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {filteredRepos.map((r) => (
                    <li key={r.fullName}>
                      <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2" onClick={() => setRepo(r)} data-testid="repo-item">
                        <GitHubIcon size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{r.fullName}</div>
                          {r.description && <div className="truncate text-xs text-ink-3">{r.description}</div>}
                        </div>
                        <span className="flex items-center gap-2 text-xs text-ink-4">
                          {r.private && <Lock size={12} />}
                          {r.pushedAt && relativeTime(r.pushedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRepo(null)}>
                  ← Repositories
                </button>
                <span className="font-medium text-ink">{repo.fullName}</span>
                <span className="ml-auto inline-flex items-center gap-1.5 text-ink-3">
                  <GitBranch size={14} />
                  {branches ? (
                    <select className="select h-8 text-xs" value={branch} onChange={(e) => setBranch(e.target.value)} data-testid="branch-select">
                      {branches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Spinner />
                  )}
                </span>
              </div>
              {mode === "link" && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (path.trim()) void linkRepo(path.trim());
                  }}
                >
                  <input className="input flex-1 font-mono text-[13px]" placeholder="docs/new-file.md (new or existing path)" value={path} onChange={(e) => setPath(e.target.value)} data-testid="repo-path" />
                  <button type="submit" className="btn btn-primary" disabled={busy || !path.trim()} data-testid="repo-link">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : "Connect"}
                  </button>
                </form>
              )}
              <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-xl border border-line">
                {files === null ? (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                ) : filteredFiles.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown files on this branch.</div>
                ) : (
                  <ul className="divide-y divide-line">
                    {filteredFiles.map((f) => (
                      <li key={f.path}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => (mode === "link" ? setPath(f.path) : void linkRepo(f.path))}
                          data-testid="repo-file"
                        >
                          <FileText size={15} className="shrink-0 text-ink-4" />
                          <span className="truncate font-mono text-[13px] text-ink-2">{f.path}</span>
                          {mode === "import" && <span className="ml-auto text-xs text-accent">Open</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const GitHubDialog = memo(function GitHubDialog({
  open,
  onOpenChange,
  doc,
  onDocChange,
  githubAvailable,
  githubConfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onDocChange: (doc: DocumentDto) => void;
  githubAvailable: boolean;
  githubConfigured: boolean;
}) {
  const [unlinking, setUnlinking] = useState(false);
  const linked = doc.storage !== "local";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={linked ? "GitHub connection" : "Connect to GitHub"}
        description={linked ? "This document publishes to the location below." : "Store this document in a gist or a repository file. Publishing commits the current text."}
        wide
      >
        {linked && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
            <GitHubIcon size={18} className="text-ink-2" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="truncate font-medium text-ink">
                {doc.storage === "gist" ? `Gist · ${doc.gistFile}` : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch} · ${doc.repoPath}`}
              </div>
              <div className="text-xs text-ink-3">
                {doc.publishedAt ? `Last published ${relativeTime(doc.publishedAt)}` : "Not published yet"}
                {doc.hasUnpublishedChanges && " · unpublished changes"}
              </div>
            </div>
            {doc.githubUrl && (
              <a className="btn btn-sm btn-outline gap-1.5" href={doc.githubUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} /> Open
              </a>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost gap-1.5 text-ink-3"
              disabled={unlinking}
              onClick={async () => {
                setUnlinking(true);
                try {
                  const res = await api.documents.link(doc.id, { storage: "local" });
                  onDocChange(res.document);
                } finally {
                  setUnlinking(false);
                }
              }}
            >
              <Unlink size={14} /> Disconnect
            </button>
          </div>
        )}
        <GitHubPicker
          mode="link"
          doc={doc}
          githubAvailable={githubAvailable}
          githubConfigured={githubConfigured}
          onLinked={(d) => {
            onDocChange(d);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
});

export const CommitDialog = memo(function CommitDialog({
  open,
  onOpenChange,
  doc,
  onCommit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onCommit: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (open) {
      setMessage(`Update ${doc.repoPath ?? doc.gistFile ?? "document"}`);
      setDone(false);
      setError(null);
    }
  }, [open, doc.repoPath, doc.gistFile]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={doc.storage === "gist" ? "Update gist" : "Commit to GitHub"} description={doc.storage === "gist" ? "Publishes the current text to the gist." : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await onCommit(message.trim());
              setDone(true);
              setTimeout(() => onOpenChange(false), 900);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Publish failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="text-sm font-medium text-ink-2">{doc.storage === "gist" ? "Description" : "Commit message"}</label>
          <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} autoFocus data-testid="commit-message" />
          <p className="text-xs text-ink-3">Pending suggestions are not included until they are accepted.</p>
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary gap-2" disabled={busy || done} data-testid="commit-submit">
              {done ? <Check size={16} /> : busy ? <Loader2 size={16} className="animate-spin" /> : null}
              {done ? "Published" : doc.storage === "gist" ? "Update gist" : "Commit"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});


