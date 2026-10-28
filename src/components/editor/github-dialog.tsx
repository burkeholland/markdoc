"use client";
import { Dialog, DialogContent, Spinner } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { signIn } from "next-auth/react";
import { Check, ExternalLink, FileText, GitBranch, Loader2, Lock, Search, Unlink } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import { api, apiErrorText } from "@/lib/api";
import { MANAGED_ACCOUNT_GISTS_NOTE } from "@/lib/github-login";

import { cn, relativeTime } from "@/lib/utils";
import { GITHUB_NOT_CONFIGURED } from "./labels";
import { GistAutoUpdateControl } from "./gist-auto-update";
import { useEnterOnRelease, usePlaceHold } from "./press-once";

type Tab = "gist" | "repo";
const PICKER_SOURCE_ORDER = Object.freeze(["gist", "repo"] as const);
const PICKER_SOURCE_LABEL = "GitHub source";

/**
 * Empty state of the GitHub picker for an account without a GitHub token (#162): the action the
 * sentence names, or why there is none. `redirectTo` defaults to the page the user is on.
 */
export function GitHubSignInPrompt({ githubConfigured, redirectTo }: { githubConfigured: boolean; redirectTo?: string }) {
  // One sign-in at a time. The ref is set before React renders again, so the second click of a
  // double-click starts nothing.
  const signingIn = useRef(false);
  const [busy, setBusy] = useState(false);

  const startSignIn = () => {
    if (signingIn.current) return;
    signingIn.current = true;
    setBusy(true);
    // The executor calls signIn now, and a throw from it becomes a rejection. A sign-in that starts leaves
    // this page; one that fails gives the button back.
    void new Promise((resolve) => resolve(signIn("github", { redirectTo: redirectTo ?? window.location.href }))).catch(() => {
      signingIn.current = false;
      setBusy(false);
    });
  };

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-2 p-6 text-center text-sm text-ink-3" data-testid="github-signin-prompt">
      <GitHubIcon className="text-ink-4" size={24} />
      {githubConfigured ? (
        <>
          <p>
            Gists and repositories need a GitHub account. You are signed in without one — sign in with GitHub to use them as storage.
          </p>
          <button type="button" className="btn btn-primary gap-2" disabled={busy} onClick={startSignIn} data-testid="github-signin">
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
  /** The signed-in GitHub account is a managed one (`handle_shortcode`): GitHub gives it no gists. */
  managedAccount?: boolean;
}

type GitHubPickerAction =
  | Readonly<{ kind: "gist-import"; payload: Readonly<{ source: "gist"; gistId?: string; filename?: string }> }>
  | Readonly<{ kind: "gist-link"; payload: Readonly<{ storage: "gist"; gistId?: string; filename: string; isPublic: boolean; description: string }> }>
  | Readonly<{ kind: "repo-import"; payload: Readonly<{ source: "repo"; owner: string; repo: string; branch: string; path: string }> }>
  | Readonly<{ kind: "repo-link"; payload: Readonly<{ storage: "repo"; owner: string; repo: string; branch: string; path: string }> }>;

let githubPickerVisitSequence = 0;
let githubPickerOperationSequence = 0;

interface ListLoadState<T> {
  items: T[] | null;
  error: string | null;
  pending: boolean;
}

type ListLoadAuthority =
  | Readonly<{ kind: "gists"; visit: number }>
  | Readonly<{ kind: "repositories"; visit: number }>
  | Readonly<{ kind: "branches"; visit: number; owner: string; repo: string; fullName: string }>
  | Readonly<{ kind: "files"; visit: number; owner: string; repo: string; fullName: string; branch: string }>;

interface ListRequestOwner {
  readonly authority: ListLoadAuthority;
  readonly token: symbol;
}

function initialListLoadState<T>(): ListLoadState<T> {
  return { items: null, error: null, pending: false };
}

function listLoadErrorText(error: unknown, fallback: string): string {
  const reason = apiErrorText(error, "");
  return reason ? `${fallback} ${reason}` : fallback;
}

function useListLoad<T>(authority: ListLoadAuthority | null) {
  const [state, setState] = useState<ListLoadState<T>>(initialListLoadState);
  const authorityRef = useRef<ListLoadAuthority | null>(null);
  const requestOwnerRef = useRef<ListRequestOwner | null>(null);

  useLayoutEffect(() => {
    authorityRef.current = authority;
    if (requestOwnerRef.current?.authority !== authority) {
      requestOwnerRef.current = null;
      setState((current) => (current.pending ? initialListLoadState<T>() : current));
    }
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      if (requestOwnerRef.current?.authority === authority) requestOwnerRef.current = null;
    };
  }, [authority]);

  const load = useCallback(
    (request: () => Promise<T[]>, fallback: string) => {
      if (!authority || authorityRef.current !== authority || requestOwnerRef.current) return;
      const owner: ListRequestOwner = { authority, token: Symbol(authority.kind) };
      requestOwnerRef.current = owner;
      setState((current) => ({ ...current, pending: true }));
      const ownsRequest = () => authorityRef.current === authority && requestOwnerRef.current === owner;

      let response: Promise<T[]>;
      try {
        response = request();
      } catch (error) {
        response = Promise.reject(error);
      }

      void response
        .then((items) => {
          if (!ownsRequest()) return;
          setState({ items, error: null, pending: true });
        })
        .catch((error: unknown) => {
          if (!ownsRequest()) return;
          setState({ items: null, error: listLoadErrorText(error, fallback), pending: true });
        })
        .finally(() => {
          if (!ownsRequest()) return;
          requestOwnerRef.current = null;
          setState((current) => ({ ...current, pending: false }));
        });
    },
    [authority],
  );

  const retire = useCallback(
    (reset: boolean) => {
      if (!authority || authorityRef.current !== authority) return;
      authorityRef.current = null;
      if (requestOwnerRef.current?.authority === authority) requestOwnerRef.current = null;
      setState((current) => (reset || current.pending ? initialListLoadState<T>() : current));
    },
    [authority],
  );

  const invalidate = useCallback(() => retire(false), [retire]);
  const reset = useCallback(() => retire(true), [retire]);
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
      <div className="wrap-anywhere">{error}</div>
      <button
        type="button"
        className="btn btn-outline btn-sm mt-2 gap-1.5"
        onClick={() => onRetry()}
        disabled={pending}
        aria-busy={pending || undefined}
      >
        {pending && <Loader2 size={13} className="animate-spin" />}
        {pending ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

export function GitHubPicker(props: GitHubPickerProps) {
  const documentKey = props.mode === "link" ? (props.doc?.id ?? "missing") : "import";
  return (
    <>
      {props.managedAccount && props.githubAvailable && (
        <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2" role="note" data-testid="managed-account-gists-note">
          {MANAGED_ACCOUNT_GISTS_NOTE}
        </p>
      )}
      <GitHubPickerVisit key={`${props.mode}:${documentKey}`} {...props} />
    </>
  );
}

function isMarkdownGistFile(file: GistItem["files"][number]) {
  return /\.(md|markdown|mdx)$/i.test(file.filename) || file.language === "Markdown";
}

function GitHubPickerVisit({
  mode,
  doc,
  onLinked,
  onImported,
  githubAvailable,
  githubConfigured,
  managedAccount,
}: GitHubPickerProps) {
  const gistChoiceName = useId();
  // A managed account has no gists and cannot make one: it starts where it can work.
  const [tab, setTab] = useState<Tab>(managedAccount ? "repo" : "gist");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [newGist, setNewGist] = useState(mode === "link");
  const [gistName, setGistName] = useState(`${(doc?.title ?? "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"}.md`);
  const [gistPublic, setGistPublic] = useState(false);
  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [visit] = useState(() => ++githubPickerVisitSequence);
  const gistAuthority = useMemo<ListLoadAuthority | null>(
    () => (githubAvailable && tab === "gist" ? { kind: "gists", visit } : null),
    [githubAvailable, tab, visit],
  );
  const repoAuthority = useMemo<ListLoadAuthority | null>(
    () => (githubAvailable && tab === "repo" && !repo ? { kind: "repositories", visit } : null),
    [githubAvailable, repo, tab, visit],
  );
  const branchAuthority = useMemo<ListLoadAuthority | null>(
    () =>
      githubAvailable && tab === "repo" && repo
        ? { kind: "branches", visit, owner: repo.owner, repo: repo.name, fullName: repo.fullName }
        : null,
    [githubAvailable, repo, tab, visit],
  );
  const fileAuthority = useMemo<ListLoadAuthority | null>(
    () =>
      githubAvailable && tab === "repo" && repo && branch
        ? { kind: "files", visit, owner: repo.owner, repo: repo.name, fullName: repo.fullName, branch }
        : null,
    [branch, githubAvailable, repo, tab, visit],
  );
  const { state: gistList, load: startGistLoad, invalidate: invalidateGistLoad } = useListLoad<GistItem>(gistAuthority);
  const { state: repoList, load: startRepoLoad, invalidate: invalidateRepoLoad } = useListLoad<RepoItem>(repoAuthority);
  const { state: branchList, load: startBranchLoad, invalidate: invalidateBranchLoad, reset: resetBranchLoad } = useListLoad<string>(branchAuthority);
  const { state: fileList, load: startFileLoad, invalidate: invalidateFileLoad, reset: resetFileLoad } = useListLoad<{ path: string }>(fileAuthority);

  // One action at a time: the ref is set before React renders again, so a double-click starts one request.
  // A response that arrives after the picker is gone changes nothing.
  const activeOperationRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const onLinkedRef = useRef(onLinked);
  const onImportedRef = useRef(onImported);
  useEffect(() => {
    onLinkedRef.current = onLinked;
    onImportedRef.current = onImported;
  }, [onImported, onLinked]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeOperationRef.current = null;
    };
  }, []);

  const loadGists = useCallback(() => {
    if (!gistAuthority) return;
    startGistLoad(async () => (await api.github.gists()).gists, "Could not load gists.");
  }, [gistAuthority, startGistLoad]);

  const loadRepos = useCallback(() => {
    if (!repoAuthority) return;
    startRepoLoad(async () => (await api.github.repos()).repos, "Could not load repositories.");
  }, [repoAuthority, startRepoLoad]);

  const loadBranches = useCallback(() => {
    if (!branchAuthority || branchAuthority.kind !== "branches") return;
    const source = branchAuthority;
    startBranchLoad(
      async () => (await api.github.branches(source.owner, source.repo)).branches,
      `Could not load branches for ${source.fullName}.`,
    );
  }, [branchAuthority, startBranchLoad]);

  const loadFiles = useCallback(() => {
    if (!fileAuthority || fileAuthority.kind !== "files") return;
    const source = fileAuthority;
    startFileLoad(
      async () => (await api.github.files(source.owner, source.repo, source.branch)).files,
      `Could not load files from ${source.fullName} on ${source.branch}.`,
    );
  }, [fileAuthority, startFileLoad]);

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

  const query = filter.toLowerCase();
  const gistRows = useMemo(
    () =>
      (gistList.items ?? [])
        .filter(
          (gist) =>
            !query ||
            (gist.description ?? "").toLowerCase().includes(query) ||
            gist.files.some((file) => file.filename.toLowerCase().includes(query)),
        )
        .flatMap((gist) => gist.files.filter(isMarkdownGistFile).map((file) => ({ gist, file }))),
    [gistList.items, query],
  );
  const repositoryRows = useMemo(
    () => (repoList.items ?? []).filter((item) => !query || item.fullName.toLowerCase().includes(query)),
    [repoList.items, query],
  );
  const fileRows = useMemo(
    () => (fileList.items ?? []).filter((item) => !query || item.path.toLowerCase().includes(query)),
    [fileList.items, query],
  );
  const branches = branchList.items ?? [];

  const run = (action: GitHubPickerAction) => {
    if (activeOperationRef.current !== null) return;
    const documentId = mode === "link" ? (doc?.id ?? null) : null;
    if (mode === "link" && !documentId) {
      setActionError("Something went wrong");
      return;
    }
    const operation = ++githubPickerOperationSequence;
    activeOperationRef.current = operation;
    setBusy(true);
    setActionError(null);
    const isCurrent = () => mountedRef.current && activeOperationRef.current === operation;

    void (async () => {
      try {
        if (action.kind === "gist-import" || action.kind === "repo-import") {
          const res = await api.import(action.payload);
          if (isCurrent()) onImportedRef.current?.(res.document.id);
        } else {
          const res = await api.documents.link(documentId!, action.payload);
          if (isCurrent()) onLinkedRef.current?.(res.document);
        }
      } catch (error) {
        if (isCurrent()) setActionError(apiErrorText(error, "Something went wrong"));
      } finally {
        if (isCurrent()) {
          activeOperationRef.current = null;
          setBusy(false);
        }
      }
    })();
  };

  const linkGist = (gistId?: string, filename?: string) => {
    if (mode === "import") {
      run({ kind: "gist-import", payload: { source: "gist", gistId, filename } });
      return;
    }
    if (!doc || (!filename && !gistName.trim())) {
      setActionError("Something went wrong");
      return;
    }
    run({
      kind: "gist-link",
      payload: { storage: "gist", gistId, filename: filename ?? gistName, isPublic: gistPublic, description: doc.title },
    });
  };

  const linkRepo = (filePath: string) => {
    if (!repo || !branch || !filePath.trim()) {
      setActionError("Something went wrong");
      return;
    }
    const target = { owner: repo.owner, repo: repo.name, branch, path: filePath };
    if (mode === "import") {
      run({ kind: "repo-import", payload: { source: "repo", ...target } });
      return;
    }
    if (!doc) {
      setActionError("Something went wrong");
      return;
    }
    run({ kind: "repo-link", payload: { storage: "repo", ...target } });
  };

  const switchTab = (next: Tab) => {
    if (next === tab || busy) return;
    if (tab === "gist") {
      invalidateGistLoad();
    } else if (repo) {
      invalidateBranchLoad();
      invalidateFileLoad();
    } else {
      invalidateRepoLoad();
    }
    setTab(next);
    setFilter("");
  };

  // Arrow keys, Home and End move focus between the source buttons; they do not select one.
  const onSourceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.disabled);
    const from = buttons.findIndex((button) => button === event.target);
    if (from < 0) return;
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? from + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    const next = buttons[to];
    if (!next || to === from) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };

  if (!githubAvailable) {
    return <GitHubSignInPrompt githubConfigured={githubConfigured} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="github-picker">
      <div className="flex items-center gap-2">
        <div role="group" aria-label={PICKER_SOURCE_LABEL} className="flex rounded-lg border border-line p-0.5" onKeyDown={onSourceKeyDown}>
          {PICKER_SOURCE_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              className={cn("rounded-md px-3 py-1.5 text-sm font-medium", tab === t ? "bg-inverse text-white" : "text-ink-2 hover:bg-surface-3")}
              aria-pressed={tab === t}
              onClick={() => switchTab(t)}
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
            onChange={(event) => !busy && setFilter(event.currentTarget.value)}
          />
        </div>
      </div>
      {actionError && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere" role="alert" aria-atomic="true" data-testid="github-action-error">
          {actionError}
        </div>
      )}

      {tab === "gist" && (
        <div className="flex flex-col gap-3">
          {mode === "link" && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input type="radio" name={gistChoiceName} checked={newGist} disabled={busy} onChange={() => !busy && setNewGist(true)} /> Create a new gist
              </label>
              {newGist && (
                <div className="mt-3 flex items-center gap-2 pl-6">
                  <input
                    className="input flex-1"
                    value={gistName}
                    disabled={busy}
                    onChange={(event) => !busy && setGistName(event.currentTarget.value)}
                    placeholder="filename.md"
                    data-testid="gist-filename"
                  />
                  <label className="flex items-center gap-1.5 text-sm text-ink-2">
                    <input type="checkbox" checked={gistPublic} disabled={busy} onChange={(event) => !busy && setGistPublic(event.currentTarget.checked)} /> Public
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !gistName.trim()}
                    onClick={() => linkGist()}
                    data-testid="gist-create"
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : "Create & publish"}
                  </button>
                </div>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm font-medium text-ink">
                <input type="radio" name={gistChoiceName} checked={!newGist} disabled={busy} onChange={() => !busy && setNewGist(false)} /> Use an existing gist
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
              ) : gistRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown gists found.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {gistRows.map(({ gist, file }) => (
                    <li key={gist.id + file.filename}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        disabled={busy}
                        onClick={() => linkGist(gist.id, file.filename)}
                        data-testid="gist-item"
                      >
                        <FileText size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink" title={file.filename}>{file.filename}</div>
                          <div className="truncate text-xs text-ink-3" title={gist.description || gist.id}>{gist.description || gist.id}</div>
                        </div>
                        <span className="flex items-center gap-2 text-xs text-ink-4">
                          {!gist.public && <Lock size={12} />}
                          {relativeTime(gist.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
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
              ) : repositoryRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No repositories found.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {repositoryRows.map((row) => (
                    <li key={row.fullName}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        onClick={() => {
                          if (busy) return;
                          resetBranchLoad();
                          resetFileLoad();
                          setRepo(row);
                          setBranch(row.defaultBranch);
                        }}
                        disabled={busy}
                        data-testid="repo-item"
                      >
                        <GitHubIcon size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink" title={row.fullName}>{row.fullName}</div>
                          {row.description && <div className="truncate text-xs text-ink-3" title={row.description}>{row.description}</div>}
                        </div>
                        <span className="flex items-center gap-2 text-xs text-ink-4">
                          {row.private && <Lock size={12} />}
                          {row.pushedAt && relativeTime(row.pushedAt)}
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
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (busy) return;
                    resetBranchLoad();
                    resetFileLoad();
                    setRepo(null);
                    setBranch("");
                  }}
                  disabled={busy}
                >
                  ← Repositories
                </button>
                <span className="font-medium text-ink">{repo.fullName}</span>
                <div className="ml-auto inline-flex items-center gap-1.5 text-ink-3" data-testid="branch-list">
                  <GitBranch size={14} />
                  {branchList.error ? (
                    <ListLoadError error={branchList.error} pending={branchList.pending} onRetry={loadBranches} testId="branch-load-error" />
                  ) : branchList.items === null ? (
                    <Spinner />
                  ) : branches.length === 0 ? (
                    <span data-testid="branch-empty">No branches found.</span>
                  ) : (
                    <select
                      className="select h-8 text-xs"
                      value={branch}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        if (busy || next === branch) return;
                        resetFileLoad();
                        setBranch(next);
                      }}
                      disabled={busy}
                      data-testid="branch-select"
                    >
                      {branches.map((value, index) => (
                        <option key={`${value}:${index}`} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {mode === "link" && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy || !path.trim()) return;
                    linkRepo(path.trim());
                  }}
                >
                  <input
                    className="input flex-1 font-mono text-[13px]"
                    placeholder="docs/new-file.md (new or existing path)"
                    value={path}
                    disabled={busy}
                    onChange={(event) => !busy && setPath(event.currentTarget.value)}
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
                ) : fileRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown files on this branch.</div>
                ) : (
                  <ul className="divide-y divide-line">
                    {fileRows.map((row) => (
                      <li key={row.path}>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => {
                            if (busy) return;
                            if (mode === "link") setPath(row.path);
                            else linkRepo(row.path);
                          }}
                          data-testid="repo-file"
                        >
                          <FileText size={15} className="shrink-0 text-ink-4" />
                          <span className="truncate font-mono text-[13px] text-ink-2" title={row.path}>{row.path}</span>
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
  managedAccount,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  onDocChange: (doc: DocumentDto) => void;
  githubAvailable: boolean;
  githubConfigured: boolean;
  managedAccount?: boolean;
  isOwner: boolean;
}) {
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const linked = doc.storage !== "local";
  const linkedDestination = linked
    ? doc.storage === "gist" ? `Gist · ${doc.gistFile}` : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch} · ${doc.repoPath}`
    : "";
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
              <div className="truncate font-medium text-ink" title={linkedDestination}>
                {linkedDestination}
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
        {linked && unlinkError && <p role="alert" className="mb-3 text-sm text-danger wrap-anywhere">{unlinkError}</p>}
        {open && <GistAutoUpdateControl doc={doc} isOwner={isOwner} />}
        <GitHubPicker
          mode="link"
          doc={doc}
          githubAvailable={githubAvailable}
          githubConfigured={githubConfigured}
          managedAccount={managedAccount}
          onLinked={(d) => {
            onDocChange(d);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
});

/* ---------------- Commit dialog ---------------- */

/**
 * Commit is `aria-disabled`, not `disabled`, while the request runs and after it has succeeded: a disabled
 * button drops focus to the page when it switches off under the pointer or the key that pressed it, and
 * Escape and Tab then no longer reach the dialog. Pressing it while it is off does nothing.
 */
const COMMIT_SUBMIT_OFF = "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-accent";
/** How long "Published" stays on screen before the dialog closes itself. */
const COMMIT_CLOSE_AFTER_MS = 900;
/**
 * The card keeps its top edge where a card of the usual height would have it when centred, and grows
 * downwards only. The error line is the last thing in it, so Cancel and Commit stay where they are when it
 * appears, changes or goes: a second click lands on the button the first one was aimed at, never beside
 * the card. A card taller than the window scrolls inside.
 */
const COMMIT_PINNED = "[--pin:max(0.75rem,calc(50dvh-8.5rem))] top-(--pin) translate-y-0 max-h-[calc(100dvh-var(--pin)-0.75rem)] overflow-y-auto";

/** Where a commit goes. The form starts over when this changes under an open dialog. */
const commitDestination = (doc: DocumentDto) =>
  JSON.stringify([doc.id, doc.storage, doc.repoOwner, doc.repoName, doc.repoBranch, doc.repoPath, doc.gistId, doc.gistFile]);

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
  const gist = doc.storage === "gist";
  const defaultMessage = `Update ${doc.repoPath ?? doc.gistFile ?? "document"}`;
  // One visit is the dialog open on one destination. Opening it, or the destination changing under it,
  // starts over; a refresh of the same document (a new title, its first `publishedAt`) keeps the draft.
  const visit = open ? commitDestination(doc) : null;
  const [shownVisit, setShownVisit] = useState(visit);
  const [message, setMessage] = useState(defaultMessage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (shownVisit !== visit) {
    setShownVisit(visit);
    if (visit !== null) {
      setMessage(defaultMessage);
      setBusy(false);
      setError(null);
      setDone(false);
    }
  }
  // The request this visit is waiting for, from the submit until "Published" has closed the dialog (or
  // the failure is shown). While it is set nothing else is sent. Ending the visit (Cancel, Escape, Close,
  // a click outside, a new destination) lets go of it: the request itself goes on and the editor reports
  // how it ended, but it no longer changes this form.
  const running = useRef<symbol | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  useEffect(
    () => () => {
      running.current = null;
    },
    [visit],
  );
  const messageId = useId();
  const messageRef = useRef<HTMLInputElement | null>(null);
  // Enter in the message field commits when the key is released, and only a press that started in the
  // field: a key held since the menu item that opened this dialog commits nothing, and the repeats of a
  // held Enter do not outlive the dialog on the button that gets focus back.
  const enterInMessage = useRef(false);
  const enterOnRelease = useEnterOnRelease();
  // Cancel closes the dialog under the pointer: the rest of a double-click must not land on the page.
  const cancelHold = usePlaceHold(!open);

  const submit = () => {
    if (running.current) return;
    const own = Symbol("commit");
    running.current = own;
    // An error from the try before stays until this one has ended, so nothing moves at the click.
    setBusy(true);
    let pending: Promise<void>;
    try {
      // The message as the field shows it now, not as the last render saw it.
      pending = onCommit((messageRef.current?.value ?? message).trim());
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      () => {
        if (running.current !== own) return;
        setBusy(false);
        setError(null);
        setDone(true);
        // "Published" stays for a moment, then the dialog closes, unless the visit has ended by then.
        setTimeout(() => {
          if (running.current !== own) return;
          running.current = null;
          onOpenChangeRef.current(false);
        }, COMMIT_CLOSE_AFTER_MS);
      },
      (e: unknown) => {
        if (running.current !== own) return;
        running.current = null;
        setBusy(false);
        setError(apiErrorText(e, "Publish failed"));
      },
    );
  };

  // Arrow keys, Home and End move between Cancel and Commit. They stop at the ends and at a button that is off.
  const onActionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const from = buttons.findIndex((button) => button === event.target);
    if (from < 0) return;
    const to =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? from + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? from - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1;
    const next = buttons[to];
    if (!next || to === from || next.getAttribute("aria-disabled") === "true") return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={COMMIT_PINNED}
          title={gist ? "Update gist" : "Commit to GitHub"}
          description={gist ? "Publishes the current text to the gist." : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            onKeyDown={enterOnRelease.onKeyDown}
            onKeyUp={enterOnRelease.onKeyUp}
            onBlur={enterOnRelease.onBlur}
          >
            <GistAutoUpdateControl doc={doc} isOwner={isOwner} />
            <label className="text-sm font-medium text-ink-2" htmlFor={messageId}>
              {gist ? "Description" : "Commit message"}
            </label>
            <input
              ref={messageRef}
              id={messageId}
              className="input"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                // 229: the Enter that ends an IME composition, which some browsers report as not composing.
                if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                if (!event.repeat) enterInMessage.current = !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
              }}
              onKeyUp={(event) => {
                if (event.key !== "Enter") return;
                const pressed = enterInMessage.current;
                enterInMessage.current = false;
                if (pressed) submit();
              }}
              onBlur={() => {
                enterInMessage.current = false;
              }}
              autoFocus
              data-testid="commit-message"
            />
            <p className="text-xs text-ink-3">Pending suggestions are not included until they are accepted.</p>
            <div className="flex justify-end gap-2" onKeyDown={onActionsKeyDown}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={(event) => {
                  cancelHold.arm(event, event.currentTarget);
                  onOpenChange(false);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={cn("btn btn-primary gap-2", COMMIT_SUBMIT_OFF)}
                aria-disabled={busy || done || undefined}
                // A double-click, or a double tap, is one press: its second click (`detail` 2) submits
                // nothing, also when the first one has already failed and the button is on again.
                onClick={(event) => {
                  if (event.detail > 1) event.preventDefault();
                }}
                data-testid="commit-submit"
              >
                {done ? <Check size={16} /> : busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {done ? "Published" : gist ? "Update gist" : "Commit"}
              </button>
            </div>
            {error !== null && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere" role="alert">
                {error}
              </div>
            )}
          </form>
        </DialogContent>
      </Dialog>
      {cancelHold.shield}
    </>
  );
});
