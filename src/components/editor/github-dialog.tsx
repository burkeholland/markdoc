"use client";
import { Dialog, DialogContent, Spinner } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { Check, ExternalLink, FileText, GitBranch, Loader2, Lock, Search, Unlink } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { api, apiErrorText } from "@/lib/api";

import { cn, relativeTime } from "@/lib/utils";
import { GITHUB_NOT_CONFIGURED } from "./labels";
import { GistAutoUpdateControl } from "./gist-auto-update";

type Tab = "gist" | "repo";

interface GitHubSignInOperation {
  readonly owner: symbol;
  readonly redirectTo: string;
}

/**
 * Empty state of the GitHub picker for an account without a GitHub token (#162): the action the
 * sentence names, or why there is none. `redirectTo` defaults to the page the user is on.
 */
export function GitHubSignInPrompt({ githubConfigured, redirectTo }: { githubConfigured: boolean; redirectTo?: string }) {
  const promptOwner = useRef<symbol | null>(null);
  const activeSignIn = useRef<GitHubSignInOperation | null>(null);
  const [busyOperation, setBusyOperation] = useState<GitHubSignInOperation | null>(null);

  useLayoutEffect(() => {
    const owner = Symbol("github-sign-in-prompt");
    promptOwner.current = owner;
    activeSignIn.current = null;
    setBusyOperation(null);
    return () => {
      if (promptOwner.current === owner) promptOwner.current = null;
      if (activeSignIn.current?.owner === owner) activeSignIn.current = null;
    };
  }, []);

  const beginSignIn = () => {
    const owner = promptOwner.current;
    if (!owner || activeSignIn.current) return;
    const operation: GitHubSignInOperation = {
      owner,
      redirectTo: redirectTo ?? window.location.href,
    };
    activeSignIn.current = operation;
    setBusyOperation(operation);
    void signIn("github", { redirectTo: operation.redirectTo }).catch(() => {
      if (promptOwner.current !== owner || activeSignIn.current !== operation) return;
      activeSignIn.current = null;
      setBusyOperation((current) => (current === operation ? null : current));
    });
  };

  const busy = busyOperation !== null;
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
            onClick={beginSignIn}
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

interface GitHubPickerProps {
  mode: "link" | "import";
  doc?: DocumentDto;
  onLinked?: (doc: DocumentDto) => void;
  onImported?: (docId: string) => void;
  /** The signed-in account has a GitHub token. */
  githubAvailable: boolean;
  /** The server has a GitHub OAuth app, so "Sign in with GitHub" can work. */
  githubConfigured: boolean;
}

type GitHubPickerAction =
  | Readonly<{ kind: "gist-import"; payload: Readonly<{ source: "gist"; gistId?: string; filename?: string }> }>
  | Readonly<{ kind: "gist-link"; payload: Readonly<{ storage: "gist"; gistId?: string; filename: string; isPublic: boolean; description: string }> }>
  | Readonly<{ kind: "repo-import"; payload: Readonly<{ source: "repo"; owner: string; repo: string; branch: string; path: string }> }>
  | Readonly<{ kind: "repo-link"; payload: Readonly<{ storage: "repo"; owner: string; repo: string; branch: string; path: string }> }>;

interface GitHubPickerOperation {
  readonly id: number;
  readonly visit: number;
  readonly mode: GitHubPickerProps["mode"];
  readonly documentId: string | null;
  readonly action: GitHubPickerAction;
}

let githubPickerVisitSequence = 0;
let githubPickerOperationSequence = 0;

interface ListLoadState<T> {
  items: T[] | null;
  error: string | null;
  pending: boolean;
}

function initialListLoadState<T>(): ListLoadState<T> {
  return { items: null, error: null, pending: false };
}

function listLoadErrorText(error: unknown, fallback: string): string {
  const reason = apiErrorText(error, "");
  return reason ? `${fallback} ${reason}` : fallback;
}

function useListLoad<T>() {
  const [state, setState] = useState<ListLoadState<T>>(initialListLoadState);
  const requestSequence = useRef(0);
  const requestPending = useRef(false);

  useEffect(
    () => () => {
      requestSequence.current += 1;
      requestPending.current = false;
    },
    [],
  );

  const load = useCallback((request: () => Promise<T[]>, fallback: string) => {
    if (requestPending.current) return;
    requestPending.current = true;
    const sequence = ++requestSequence.current;
    setState((current) => ({ ...current, pending: true }));

    void (async () => {
      try {
        const items = await request();
        if (sequence !== requestSequence.current) return;
        requestPending.current = false;
        setState({ items, error: null, pending: false });
      } catch (error) {
        if (sequence !== requestSequence.current) return;
        requestPending.current = false;
        setState({ items: null, error: listLoadErrorText(error, fallback), pending: false });
      }
    })();
  }, []);

  const invalidate = useCallback(() => {
    requestSequence.current += 1;
    requestPending.current = false;
    setState((current) => (current.pending ? initialListLoadState<T>() : current));
  }, []);

  const reset = useCallback(() => {
    requestSequence.current += 1;
    requestPending.current = false;
    setState(initialListLoadState<T>());
  }, []);

  return { state, load, invalidate, reset };
}

function ListLoadError({
  error,
  pending,
  onRetry,
  testId,
}: {
  error: string;
  pending: boolean;
  onRetry: () => void;
  testId: string;
}) {
  return (
    <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid={testId}>
      <div>{error}</div>
      <button
        type="button"
        className="btn btn-outline btn-sm mt-2 gap-1.5"
        onClick={onRetry}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending && <Loader2 size={13} className="animate-spin" />}
        {pending ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** Connect a document to a gist or repository file, or pick a file to import. */
export function GitHubPicker(props: GitHubPickerProps) {
  const documentKey = props.mode === "link" ? (props.doc?.id ?? "missing") : "import";
  return <GitHubPickerVisit key={`${props.mode}:${documentKey}`} {...props} />;
}

function GitHubPickerVisit({
  mode,
  doc,
  onLinked,
  onImported,
  githubAvailable,
  githubConfigured,
}: GitHubPickerProps) {
  const [tab, setTab] = useState<Tab>("gist");
  const { state: gistList, load: startGistLoad, invalidate: invalidateGistLoad } = useListLoad<GistItem>();
  const { state: repoList, load: startRepoLoad, invalidate: invalidateRepoLoad } = useListLoad<RepoItem>();
  const { state: branchList, load: startBranchLoad, invalidate: invalidateBranchLoad, reset: resetBranchLoad } = useListLoad<string>();
  const { state: fileList, load: startFileLoad, invalidate: invalidateFileLoad, reset: resetFileLoad } = useListLoad<{ path: string }>();
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  // gist state
  const [newGist, setNewGist] = useState(mode === "link");
  const [gistName, setGistName] = useState(`${(doc?.title ?? "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"}.md`);
  const [gistPublic, setGistPublic] = useState(false);
  // repo state
  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [visit] = useState(() => ++githubPickerVisitSequence);
  const mountedRef = useRef(false);
  const activeOperationRef = useRef<GitHubPickerOperation | null>(null);
  const onLinkedRef = useRef(onLinked);
  const onImportedRef = useRef(onImported);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeOperationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    onLinkedRef.current = onLinked;
    onImportedRef.current = onImported;
  }, [onImported, onLinked]);

  const loadGists = useCallback(() => {
    if (tab !== "gist") return;
    startGistLoad(async () => (await api.github.gists()).gists, "Could not load gists.");
  }, [startGistLoad, tab]);

  const loadRepos = useCallback(() => {
    if (tab !== "repo" || repo) return;
    startRepoLoad(async () => (await api.github.repos()).repos, "Could not load repositories.");
  }, [repo, startRepoLoad, tab]);

  const loadBranches = useCallback(() => {
    if (tab !== "repo" || !repo) return;
    const currentRepo = repo;
    startBranchLoad(
      async () => (await api.github.branches(currentRepo.owner, currentRepo.name)).branches,
      `Could not load branches for ${currentRepo.fullName}.`,
    );
  }, [repo, startBranchLoad, tab]);

  const loadFiles = useCallback(() => {
    if (tab !== "repo" || !repo || !branch) return;
    const currentRepo = repo;
    const currentBranch = branch;
    startFileLoad(
      async () => (await api.github.files(currentRepo.owner, currentRepo.name, currentBranch)).files,
      `Could not load files from ${currentRepo.fullName} on ${currentBranch}.`,
    );
  }, [branch, repo, startFileLoad, tab]);

  useEffect(() => {
    if (!githubAvailable) return;
    if (tab === "gist" && gistList.items === null && !gistList.error && !gistList.pending) {
      loadGists();
    }
    if (tab === "repo" && !repo && repoList.items === null && !repoList.error && !repoList.pending) {
      loadRepos();
    }
  }, [githubAvailable, gistList.error, gistList.items, gistList.pending, loadGists, loadRepos, repo, repoList.error, repoList.items, repoList.pending, tab]);

  useEffect(() => {
    if (tab === "repo" && repo && branchList.items === null && !branchList.error && !branchList.pending) loadBranches();
  }, [branchList.error, branchList.items, branchList.pending, loadBranches, repo, tab]);

  useEffect(() => {
    if (tab === "repo" && repo && branch && fileList.items === null && !fileList.error && !fileList.pending) loadFiles();
  }, [branch, fileList.error, fileList.items, fileList.pending, loadFiles, repo, tab]);

  const filteredGists = useMemo(() => {
    const q = filter.toLowerCase();
    return (gistList.items ?? []).filter((g) => !q || (g.description ?? "").toLowerCase().includes(q) || g.files.some((f) => f.filename.toLowerCase().includes(q)));
  }, [gistList.items, filter]);
  const filteredRepos = useMemo(() => {
    const q = filter.toLowerCase();
    return (repoList.items ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [repoList.items, filter]);
  const filteredFiles = useMemo(() => {
    const q = filter.toLowerCase();
    return (fileList.items ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
  }, [fileList.items, filter]);

  const selectTab = (nextTab: Tab) => {
    if (activeOperationRef.current) return;
    if (nextTab === tab) return;
    if (tab === "gist") {
      invalidateGistLoad();
    } else if (repo) {
      invalidateBranchLoad();
      invalidateFileLoad();
    } else {
      invalidateRepoLoad();
    }
    setTab(nextTab);
    setFilter("");
  };

  const selectRepo = (nextRepo: RepoItem) => {
    if (activeOperationRef.current) return;
    resetBranchLoad();
    resetFileLoad();
    setRepo(nextRepo);
    setBranch(nextRepo.defaultBranch);
  };

  const showRepositories = () => {
    if (activeOperationRef.current) return;
    resetBranchLoad();
    resetFileLoad();
    setRepo(null);
    setBranch("");
  };

  const selectBranch = (nextBranch: string) => {
    if (activeOperationRef.current) return;
    if (nextBranch === branch) return;
    resetFileLoad();
    setBranch(nextBranch);
  };

  const run = (action: GitHubPickerAction) => {
    if (activeOperationRef.current) return;
    const documentId = mode === "link" ? (doc?.id ?? null) : null;
    if (mode === "link" && !documentId) {
      setActionError("Something went wrong");
      return;
    }

    const operation = Object.freeze<GitHubPickerOperation>({
      id: ++githubPickerOperationSequence,
      visit,
      mode,
      documentId,
      action,
    });
    activeOperationRef.current = operation;
    setBusy(true);
    setActionError(null);

    const isCurrent = () =>
      mountedRef.current &&
      activeOperationRef.current === operation &&
      operation.visit === visit &&
      operation.mode === mode &&
      operation.documentId === (mode === "link" ? (doc?.id ?? null) : null);

    void (async () => {
      try {
        switch (operation.action.kind) {
          case "gist-import": {
            const res = await api.import(operation.action.payload);
            if (isCurrent()) onImportedRef.current?.(res.document.id);
            break;
          }
          case "gist-link": {
            const res = await api.documents.link(operation.documentId!, operation.action.payload);
            if (isCurrent()) onLinkedRef.current?.(res.document);
            break;
          }
          case "repo-import": {
            const res = await api.import(operation.action.payload);
            if (isCurrent()) onImportedRef.current?.(res.document.id);
            break;
          }
          case "repo-link": {
            const res = await api.documents.link(operation.documentId!, operation.action.payload);
            if (isCurrent()) onLinkedRef.current?.(res.document);
            break;
          }
        }
      } catch (error) {
        if (isCurrent()) setActionError(apiErrorText(error, "Something went wrong"));
      } finally {
        if (!isCurrent()) return;
        activeOperationRef.current = null;
        setBusy(false);
      }
    })();
  };

  const linkGist = (gistId?: string, filename?: string) => {
    if (activeOperationRef.current) return;
    if (mode === "import") {
      const payload = Object.freeze({ source: "gist" as const, gistId, filename });
      run(Object.freeze({ kind: "gist-import" as const, payload }));
      return;
    }
    if (!doc || (!filename && !gistName.trim())) {
      setActionError("Something went wrong");
      return;
    }
    const payload = Object.freeze({ storage: "gist" as const, gistId, filename: filename ?? gistName, isPublic: gistPublic, description: doc.title });
    run(Object.freeze({ kind: "gist-link" as const, payload }));
  };

  const linkRepo = (filePath: string) => {
    if (activeOperationRef.current) return;
    if (!repo || !branch || !filePath.trim()) {
      setActionError("Something went wrong");
      return;
    }
    const destination = repo;
    if (mode === "import") {
      const payload = Object.freeze({ source: "repo" as const, owner: destination.owner, repo: destination.name, branch, path: filePath });
      run(Object.freeze({ kind: "repo-import" as const, payload }));
      return;
    }
    if (!doc) {
      setActionError("Something went wrong");
      return;
    }
    const payload = Object.freeze({ storage: "repo" as const, owner: destination.owner, repo: destination.name, branch, path: filePath });
    run(Object.freeze({ kind: "repo-link" as const, payload }));
  };

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
              onClick={() => selectTab(t)}
              disabled={busy}
              data-testid={`picker-tab-${t}`}
            >
              {t === "gist" ? "Gist" : "Repository"}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
          <input
            className="input pl-9"
            placeholder={tab === "gist" ? "Filter gists" : repo ? "Filter files" : "Filter repositories"}
            value={filter}
            disabled={busy}
            onChange={(e) => {
              if (!activeOperationRef.current) setFilter(e.target.value);
            }}
          />
        </div>
      </div>
      {actionError && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="github-action-error">
          {actionError}
        </div>
      )}

      {tab === "gist" && (
        <div className="flex flex-col gap-3">
          {mode === "link" && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="radio"
                  checked={newGist}
                  disabled={busy}
                  onChange={() => {
                    if (!activeOperationRef.current) setNewGist(true);
                  }}
                />{" "}
                Create a new gist
              </label>
              {newGist && (
                <div className="mt-3 flex items-center gap-2 pl-6">
                  <input
                    className="input flex-1"
                    value={gistName}
                    disabled={busy}
                    onChange={(e) => {
                      if (!activeOperationRef.current) setGistName(e.target.value);
                    }}
                    placeholder="filename.md"
                    data-testid="gist-filename"
                  />
                  <label className="flex items-center gap-1.5 text-sm text-ink-2">
                    <input
                      type="checkbox"
                      checked={gistPublic}
                      disabled={busy}
                      onChange={(e) => {
                        if (!activeOperationRef.current) setGistPublic(e.target.checked);
                      }}
                    />{" "}
                    Public
                  </label>
                  <button type="button" className="btn btn-primary" disabled={busy || !gistName.trim()} onClick={() => void linkGist()} data-testid="gist-create">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : "Create & publish"}
                  </button>
                </div>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="radio"
                  checked={!newGist}
                  disabled={busy}
                  onChange={() => {
                    if (!activeOperationRef.current) setNewGist(false);
                  }}
                />{" "}
                Use an existing gist
              </label>
            </div>
          )}
          {(mode === "import" || !newGist) && (
            <div className="scrollbar-thin max-h-72 overflow-y-auto rounded-xl border border-line" data-testid="gist-list">
              {gistList.error ? (
                <ListLoadError error={gistList.error} pending={gistList.pending} onRetry={loadGists} testId="gist-load-error" />
              ) : gistList.items === null ? (
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
            <div className="scrollbar-thin max-h-80 overflow-y-auto rounded-xl border border-line" data-testid="repo-list">
              {repoList.error ? (
                <ListLoadError error={repoList.error} pending={repoList.pending} onRetry={loadRepos} testId="repo-load-error" />
              ) : repoList.items === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No repositories found.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {filteredRepos.map((r) => (
                    <li key={r.fullName}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        onClick={() => selectRepo(r)}
                        disabled={busy}
                        data-testid="repo-item"
                      >
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
                <button type="button" className="btn btn-sm btn-ghost" onClick={showRepositories} disabled={busy}>
                  ← Repositories
                </button>
                <span className="font-medium text-ink">{repo.fullName}</span>
                <div className="ml-auto inline-flex items-center gap-1.5 text-ink-3" data-testid="branch-list">
                  <GitBranch size={14} />
                  {branchList.error ? (
                    <ListLoadError error={branchList.error} pending={branchList.pending} onRetry={loadBranches} testId="branch-load-error" />
                  ) : branchList.items === null ? (
                    <Spinner />
                  ) : branchList.items.length === 0 ? (
                    <span data-testid="branch-empty">No branches found.</span>
                  ) : (
                    <select className="select h-8 text-xs" value={branch} onChange={(e) => selectBranch(e.target.value)} disabled={busy} data-testid="branch-select">
                      {branchList.items.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {mode === "link" && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (path.trim()) void linkRepo(path.trim());
                  }}
                >
                  <input
                    className="input flex-1 font-mono text-[13px]"
                    placeholder="docs/new-file.md (new or existing path)"
                    value={path}
                    disabled={busy}
                    onChange={(e) => {
                      if (!activeOperationRef.current) setPath(e.target.value);
                    }}
                    data-testid="repo-path"
                  />
                  <button type="submit" className="btn btn-primary" disabled={busy || !path.trim()} data-testid="repo-link">
                    {busy ? <Loader2 size={16} className="animate-spin" /> : "Connect"}
                  </button>
                </form>
              )}
              <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-xl border border-line" data-testid="file-list">
                {fileList.error ? (
                  <ListLoadError error={fileList.error} pending={fileList.pending} onRetry={loadFiles} testId="file-load-error" />
                ) : fileList.items === null ? (
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
                          onClick={() => {
                            if (activeOperationRef.current) return;
                            if (mode === "link") setPath(f.path);
                            else linkRepo(f.path);
                          }}
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
  isOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onDocChange: (doc: DocumentDto) => void;
  githubAvailable: boolean;
  githubConfigured: boolean;
  isOwner: boolean;
}) {
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
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
                setUnlinkError(null);
                try {
                  const res = await api.documents.link(doc.id, { storage: "local" });
                  onDocChange(res.document);
                } catch (error) {
                  setUnlinkError(apiErrorText(error, "Could not disconnect the gist."));
                } finally {
                  setUnlinking(false);
                }
              }}
            >
              <Unlink size={14} /> Disconnect
            </button>
          </div>
        )}
        {linked && unlinkError && <p role="alert" className="mb-3 text-sm text-danger">{unlinkError}</p>}
        {open && <GistAutoUpdateControl doc={doc} isOwner={isOwner} />}
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
  isOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onCommit: (message: string) => Promise<void>;
  isOwner: boolean;
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
              setError(apiErrorText(err, "Publish failed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {open && <GistAutoUpdateControl doc={doc} isOwner={isOwner} />}
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
