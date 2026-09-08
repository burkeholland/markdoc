"use client";
import { Dialog, DialogContent, Spinner } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
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
  buttonRef,
  testId,
}: {
  error: string;
  pending: boolean;
  onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
  testId: string;
}) {
  return (
    <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid={testId}>
      <div>{error}</div>
      <button
        ref={buttonRef}
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

interface PickerGistFilePresentation {
  readonly index: number;
  readonly source: GistItem["files"][number];
  readonly filename: string;
  readonly language: string | null;
  readonly size: number;
}

interface PickerGistPresentation {
  readonly index: number;
  readonly source: GistItem;
  readonly id: string;
  readonly description: string | null;
  readonly public: boolean;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly sourceFiles: GistItem["files"];
  readonly files: readonly PickerGistFilePresentation[];
}

interface PickerGistRowPresentation {
  readonly index: number;
  readonly gist: PickerGistPresentation;
  readonly file: PickerGistFilePresentation;
}

interface PickerRepoPresentation {
  readonly index: number;
  readonly source: RepoItem;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly pushedAt: string | null;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly value: RepoItem;
}

interface PickerFilePresentation {
  readonly index: number;
  readonly source: { path: string };
  readonly path: string;
}

interface PickerBranchPresentation {
  readonly index: number;
  readonly value: string;
}

interface PickerListPresentation<T, P> {
  readonly state: ListLoadState<T>;
  readonly sourceItems: T[] | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly items: readonly P[];
}

interface PickerCallbacks {
  readonly onLinked: GitHubPickerProps["onLinked"];
  readonly onImported: GitHubPickerProps["onImported"];
  readonly loadGists: () => void;
  readonly loadRepos: () => void;
  readonly loadBranches: () => void;
  readonly loadFiles: () => void;
  readonly invalidateGistLoad: () => void;
  readonly invalidateRepoLoad: () => void;
  readonly invalidateBranchLoad: () => void;
  readonly invalidateFileLoad: () => void;
  readonly resetBranchLoad: () => void;
  readonly resetFileLoad: () => void;
}

interface GitHubPickerPresentation {
  readonly identity: object;
  readonly revision: number;
  readonly mount: symbol;
  readonly visit: number;
  readonly mode: GitHubPickerProps["mode"];
  readonly document: DocumentDto | undefined;
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly githubAvailable: boolean;
  readonly githubConfigured: boolean;
  readonly tab: Tab;
  readonly filter: string;
  readonly gistChoiceName: string;
  readonly newGist: boolean;
  readonly gistName: string;
  readonly gistPublic: boolean;
  readonly selectedRepo: PickerRepoPresentation | null;
  readonly branch: string;
  readonly path: string;
  readonly busy: boolean;
  readonly actionError: string | null;
  readonly operation: GitHubPickerOperation | null;
  readonly callbacks: PickerCallbacks;
  readonly gists: PickerListPresentation<GistItem, PickerGistPresentation>;
  readonly gistRows: readonly PickerGistRowPresentation[];
  readonly repositories: PickerListPresentation<RepoItem, PickerRepoPresentation>;
  readonly repositoryRows: readonly PickerRepoPresentation[];
  readonly branches: PickerListPresentation<string, PickerBranchPresentation>;
  readonly files: PickerListPresentation<{ path: string }, PickerFilePresentation>;
  readonly fileRows: readonly PickerFilePresentation[];
}

type PickerElementName =
  | "root"
  | "tabGist"
  | "tabRepo"
  | "filter"
  | "newGist"
  | "existingGist"
  | "gistName"
  | "gistPublic"
  | "gistCreate"
  | "gistList"
  | "gistRetry"
  | "gistRows"
  | "repositoryList"
  | "repositoryRetry"
  | "repositoryRows"
  | "repositoryBack"
  | "branchList"
  | "branchRetry"
  | "branchSelect"
  | "pathForm"
  | "path"
  | "pathSubmit"
  | "fileList"
  | "fileRetry"
  | "fileRows";

type PickerMappedElementName = "gistRows" | "repositoryRows" | "branchOptions" | "fileRows";
type PickerMappedItem =
  | PickerGistRowPresentation
  | PickerRepoPresentation
  | PickerBranchPresentation
  | PickerFilePresentation;
type PickerRuntimePhase =
  | "mounting"
  | "active"
  | "layout-retired"
  | "replacement-retired"
  | "refs-detached"
  | "replay-ready"
  | "successor-requested"
  | "dead";

type PickerRefOwner =
  | {
      readonly kind: "element";
      readonly name: PickerElementName;
      current: HTMLElement | null;
      captured: boolean;
      readonly capture: (element: HTMLElement | null) => void;
    }
  | {
      readonly kind: "mapped";
      readonly mapName: PickerMappedElementName;
      readonly item: PickerMappedItem;
      current: HTMLElement | null;
      captured: boolean;
      readonly capture: (element: HTMLElement | null) => void;
    };

interface GitHubPickerPresentationRuntime {
  claimed: boolean;
  phase: PickerRuntimePhase;
  layoutRetired: boolean;
  publication: GitHubPickerPublication | null;
  history: PickerMutationHistory | null;
  expiry: number;
  readonly owners: PickerRefOwner[];
  readonly elementOwners: Map<PickerElementName, PickerRefOwner>;
  readonly mappedOwners: Map<object, PickerRefOwner>;
  committedRefs: Map<PickerRefOwner, HTMLElement> | null;
  mountReplayRefs: Set<PickerRefOwner>;
  replayExpected: Set<PickerRefOwner>;
  replayDetached: Set<PickerRefOwner>;
  replayAttached: Set<PickerRefOwner>;
  elements: Record<PickerElementName, HTMLElement | null>;
  gistRows: Map<PickerGistRowPresentation, HTMLButtonElement>;
  repositoryRows: Map<PickerRepoPresentation, HTMLButtonElement>;
  branchOptions: Map<PickerBranchPresentation, HTMLOptionElement>;
  fileRows: Map<PickerFilePresentation, HTMLButtonElement>;
}

interface PickerDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PickerDomSnapshot[];
}

interface GitHubPickerPublication {
  readonly presentation: GitHubPickerPresentation;
  readonly runtime: GitHubPickerPresentationRuntime;
  readonly ownerDocument: Document;
  readonly rootParent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly dom: PickerDomSnapshot;
}

interface PickerReplay {
  readonly source: GitHubPickerPublication;
  readonly history: PickerMutationHistory;
}

class GitHubPickerPublicationCoordinator {
  #active: GitHubPickerPublication | null = null;
  #successorOf: GitHubPickerPublication | null = null;
  #replay: PickerReplay | null = null;
  #retired = new WeakSet<GitHubPickerPublication>();
  #claimedEvents = new WeakSet<object>();

  active() {
    return this.#active;
  }

  successorOf() {
    return this.#successorOf;
  }

  replay() {
    return this.#replay;
  }

  isRetired(publication: GitHubPickerPublication) {
    return this.#retired.has(publication);
  }

  markRetired(publication: GitHubPickerPublication) {
    this.#retired.add(publication);
  }

  retire(publication: GitHubPickerPublication) {
    this.markRetired(publication);
    if (this.#active !== publication) return false;
    this.#active = null;
    this.#successorOf = publication;
    return true;
  }

  publish(publication: GitHubPickerPublication) {
    this.#active = publication;
    this.#successorOf = null;
  }

  clear(publication: GitHubPickerPublication) {
    if (this.#active === publication) this.#active = null;
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  startReplay(replay: PickerReplay) {
    this.#replay = replay;
  }

  clearReplay(publication: GitHubPickerPublication) {
    if (this.#replay?.source !== publication) return false;
    this.#replay = null;
    return true;
  }

  hasClaimed(event: object) {
    return this.#claimedEvents.has(event);
  }

  claim(event: object) {
    this.#claimedEvents.add(event);
  }
}

class GitHubPickerRuntimeRegistry {
  #runtimes = new WeakMap<GitHubPickerPresentation, GitHubPickerPresentationRuntime>();

  get(candidate: GitHubPickerPresentation) {
    return this.#runtimes.get(candidate);
  }

  for(candidate: GitHubPickerPresentation) {
    let runtime = this.get(candidate);
    if (!runtime) {
      runtime = {
        claimed: false,
        phase: "mounting",
        layoutRetired: false,
        publication: null,
        history: null,
        expiry: 0,
        owners: [],
        elementOwners: new Map(),
        mappedOwners: new Map(),
        committedRefs: null,
        mountReplayRefs: new Set(),
        replayExpected: new Set(),
        replayDetached: new Set(),
        replayAttached: new Set(),
        elements: emptyPickerElements(),
        gistRows: new Map(),
        repositoryRows: new Map(),
        branchOptions: new Map(),
        fileRows: new Map(),
      };
      this.#runtimes.set(candidate, runtime);
    }
    return runtime;
  }
}

type PickerChangingControl = "filter" | "newGist" | "gistName" | "gistPublic" | "branch" | "path" | null;

function snapshotPickerGist(item: GistItem, index: number): PickerGistPresentation {
  return Object.freeze({
    index,
    source: item,
    id: item.id,
    description: item.description,
    public: item.public,
    updatedAt: item.updatedAt,
    htmlUrl: item.htmlUrl,
    sourceFiles: item.files,
    files: Object.freeze(
      item.files.map((file, fileIndex) =>
        Object.freeze({
          index: fileIndex,
          source: file,
          filename: file.filename,
          language: file.language,
          size: file.size,
        }),
      ),
    ),
  });
}

function snapshotPickerRepo(item: RepoItem, index: number): PickerRepoPresentation {
  const value = Object.freeze<RepoItem>({
    owner: item.owner,
    name: item.name,
    fullName: item.fullName,
    private: item.private,
    defaultBranch: item.defaultBranch,
    pushedAt: item.pushedAt,
    htmlUrl: item.htmlUrl,
    description: item.description,
  });
  return Object.freeze({ index, source: item, ...value, value });
}

function snapshotPickerFile(item: { path: string }, index: number): PickerFilePresentation {
  return Object.freeze({ index, source: item, path: item.path });
}

function snapshotPickerBranch(value: string, index: number): PickerBranchPresentation {
  return Object.freeze({ index, value });
}

function pickerList<T, P>(state: ListLoadState<T>, snapshot: (item: T, index: number) => P): PickerListPresentation<T, P> {
  return Object.freeze({
    state,
    sourceItems: state.items,
    error: state.error,
    pending: state.pending,
    items: Object.freeze((state.items ?? []).map(snapshot)),
  });
}

function pickerGistFactsMatch(list: PickerListPresentation<GistItem, PickerGistPresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((item, index) => {
    const current = source[index];
    if (
      !current ||
      item.index !== index ||
      item.source !== current ||
      item.id !== current.id ||
      item.description !== current.description ||
      item.public !== current.public ||
      item.updatedAt !== current.updatedAt ||
      item.htmlUrl !== current.htmlUrl ||
      item.sourceFiles !== current.files ||
      item.files.length !== current.files.length
    ) {
      return false;
    }
    return item.files.every((file, fileIndex) => {
      const currentFile = current.files[fileIndex];
      return (
        !!currentFile &&
        file.index === fileIndex &&
        file.source === currentFile &&
        file.filename === currentFile.filename &&
        file.language === currentFile.language &&
        file.size === currentFile.size
      );
    });
  });
}

function pickerRepoFactsMatch(list: PickerListPresentation<RepoItem, PickerRepoPresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((item, index) => {
    const current = source[index];
    return (
      !!current &&
      item.index === index &&
      item.source === current &&
      item.owner === current.owner &&
      item.name === current.name &&
      item.fullName === current.fullName &&
      item.private === current.private &&
      item.defaultBranch === current.defaultBranch &&
      item.pushedAt === current.pushedAt &&
      item.htmlUrl === current.htmlUrl &&
      item.description === current.description
    );
  });
}

function pickerSelectedRepoFactsMatch(item: PickerRepoPresentation | null): boolean {
  if (!item) return true;
  const current = item.source;
  return (
    item.owner === current.owner &&
    item.name === current.name &&
    item.fullName === current.fullName &&
    item.private === current.private &&
    item.defaultBranch === current.defaultBranch &&
    item.pushedAt === current.pushedAt &&
    item.htmlUrl === current.htmlUrl &&
    item.description === current.description
  );
}

function pickerBranchFactsMatch(list: PickerListPresentation<string, PickerBranchPresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((branch, index) => branch.index === index && branch.value === source[index]);
}

function pickerFileFactsMatch(list: PickerListPresentation<{ path: string }, PickerFilePresentation>): boolean {
  const source = list.sourceItems;
  if (list.state.items !== source || list.state.error !== list.error || list.state.pending !== list.pending) return false;
  if (source === null) return list.items.length === 0;
  if (source.length !== list.items.length) return false;
  return list.items.every((item, index) => {
    const current = source[index];
    return !!current && item.index === index && item.source === current && item.path === current.path;
  });
}

function pickerRenderedFactsMatch(presentation: GitHubPickerPresentation): boolean {
  const query = presentation.filter.toLowerCase();
  const expectedGistRows: Array<readonly [PickerGistPresentation, PickerGistFilePresentation]> = [];
  for (const gist of presentation.gists.items) {
    if (
      query &&
      !(gist.description ?? "").toLowerCase().includes(query) &&
      !gist.files.some((file) => file.filename.toLowerCase().includes(query))
    ) {
      continue;
    }
    for (const file of gist.files) {
      if (/\.(md|markdown|mdx)$/i.test(file.filename) || file.language === "Markdown") {
        expectedGistRows.push([gist, file]);
      }
    }
  }
  if (
    expectedGistRows.length !== presentation.gistRows.length ||
    !presentation.gistRows.every(
      (row, index) =>
        row.index === index &&
        row.gist === expectedGistRows[index]?.[0] &&
        row.file === expectedGistRows[index]?.[1],
    )
  ) {
    return false;
  }

  const expectedRepos = presentation.repositories.items.filter(
    (repo) => !query || repo.fullName.toLowerCase().includes(query),
  );
  if (
    expectedRepos.length !== presentation.repositoryRows.length ||
    !presentation.repositoryRows.every((repo, index) => repo === expectedRepos[index])
  ) {
    return false;
  }

  const expectedFiles = presentation.files.items.filter((file) => !query || file.path.toLowerCase().includes(query));
  return (
    expectedFiles.length === presentation.fileRows.length &&
    presentation.fileRows.every((file, index) => file === expectedFiles[index])
  );
}

function pickerPresentationFactsMatch(presentation: GitHubPickerPresentation): boolean {
  return (
    presentation.githubAvailable &&
    (presentation.document?.id ?? null) === presentation.documentId &&
    (presentation.document?.title ?? null) === presentation.documentTitle &&
    pickerGistFactsMatch(presentation.gists) &&
    pickerRepoFactsMatch(presentation.repositories) &&
    pickerSelectedRepoFactsMatch(presentation.selectedRepo) &&
    pickerBranchFactsMatch(presentation.branches) &&
    pickerFileFactsMatch(presentation.files) &&
    pickerRenderedFactsMatch(presentation)
  );
}

function snapshotPickerAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    Array.from((node as Element).attributes, ({ name, value }) => Object.freeze([name, value] as const)).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  );
}

function snapshotPickerDom(node: Node): PickerDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotPickerAttributes(node),
    children: Object.freeze(Array.from(node.childNodes, snapshotPickerDom)),
  });
}

function pickerDomMatches(snapshot: PickerDomSnapshot, ownerDocument: Document): boolean {
  const { node, children } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue ||
    node.childNodes.length !== children.length
  ) {
    return false;
  }
  const attributes = snapshotPickerAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (node.childNodes.item(index) !== child.node || !pickerDomMatches(child, ownerDocument)) return false;
  }
  return true;
}

function emptyPickerElements(): Record<PickerElementName, HTMLElement | null> {
  return {
    root: null,
    tabGist: null,
    tabRepo: null,
    filter: null,
    newGist: null,
    existingGist: null,
    gistName: null,
    gistPublic: null,
    gistCreate: null,
    gistList: null,
    gistRetry: null,
    gistRows: null,
    repositoryList: null,
    repositoryRetry: null,
    repositoryRows: null,
    repositoryBack: null,
    branchList: null,
    branchRetry: null,
    branchSelect: null,
    pathForm: null,
    path: null,
    pathSubmit: null,
    fileList: null,
    fileRetry: null,
    fileRows: null,
  };
}

function pickerPlacementMatches(publication: GitHubPickerPublication): boolean {
  const root = publication.dom.node;
  return Boolean(
    root &&
      root.ownerDocument === publication.ownerDocument &&
      root.parentNode === publication.rootParent &&
      root.previousSibling === publication.previousSibling &&
      root.nextSibling === publication.nextSibling,
  );
}

function pickerSnapshotNodes(snapshot: PickerDomSnapshot, nodes = new Set<Node>()): Set<Node> {
  nodes.add(snapshot.node);
  for (const child of snapshot.children) pickerSnapshotNodes(child, nodes);
  return nodes;
}

function pickerInputCorrectionsAreExact(
  records: readonly MutationRecord[],
  publication: GitHubPickerPublication,
): boolean {
  const root = publication.dom.node;
  const Input = publication.ownerDocument.defaultView?.HTMLInputElement;
  if (!Input || !pickerDomMatches(publication.dom, publication.ownerDocument)) return false;

  for (let index = 0; index < records.length; ) {
    const first = records[index];
    if (
      !first ||
      first.type !== "attributes" ||
      first.attributeName !== "name" ||
      !(first.target instanceof Input) ||
      !root.contains(first.target)
    ) {
      return false;
    }
    const input = first.target;
    const checkable = input.type === "checkbox" || input.type === "radio";
    if (checkable) {
      const type = records[index + 1];
      const restoredName = records[index + 2];
      if (
        first.oldValue !== input.getAttribute("name") ||
        !type ||
        type.target !== input ||
        type.type !== "attributes" ||
        type.attributeName !== "type" ||
        type.oldValue !== input.type ||
        !restoredName ||
        restoredName.target !== input ||
        restoredName.type !== "attributes" ||
        restoredName.attributeName !== "name" ||
        restoredName.oldValue !== ""
      ) {
        return false;
      }
      index += 3;
      continue;
    }
    const restoredName = records[index + 1];
    if (
      first.oldValue !== null ||
      input.hasAttribute("name") ||
      !restoredName ||
      restoredName.target !== input ||
      restoredName.type !== "attributes" ||
      restoredName.attributeName !== "name" ||
      restoredName.oldValue !== ""
    ) {
      return false;
    }
    index += 2;
  }
  return records.length > 0;
}

class PickerMutationHistory {
  private dirty = false;
  private readonly records: MutationRecord[] = [];
  private readonly rootObserver: MutationObserver;
  private readonly parentObserver: MutationObserver;

  constructor(private readonly publication: GitHubPickerPublication) {
    const Observer = publication.ownerDocument.defaultView?.MutationObserver;
    if (!Observer) throw new Error("The GitHub picker has no owner-document MutationObserver");
    this.rootObserver = new Observer((records) => {
      this.records.push(...records);
    });
    this.parentObserver = new Observer((records) => {
      if (records.length > 0) this.dirty = true;
    });
    this.rootObserver.observe(publication.dom.node, {
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    this.parentObserver.observe(publication.rootParent, { childList: true });
  }

  readonly isPristine = (allowInputNameCorrection = false) => {
    this.records.push(...this.rootObserver.takeRecords());
    if (this.parentObserver.takeRecords().length > 0) this.dirty = true;
    if (!this.dirty && this.records.length > 0) {
      const exactInputCorrection =
        allowInputNameCorrection &&
        pickerInputCorrectionsAreExact(this.records, this.publication);
      if (exactInputCorrection) this.records.length = 0;
      else this.dirty = true;
    }
    return !this.dirty;
  };

  readonly disconnect = () => {
    this.isPristine();
    this.rootObserver.disconnect();
    this.parentObserver.disconnect();
  };
}

function pickerPresentationDomIsExact(
  presentation: GitHubPickerPresentation,
  runtime: GitHubPickerPresentationRuntime,
  changing: PickerChangingControl = null,
): boolean {
  const root = runtime.elements.root;
  const ownerWindow = root?.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(root instanceof ownerWindow.HTMLDivElement) ||
    !root.isConnected ||
    root.dataset.testid !== "github-picker"
  ) {
    return false;
  }
  const ownerDocument = root.ownerDocument;
  const belongs = (element: HTMLElement | null) =>
    !!element && element.isConnected && element.ownerDocument === ownerDocument && root.contains(element);
  const none = (...names: PickerElementName[]) => names.every((name) => runtime.elements[name] === null);

  const tabGist = runtime.elements.tabGist;
  const tabRepo = runtime.elements.tabRepo;
  const filter = runtime.elements.filter;
  if (
    !(tabGist instanceof ownerWindow.HTMLButtonElement) ||
    !(tabRepo instanceof ownerWindow.HTMLButtonElement) ||
    !(filter instanceof ownerWindow.HTMLInputElement) ||
    !belongs(tabGist) ||
    !belongs(tabRepo) ||
    !belongs(filter) ||
    tabGist === tabRepo ||
    tabGist.type !== "button" ||
    tabRepo.type !== "button" ||
    tabGist.disabled !== presentation.busy ||
    tabRepo.disabled !== presentation.busy ||
    tabGist.dataset.testid !== "picker-tab-gist" ||
    tabRepo.dataset.testid !== "picker-tab-repo" ||
    filter.disabled !== presentation.busy ||
    filter.placeholder !==
      (presentation.tab === "gist"
        ? "Filter gists"
        : presentation.selectedRepo
          ? "Filter files"
          : "Filter repositories") ||
    (changing !== "filter" && filter.value !== presentation.filter)
  ) {
    return false;
  }

  if (presentation.tab === "gist") {
    if (
      !none(
        "repositoryList",
        "repositoryRetry",
        "repositoryRows",
        "repositoryBack",
        "branchList",
        "branchRetry",
        "branchSelect",
        "pathForm",
        "path",
        "pathSubmit",
        "fileList",
        "fileRetry",
        "fileRows",
      ) ||
      runtime.repositoryRows.size !== 0 ||
      runtime.branchOptions.size !== 0 ||
      runtime.fileRows.size !== 0
    ) {
      return false;
    }

    if (presentation.mode === "link") {
      const newGist = runtime.elements.newGist;
      const existingGist = runtime.elements.existingGist;
      if (
        !(newGist instanceof ownerWindow.HTMLInputElement) ||
        !(existingGist instanceof ownerWindow.HTMLInputElement) ||
        !belongs(newGist) ||
        !belongs(existingGist) ||
        newGist.type !== "radio" ||
        existingGist.type !== "radio" ||
        newGist.name !== presentation.gistChoiceName ||
        existingGist.name !== presentation.gistChoiceName ||
        newGist.disabled !== presentation.busy ||
        existingGist.disabled !== presentation.busy ||
        (changing !== "newGist" &&
          (newGist.checked !== presentation.newGist || existingGist.checked !== !presentation.newGist))
      ) {
        return false;
      }
    } else if (!none("newGist", "existingGist")) {
      return false;
    }

    if (presentation.mode === "link" && presentation.newGist) {
      const gistName = runtime.elements.gistName;
      const gistPublic = runtime.elements.gistPublic;
      const gistCreate = runtime.elements.gistCreate;
      if (
        !(gistName instanceof ownerWindow.HTMLInputElement) ||
        !(gistPublic instanceof ownerWindow.HTMLInputElement) ||
        !(gistCreate instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(gistName) ||
        !belongs(gistPublic) ||
        !belongs(gistCreate) ||
        gistName.disabled !== presentation.busy ||
        (changing !== "gistName" && gistName.value !== presentation.gistName) ||
        gistName.dataset.testid !== "gist-filename" ||
        gistPublic.type !== "checkbox" ||
        gistPublic.disabled !== presentation.busy ||
        (changing !== "gistPublic" && gistPublic.checked !== presentation.gistPublic) ||
        gistCreate.type !== "button" ||
        gistCreate.disabled !== (presentation.busy || !presentation.gistName.trim()) ||
        gistCreate.dataset.testid !== "gist-create" ||
        !none("gistList", "gistRetry", "gistRows") ||
        runtime.gistRows.size !== 0
      ) {
        return false;
      }
    } else {
      if (!none("gistName", "gistPublic", "gistCreate")) return false;
      const list = runtime.elements.gistList;
      const retry = runtime.elements.gistRetry;
      const rows = runtime.elements.gistRows;
      const hasRetry = presentation.gists.error !== null;
      const hasRows =
        !hasRetry &&
        presentation.gists.sourceItems !== null &&
        presentation.gistRows.length > 0;
      if (
        !(list instanceof ownerWindow.HTMLDivElement) ||
        !belongs(list) ||
        list.dataset.testid !== "gist-list" ||
        (hasRetry
          ? !(retry instanceof ownerWindow.HTMLButtonElement) ||
            !belongs(retry) ||
            retry.type !== "button" ||
            retry.disabled !== presentation.gists.pending
          : retry !== null) ||
        (hasRows
          ? !(rows instanceof ownerWindow.HTMLUListElement) || !belongs(rows) || rows.parentElement !== list
          : rows !== null) ||
        runtime.gistRows.size !== (hasRows ? presentation.gistRows.length : 0)
      ) {
        return false;
      }
      if (hasRows) {
        const rowList = rows as HTMLUListElement;
        if (rowList.children.length !== presentation.gistRows.length) return false;
        for (const row of presentation.gistRows) {
          const button = runtime.gistRows.get(row);
          const item = button?.parentElement;
          if (
            !(button instanceof ownerWindow.HTMLButtonElement) ||
            !belongs(button) ||
            button.type !== "button" ||
            button.disabled !== presentation.busy ||
            button.dataset.testid !== "gist-item" ||
            !(item instanceof ownerWindow.HTMLLIElement) ||
            item.parentElement !== rowList ||
            rowList.children.item(row.index) !== item ||
            item.firstElementChild !== button ||
            item.children.length !== 1
          ) {
            return false;
          }
        }
      }
    }
    return true;
  }

  if (
    !none("newGist", "existingGist", "gistName", "gistPublic", "gistCreate", "gistList", "gistRetry", "gistRows") ||
    runtime.gistRows.size !== 0
  ) {
    return false;
  }

  if (!presentation.selectedRepo) {
    if (
      !none(
        "repositoryBack",
        "branchList",
        "branchRetry",
        "branchSelect",
        "pathForm",
        "path",
        "pathSubmit",
        "fileList",
        "fileRetry",
        "fileRows",
      ) ||
      runtime.branchOptions.size !== 0 ||
      runtime.fileRows.size !== 0
    ) {
      return false;
    }
    const list = runtime.elements.repositoryList;
    const retry = runtime.elements.repositoryRetry;
    const rows = runtime.elements.repositoryRows;
    const hasRetry = presentation.repositories.error !== null;
    const hasRows =
      !hasRetry &&
      presentation.repositories.sourceItems !== null &&
      presentation.repositoryRows.length > 0;
    if (
      !(list instanceof ownerWindow.HTMLDivElement) ||
      !belongs(list) ||
      list.dataset.testid !== "repo-list" ||
      (hasRetry
        ? !(retry instanceof ownerWindow.HTMLButtonElement) ||
          !belongs(retry) ||
          retry.type !== "button" ||
          retry.disabled !== presentation.repositories.pending
        : retry !== null) ||
      (hasRows
        ? !(rows instanceof ownerWindow.HTMLUListElement) || !belongs(rows) || rows.parentElement !== list
        : rows !== null) ||
      runtime.repositoryRows.size !== (hasRows ? presentation.repositoryRows.length : 0)
    ) {
      return false;
    }
    if (hasRows) {
      const rowList = rows as HTMLUListElement;
      if (rowList.children.length !== presentation.repositoryRows.length) return false;
      for (let index = 0; index < presentation.repositoryRows.length; index++) {
        const row = presentation.repositoryRows[index];
        const button = runtime.repositoryRows.get(row);
        const item = button?.parentElement;
        if (
          !(button instanceof ownerWindow.HTMLButtonElement) ||
          !belongs(button) ||
          button.type !== "button" ||
          button.disabled !== presentation.busy ||
          button.dataset.testid !== "repo-item" ||
          !(item instanceof ownerWindow.HTMLLIElement) ||
          item.parentElement !== rowList ||
          rowList.children.item(index) !== item ||
          item.firstElementChild !== button ||
          item.children.length !== 1
        ) {
          return false;
        }
      }
    }
    return true;
  }

  if (!none("repositoryList", "repositoryRetry", "repositoryRows") || runtime.repositoryRows.size !== 0) return false;
  const repositoryBack = runtime.elements.repositoryBack;
  const branchList = runtime.elements.branchList;
  const branchRetry = runtime.elements.branchRetry;
  const fileList = runtime.elements.fileList;
  const fileRetry = runtime.elements.fileRetry;
  const fileRows = runtime.elements.fileRows;
  const hasBranchRetry = presentation.branches.error !== null;
  const hasBranchSelect =
    presentation.branches.error === null &&
    presentation.branches.sourceItems !== null &&
    presentation.branches.items.length > 0;
  const branchSelect = runtime.elements.branchSelect;
  const hasFileRows =
    presentation.files.error === null &&
    presentation.files.sourceItems !== null &&
    presentation.fileRows.length > 0;
  const hasFileRetry = presentation.files.error !== null;
  if (
    !(repositoryBack instanceof ownerWindow.HTMLButtonElement) ||
    !(branchList instanceof ownerWindow.HTMLDivElement) ||
    !(fileList instanceof ownerWindow.HTMLDivElement) ||
    !belongs(repositoryBack) ||
    !belongs(branchList) ||
    !belongs(fileList) ||
    repositoryBack.type !== "button" ||
    repositoryBack.disabled !== presentation.busy ||
    branchList.dataset.testid !== "branch-list" ||
    fileList.dataset.testid !== "file-list" ||
    (hasBranchRetry
      ? !(branchRetry instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(branchRetry) ||
        branchRetry.type !== "button" ||
        branchRetry.disabled !== presentation.branches.pending
      : branchRetry !== null) ||
    (hasFileRetry
      ? !(fileRetry instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(fileRetry) ||
        fileRetry.type !== "button" ||
        fileRetry.disabled !== presentation.files.pending
      : fileRetry !== null) ||
    (hasBranchSelect
      ? !(branchSelect instanceof ownerWindow.HTMLSelectElement) || !belongs(branchSelect)
      : branchSelect !== null) ||
    runtime.branchOptions.size !== (hasBranchSelect ? presentation.branches.items.length : 0) ||
    (hasFileRows
      ? !(fileRows instanceof ownerWindow.HTMLUListElement) || !belongs(fileRows) || fileRows.parentElement !== fileList
      : fileRows !== null) ||
    runtime.fileRows.size !== (hasFileRows ? presentation.fileRows.length : 0)
  ) {
    return false;
  }

  if (hasBranchSelect) {
    const select = branchSelect as HTMLSelectElement;
    if (
      select.disabled !== presentation.busy ||
      select.dataset.testid !== "branch-select" ||
      select.options.length !== presentation.branches.items.length ||
      (changing !== "branch" &&
        select.value !==
          (presentation.branches.items.some((item) => item.value === presentation.branch)
            ? presentation.branch
            : presentation.branches.items[0]?.value))
    ) {
      return false;
    }
    for (let index = 0; index < presentation.branches.items.length; index++) {
      const branch = presentation.branches.items[index];
      const option = runtime.branchOptions.get(branch);
      if (
        !(option instanceof ownerWindow.HTMLOptionElement) ||
        !belongs(option) ||
        option.parentElement !== select ||
        select.options.item(index) !== option ||
        option.value !== branch.value ||
        option.textContent !== branch.value
      ) {
        return false;
      }
    }
  }

  if (presentation.mode === "link") {
    const form = runtime.elements.pathForm;
    const path = runtime.elements.path;
    const submit = runtime.elements.pathSubmit;
    if (
      !(form instanceof ownerWindow.HTMLFormElement) ||
      !(path instanceof ownerWindow.HTMLInputElement) ||
      !(submit instanceof ownerWindow.HTMLButtonElement) ||
      !belongs(form) ||
      !belongs(path) ||
      !belongs(submit) ||
      path.form !== form ||
      submit.form !== form ||
      path.disabled !== presentation.busy ||
      (changing !== "path" && path.value !== presentation.path) ||
      path.dataset.testid !== "repo-path" ||
      submit.type !== "submit" ||
      submit.disabled !== (presentation.busy || !presentation.path.trim()) ||
      submit.dataset.testid !== "repo-link"
    ) {
      return false;
    }
  } else if (!none("pathForm", "path", "pathSubmit")) {
    return false;
  }

  if (hasFileRows) {
    const rowList = fileRows as HTMLUListElement;
    if (rowList.children.length !== presentation.fileRows.length) return false;
    for (let index = 0; index < presentation.fileRows.length; index++) {
      const row = presentation.fileRows[index];
      const button = runtime.fileRows.get(row);
      const item = button?.parentElement;
      if (
        !(button instanceof ownerWindow.HTMLButtonElement) ||
        !belongs(button) ||
        button.type !== "button" ||
        button.disabled !== presentation.busy ||
        button.dataset.testid !== "repo-file" ||
        !(item instanceof ownerWindow.HTMLLIElement) ||
        item.parentElement !== rowList ||
        rowList.children.item(index) !== item ||
        item.firstElementChild !== button ||
        item.children.length !== 1
      ) {
        return false;
      }
    }
  }
  return true;
}

function commitPickerPresentation(
  presentation: GitHubPickerPresentation,
  runtime: GitHubPickerPresentationRuntime,
): GitHubPickerPublication | null {
  if (!pickerPresentationFactsMatch(presentation) || !pickerPresentationDomIsExact(presentation, runtime)) return null;
  const root = runtime.elements.root;
  const RootElement = root?.ownerDocument.defaultView?.HTMLDivElement;
  if (!RootElement || !(root instanceof RootElement) || !root.parentNode) return null;
  return Object.freeze({
    presentation,
    runtime,
    ownerDocument: root.ownerDocument,
    rootParent: root.parentNode,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
    dom: snapshotPickerDom(root),
  });
}

function pickerReplayFactsMatch(
  source: GitHubPickerPresentation,
  successor: GitHubPickerPresentation,
): boolean {
  return (
    source.identity !== successor.identity &&
    successor.revision === source.revision + 1 &&
    source.mount === successor.mount &&
    source.visit === successor.visit &&
    source.mode === successor.mode &&
    source.document === successor.document &&
    source.documentId === successor.documentId &&
    source.documentTitle === successor.documentTitle &&
    source.githubAvailable === successor.githubAvailable &&
    source.githubConfigured === successor.githubConfigured &&
    source.tab === successor.tab &&
    source.filter === successor.filter &&
    source.gistChoiceName === successor.gistChoiceName &&
    source.newGist === successor.newGist &&
    source.gistName === successor.gistName &&
    source.gistPublic === successor.gistPublic &&
    source.selectedRepo === successor.selectedRepo &&
    source.branch === successor.branch &&
    source.path === successor.path &&
    source.busy === successor.busy &&
    source.actionError === successor.actionError &&
    source.operation === successor.operation &&
    source.callbacks === successor.callbacks &&
    source.gists === successor.gists &&
    source.gistRows === successor.gistRows &&
    source.repositories === successor.repositories &&
    source.repositoryRows === successor.repositoryRows &&
    source.branches === successor.branches &&
    source.files === successor.files &&
    source.fileRows === successor.fileRows &&
    pickerPresentationFactsMatch(source) &&
    pickerPresentationFactsMatch(successor)
  );
}

function pickerSyntheticEventShape(
  event: unknown,
  reactName: "onClick" | "onChange" | "onSubmit",
  defaultPrevented: boolean,
): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  return (
    candidate._reactName === reactName &&
    typeof candidate.isDefaultPrevented === "function" &&
    candidate.isDefaultPrevented() === defaultPrevented &&
    typeof candidate.isPropagationStopped === "function" &&
    candidate.isPropagationStopped() === false &&
    typeof candidate.persist === "function"
  );
}

function exactPickerEventPath(
  nativeEvent: Event,
  target: EventTarget,
  control: HTMLElement,
  publication: GitHubPickerPublication,
): boolean {
  const root = publication.runtime.elements.root;
  const ownerWindow = publication.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(root instanceof ownerWindow.HTMLDivElement) ||
    !root.isConnected ||
    root.ownerDocument !== publication.ownerDocument
  ) {
    return false;
  }
  const path = nativeEvent.composedPath();
  return path[0] === target && path.includes(control) && path.includes(root);
}

function pickerNativeMouseConstructorMatches(
  nativeEvent: MouseEvent,
  ownerWindow: Window & typeof globalThis,
): boolean {
  const PointerEventConstructor = ownerWindow.PointerEvent;
  return (
    nativeEvent.constructor === ownerWindow.MouseEvent ||
    (!!PointerEventConstructor && nativeEvent.constructor === PointerEventConstructor)
  );
}

function exactPickerClick(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement,
  publication: GitHubPickerPublication,
): boolean {
  if (!event || typeof event !== "object") return false;
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  return (
    !!ownerWindow &&
    pickerSyntheticEventShape(event, "onClick", false) &&
    event.type === "click" &&
    event.button === nativeEvent.button &&
    nativeEvent.bubbles &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.currentTarget === control &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    pickerNativeMouseConstructorMatches(nativeEvent, ownerWindow) &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    !nativeEvent.defaultPrevented &&
    target instanceof ownerWindow.Node &&
    target === nativeEvent.target &&
    target.ownerDocument === ownerDocument &&
    control.ownerDocument === ownerDocument &&
    control.isConnected &&
    !control.disabled &&
    control.contains(target) &&
    exactPickerEventPath(nativeEvent, target, control, publication)
  );
}

function exactPickerChange<T extends HTMLInputElement | HTMLSelectElement>(
  event: ReactChangeEvent<T>,
  control: T,
  publication: GitHubPickerPublication,
): boolean {
  if (!event || typeof event !== "object") return false;
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const checkableInput =
    control.tagName === "INPUT" &&
    ((control as HTMLInputElement).type === "checkbox" || (control as HTMLInputElement).type === "radio");
  const controlIsUsable =
    control.ownerDocument === ownerDocument &&
    control.isConnected &&
    !control.disabled;
  const nativeTypeAllowed = Boolean(
    ownerWindow &&
      ((nativeEvent.type === "change" && nativeEvent.constructor === ownerWindow.Event) ||
        (nativeEvent.type === "input" &&
          (nativeEvent.constructor === ownerWindow.Event ||
            (!!ownerWindow.InputEvent && nativeEvent.constructor === ownerWindow.InputEvent))) ||
        (checkableInput &&
          nativeEvent.type === "click" &&
          nativeEvent instanceof ownerWindow.MouseEvent &&
          pickerNativeMouseConstructorMatches(nativeEvent, ownerWindow))),
  );
  return (
    !!ownerWindow &&
    pickerSyntheticEventShape(event, "onChange", false) &&
    event.type === "change" &&
    nativeEvent.bubbles &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.currentTarget === control &&
    event.target === control &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.Event &&
    nativeTypeAllowed &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    nativeEvent.target === control &&
    !nativeEvent.defaultPrevented &&
    controlIsUsable &&
    exactPickerEventPath(nativeEvent, control, control, publication)
  );
}

function exactPickerSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  submit: HTMLButtonElement,
  publication: GitHubPickerPublication,
): boolean {
  if (!event || typeof event !== "object") return false;
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  return (
    !!ownerWindow?.SubmitEvent &&
    pickerSyntheticEventShape(event, "onSubmit", true) &&
    event.type === "submit" &&
    nativeEvent.bubbles &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.currentTarget === form &&
    event.target === form &&
    event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.SubmitEvent &&
    nativeEvent.constructor === ownerWindow.SubmitEvent &&
    nativeEvent.type === "submit" &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    nativeEvent.target === form &&
    nativeEvent.defaultPrevented &&
    (nativeEvent.submitter === null || nativeEvent.submitter === submit) &&
    form.ownerDocument === ownerDocument &&
    form.isConnected &&
    submit.ownerDocument === ownerDocument &&
    submit.isConnected &&
    !submit.disabled &&
    submit.form === form &&
    form.contains(submit) &&
    exactPickerEventPath(nativeEvent, form, form, publication)
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
  const [mount] = useState(() => Symbol("github-picker"));
  const gistChoiceName = useId();
  const [tab, setTab] = useState<Tab>("gist");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyOperation, setBusyOperation] = useState<GitHubPickerOperation | null>(null);
  const busy = busyOperation !== null;
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
  const mountedRef = useRef(false);
  const activeOperationRef = useRef<GitHubPickerOperation | null>(null);
  const onLinkedRef = useRef(onLinked);
  const onImportedRef = useRef(onImported);
  const [publicationCoordinator] = useState(() => new GitHubPickerPublicationCoordinator());
  const [publicationRuntimes] = useState(() => new GitHubPickerRuntimeRegistry());
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);

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

  const publishedGists = useMemo(() => pickerList(gistList, snapshotPickerGist), [gistList]);
  const publishedRepositories = useMemo(() => pickerList(repoList, snapshotPickerRepo), [repoList]);
  const publishedBranches = useMemo(() => pickerList(branchList, snapshotPickerBranch), [branchList]);
  const publishedFiles = useMemo(() => pickerList(fileList, snapshotPickerFile), [fileList]);
  const query = filter.toLowerCase();
  const gistRows = useMemo(
    () =>
      Object.freeze(
        publishedGists.items
          .filter(
            (gist) =>
              !query ||
              (gist.description ?? "").toLowerCase().includes(query) ||
              gist.files.some((file) => file.filename.toLowerCase().includes(query)),
          )
          .flatMap((gist) =>
            gist.files
              .filter((file) => /\.(md|markdown|mdx)$/i.test(file.filename) || file.language === "Markdown")
              .map((file) => ({ gist, file })),
          )
          .map(({ gist, file }, index) => Object.freeze({ index, gist, file })),
      ),
    [publishedGists, query],
  );
  const repositoryRows = useMemo(
    () =>
      Object.freeze(
        publishedRepositories.items.filter((item) => !query || item.fullName.toLowerCase().includes(query)),
      ),
    [publishedRepositories, query],
  );
  const fileRows = useMemo(
    () => Object.freeze(publishedFiles.items.filter((item) => !query || item.path.toLowerCase().includes(query))),
    [publishedFiles, query],
  );
  const selectedRepo = useMemo(() => (repo ? snapshotPickerRepo(repo, -1) : null), [repo]);
  const callbacks = useMemo(
    () =>
      Object.freeze<PickerCallbacks>({
        onLinked,
        onImported,
        loadGists,
        loadRepos,
        loadBranches,
        loadFiles,
        invalidateGistLoad,
        invalidateRepoLoad,
        invalidateBranchLoad,
        invalidateFileLoad,
        resetBranchLoad,
        resetFileLoad,
      }),
    [
      invalidateBranchLoad,
      invalidateFileLoad,
      invalidateGistLoad,
      invalidateRepoLoad,
      loadBranches,
      loadFiles,
      loadGists,
      loadRepos,
      onImported,
      onLinked,
      resetBranchLoad,
      resetFileLoad,
    ],
  );
  const presentation = useMemo(
    () =>
      Object.freeze<GitHubPickerPresentation>({
        identity: Object.freeze({}),
        revision: publicationRevision,
        mount,
        visit,
        mode,
        document: doc,
        documentId: mode === "link" ? (doc?.id ?? null) : null,
        documentTitle: mode === "link" ? (doc?.title ?? null) : null,
        githubAvailable,
        githubConfigured,
        tab,
        filter,
        gistChoiceName,
        newGist,
        gistName,
        gistPublic,
        selectedRepo,
        branch,
        path,
        busy,
        actionError,
        operation: busyOperation,
        callbacks,
        gists: publishedGists,
        gistRows,
        repositories: publishedRepositories,
        repositoryRows,
        branches: publishedBranches,
        files: publishedFiles,
        fileRows,
      }),
    [
      actionError,
      branch,
      busy,
      busyOperation,
      callbacks,
      doc,
      fileRows,
      filter,
      githubAvailable,
      githubConfigured,
      gistChoiceName,
      gistName,
      gistPublic,
      gistRows,
      mode,
      mount,
      newGist,
      path,
      publicationRevision,
      publishedBranches,
      publishedFiles,
      publishedGists,
      publishedRepositories,
      repositoryRows,
      selectedRepo,
      tab,
      visit,
    ],
  );
  const identity = presentation.identity;

  const invalidateRuntime = useCallback(
    (runtime: GitHubPickerPresentationRuntime) => {
      runtime.expiry++;
      runtime.phase = "dead";
      const publication = runtime.publication;
      if (publication) publicationCoordinator.markRetired(publication);
      const replay = publicationCoordinator.replay();
      if (publication && replay?.source === publication) {
        replay.history.disconnect();
        publicationCoordinator.clearReplay(publication);
      } else {
        runtime.history?.disconnect();
      }
      runtime.history = null;
      if (publication) publicationCoordinator.clear(publication);
    },
    [publicationCoordinator],
  );

  const retireRuntime = useCallback(
    (
      runtime: GitHubPickerPresentationRuntime,
      reason: "element" | "layout" | "replacement" | "other",
    ) => {
      if (reason === "layout") runtime.layoutRetired = true;
      const publication = runtime.publication;
      if (
        !publication ||
        runtime.phase === "mounting" ||
        runtime.phase === "dead" ||
        runtime.phase === "successor-requested" ||
        publicationCoordinator.isRetired(publication)
      ) {
        return false;
      }
      publicationCoordinator.retire(publication);
      runtime.phase = reason === "replacement" ? "replacement-retired" : "layout-retired";
      runtime.replayExpected =
        reason === "layout"
          ? new Set(runtime.committedRefs?.keys())
          : reason === "element"
            ? new Set(runtime.mountReplayRefs)
            : new Set();
      runtime.replayDetached.clear();
      runtime.replayAttached.clear();
      const ticket = ++runtime.expiry;
      queueMicrotask(() => {
        if (
          runtime.expiry === ticket &&
          runtime.phase !== "active" &&
          runtime.phase !== "successor-requested" &&
          publicationCoordinator.replay()?.source !== publication
        ) {
          invalidateRuntime(runtime);
        }
      });
      return true;
    },
    [invalidateRuntime, publicationCoordinator],
  );

  const requestReplaySuccessor = useCallback(
    (runtime: GitHubPickerPresentationRuntime) => {
      const publication = runtime.publication;
      const history = runtime.history;
      if (
        runtime.phase !== "replay-ready" ||
        !publication ||
        !history ||
        !publicationCoordinator.isRetired(publication) ||
        publicationCoordinator.active() !== null ||
        publicationCoordinator.successorOf() !== publication ||
        publicationCoordinator.replay() !== null ||
        runtime.replayExpected.size === 0 ||
        runtime.replayDetached.size !== runtime.replayExpected.size ||
        runtime.replayAttached.size !== runtime.replayExpected.size ||
        !history.isPristine() ||
        !pickerPlacementMatches(publication) ||
        !pickerDomMatches(publication.dom, publication.ownerDocument) ||
        !pickerPresentationDomIsExact(publication.presentation, runtime)
      ) {
        invalidateRuntime(runtime);
        return;
      }
      runtime.phase = "successor-requested";
      publicationCoordinator.startReplay(Object.freeze({ source: publication, history }));
      const ticket = ++runtime.expiry;
      queueMicrotask(() => {
        if (
          runtime.expiry !== ticket ||
          runtime.phase !== "successor-requested" ||
          publicationCoordinator.replay()?.source !== publication
        ) {
          return;
        }
        if (
          !history.isPristine() ||
          !pickerPlacementMatches(publication) ||
          !pickerDomMatches(publication.dom, publication.ownerDocument) ||
          !pickerPresentationDomIsExact(publication.presentation, runtime)
        ) {
          invalidateRuntime(runtime);
          return;
        }
        history.disconnect();
        requestPublicationSuccessor();
      });
    },
    [invalidateRuntime, publicationCoordinator, requestPublicationSuccessor],
  );

  const noteRef = useCallback(
    (
      runtime: GitHubPickerPresentationRuntime,
      owner: PickerRefOwner,
      element: HTMLElement | null,
    ) => {
      if (owner.current === element) return;
      const previous = owner.current;
      owner.current = element;
      if (owner.kind === "element") {
        runtime.elements[owner.name] = element;
      } else {
        const map = runtime[owner.mapName] as Map<PickerMappedItem, HTMLElement>;
        if (element) map.set(owner.item, element);
        else map.delete(owner.item);
      }

      if (
        runtime.phase === "dead" ||
        runtime.phase === "successor-requested" ||
        runtime.phase === "replacement-retired"
      ) {
        return;
      }
      if (runtime.phase === "mounting") {
        if (owner.captured || previous !== null || element === null) {
          invalidateRuntime(runtime);
          return;
        }
        owner.captured = true;
        return;
      }

      if (runtime.phase === "active") {
        if (!runtime.mountReplayRefs.has(owner)) {
          retireRuntime(runtime, "replacement");
          return;
        }
        retireRuntime(runtime, "element");
      }
      const committed = runtime.committedRefs?.get(owner);
      if (!committed || !runtime.replayExpected.has(owner)) {
        invalidateRuntime(runtime);
        return;
      }
      if (!runtime.layoutRetired) {
        if (
          previous === committed &&
          element === null &&
          !runtime.replayDetached.has(owner) &&
          !runtime.replayAttached.has(owner)
        ) {
          runtime.replayDetached.add(owner);
        } else if (
          previous === null &&
          element === committed &&
          runtime.replayDetached.has(owner) &&
          !runtime.replayAttached.has(owner)
        ) {
          runtime.replayAttached.add(owner);
        } else {
          invalidateRuntime(runtime);
          return;
        }
        if (
          runtime.replayDetached.size === runtime.replayExpected.size &&
          runtime.replayAttached.size === runtime.replayExpected.size
        ) {
          runtime.phase = "replay-ready";
          requestReplaySuccessor(runtime);
        }
        return;
      }
      if (runtime.phase === "layout-retired") {
        if (
          previous !== committed ||
          element !== null ||
          runtime.replayDetached.has(owner) ||
          runtime.replayAttached.size > 0
        ) {
          invalidateRuntime(runtime);
          return;
        }
        runtime.replayDetached.add(owner);
        if (runtime.replayDetached.size === runtime.replayExpected.size) runtime.phase = "refs-detached";
        return;
      }
      if (
        runtime.phase !== "refs-detached" ||
        previous !== null ||
        element !== committed ||
        !runtime.replayDetached.has(owner) ||
        runtime.replayAttached.has(owner)
      ) {
        invalidateRuntime(runtime);
        return;
      }
      runtime.replayAttached.add(owner);
      if (runtime.replayAttached.size === runtime.replayExpected.size) {
        runtime.phase = "replay-ready";
        if (!runtime.layoutRetired) requestReplaySuccessor(runtime);
      }
    },
    [invalidateRuntime, requestReplaySuccessor, retireRuntime],
  );

  const elementRef = useCallback(
    (candidate: GitHubPickerPresentation, name: PickerElementName) => {
      const runtime = publicationRuntimes.for(candidate);
      let owner = runtime.elementOwners.get(name);
      if (!owner) {
        owner = {
          kind: "element",
          name,
          current: null,
          captured: false,
          capture: (element) => noteRef(runtime, owner!, element),
        };
        runtime.elementOwners.set(name, owner);
        runtime.owners.push(owner);
      }
      return owner.capture;
    },
    [noteRef, publicationRuntimes],
  );

  const mappedElementRef = useCallback(
    <T extends PickerGistRowPresentation | PickerRepoPresentation | PickerBranchPresentation | PickerFilePresentation>(
      candidate: GitHubPickerPresentation,
      mapName: PickerMappedElementName,
      item: T,
    ) => {
      const runtime = publicationRuntimes.for(candidate);
      let owner = runtime.mappedOwners.get(item);
      if (!owner) {
        owner = {
          kind: "mapped",
          mapName,
          item,
          current: null,
          captured: false,
          capture: (element) => noteRef(runtime, owner!, element),
        };
        runtime.mappedOwners.set(item, owner);
        runtime.owners.push(owner);
      }
      return owner.capture;
    },
    [noteRef, publicationRuntimes],
  );

  const presentationIsCurrent = useCallback(
    (candidate: GitHubPickerPresentation) =>
      candidate === presentation &&
      candidate.identity === identity &&
      candidate.revision === publicationRevision &&
      candidate.mount === mount &&
      candidate.visit === visit &&
      candidate.mode === mode &&
      candidate.document === doc &&
      candidate.documentId === (mode === "link" ? (doc?.id ?? null) : null) &&
      candidate.documentTitle === (mode === "link" ? (doc?.title ?? null) : null) &&
      candidate.githubAvailable === githubAvailable &&
      candidate.githubConfigured === githubConfigured &&
      candidate.tab === tab &&
      candidate.filter === filter &&
      candidate.gistChoiceName === gistChoiceName &&
      candidate.newGist === newGist &&
      candidate.gistName === gistName &&
      candidate.gistPublic === gistPublic &&
      (candidate.selectedRepo?.source ?? null) === repo &&
      candidate.branch === branch &&
      candidate.path === path &&
      candidate.busy === busy &&
      candidate.actionError === actionError &&
      candidate.operation === activeOperationRef.current &&
      candidate.gists.state === gistList &&
      candidate.repositories.state === repoList &&
      candidate.branches.state === branchList &&
      candidate.files.state === fileList &&
      candidate.callbacks === callbacks &&
      candidate.callbacks.onLinked === onLinked &&
      candidate.callbacks.onImported === onImported &&
      candidate.callbacks.onLinked === onLinkedRef.current &&
      candidate.callbacks.onImported === onImportedRef.current &&
      pickerPresentationFactsMatch(candidate),
    [
      actionError,
      branch,
      branchList,
      busy,
      callbacks,
      doc,
      fileList,
      filter,
      gistChoiceName,
      gistList,
      gistName,
      gistPublic,
      githubAvailable,
      githubConfigured,
      identity,
      mode,
      mount,
      newGist,
      onImported,
      onLinked,
      path,
      presentation,
      publicationRevision,
      repo,
      repoList,
      tab,
      visit,
    ],
  );

  const replayRefsAreExact = (
    source: GitHubPickerPresentationRuntime,
    successor: GitHubPickerPresentationRuntime,
  ) => {
    const committed = source.committedRefs;
    if (
      !committed ||
      source.owners.length !== committed.size ||
      successor.owners.length !== source.owners.length
    ) {
      return false;
    }
    for (let index = 0; index < source.owners.length; index++) {
      const previous = source.owners[index];
      const current = successor.owners[index];
      if (
        !previous ||
        !current ||
        previous.kind !== current.kind ||
        current.current !== committed.get(previous) ||
        (previous.kind === "element" &&
          (current.kind !== "element" || previous.name !== current.name)) ||
        (previous.kind === "mapped" &&
          (current.kind !== "mapped" ||
            previous.mapName !== current.mapName ||
            previous.item !== current.item))
      ) {
        return false;
      }
    }
    return true;
  };

  const releasePublication = useCallback(
    (publication: GitHubPickerPublication) => {
      const replay = publicationCoordinator.replay();
      if (replay?.source === publication) {
        replay.history.disconnect();
        publicationCoordinator.clearReplay(publication);
      } else {
        publication.runtime.history?.disconnect();
      }
      publication.runtime.history = null;
      publication.runtime.phase = "dead";
      publication.runtime.expiry++;
      publicationCoordinator.clear(publication);
    },
    [publicationCoordinator],
  );

  useLayoutEffect(() => {
    const runtime = publicationRuntimes.for(presentation);
    if (!presentationIsCurrent(presentation)) {
      invalidateRuntime(runtime);
      return;
    }

    if (runtime.phase === "replay-ready") {
      if (!runtime.layoutRetired) {
        invalidateRuntime(runtime);
        return;
      }
      requestReplaySuccessor(runtime);
      return;
    }

    if (runtime.phase !== "mounting") {
      invalidateRuntime(runtime);
      return;
    }
    if (
      runtime.owners.length === 0 ||
      runtime.owners.some((owner) => !owner.captured || !owner.current) ||
      presentation.mount !== mount ||
      presentation.revision !== publicationRevision ||
      presentation.visit !== visit ||
      presentation.mode !== mode ||
      presentation.document !== doc ||
      presentation.githubAvailable !== githubAvailable ||
      presentation.githubConfigured !== githubConfigured ||
      presentation.tab !== tab ||
      presentation.filter !== filter ||
      presentation.gistChoiceName !== gistChoiceName ||
      presentation.newGist !== newGist ||
      presentation.gistName !== gistName ||
      presentation.gistPublic !== gistPublic ||
      (presentation.selectedRepo?.source ?? null) !== repo ||
      presentation.branch !== branch ||
      presentation.path !== path ||
      presentation.busy !== busy ||
      presentation.actionError !== actionError ||
      presentation.operation !== activeOperationRef.current ||
      presentation.gists.state !== gistList ||
      presentation.repositories.state !== repoList ||
      presentation.branches.state !== branchList ||
      presentation.files.state !== fileList ||
      presentation.callbacks.onLinked !== onLinkedRef.current ||
      presentation.callbacks.onImported !== onImportedRef.current
    ) {
      invalidateRuntime(runtime);
      return;
    }
    const publication = commitPickerPresentation(presentation, runtime);
    if (!publication) {
      invalidateRuntime(runtime);
      return;
    }

    let transitionSource: GitHubPickerPublication | null = null;
    const replay = publicationCoordinator.replay();
    if (replay) {
      transitionSource = replay.source;
      const sameFacts = pickerReplayFactsMatch(replay.source.presentation, presentation);
      const exactReplay =
        sameFacts &&
        publicationCoordinator.isRetired(replay.source) &&
        publicationCoordinator.successorOf() === replay.source &&
        replay.source.runtime.phase === "successor-requested" &&
        replay.history.isPristine() &&
        pickerPlacementMatches(replay.source) &&
        pickerDomMatches(replay.source.dom, replay.source.ownerDocument) &&
        replayRefsAreExact(replay.source.runtime, runtime);
      releasePublication(replay.source);
      if (sameFacts && !exactReplay) {
        invalidateRuntime(runtime);
        return;
      }
    } else {
      const successorOf = publicationCoordinator.successorOf();
      if (successorOf) {
        transitionSource = successorOf;
        releasePublication(successorOf);
      }
    }

    const previous = publicationCoordinator.active();
    if (previous && previous !== publication) {
      retireRuntime(previous.runtime, "other");
      if (publicationCoordinator.active()) {
        invalidateRuntime(runtime);
        return;
      }
      releasePublication(previous);
    }
    runtime.publication = publication;
    runtime.committedRefs = new Map(
      runtime.owners.map((owner) => [owner, owner.current!] as const),
    );
    const previousNodes = transitionSource
      ? pickerSnapshotNodes(transitionSource.dom)
      : new Set<Node>();
    runtime.mountReplayRefs = new Set(
      runtime.owners.filter((owner) => !previousNodes.has(owner.current!)),
    );
    runtime.history = new PickerMutationHistory(publication);
    if (
      !runtime.history.isPristine() ||
      !pickerPlacementMatches(publication) ||
      !pickerDomMatches(publication.dom, publication.ownerDocument) ||
      !pickerPresentationDomIsExact(presentation, runtime)
    ) {
      invalidateRuntime(runtime);
      return;
    }
    runtime.phase = "active";
    publicationCoordinator.publish(publication);
    return () => {
      retireRuntime(runtime, "layout");
    };
  }, [
    actionError,
    branch,
    branchList,
    busy,
    callbacks,
    doc,
    fileList,
    filter,
    gistChoiceName,
    gistList,
    gistName,
    gistPublic,
    githubAvailable,
    githubConfigured,
    identity,
    invalidateRuntime,
    mode,
    mount,
    newGist,
    path,
    presentation,
    presentationIsCurrent,
    publicationCoordinator,
    publicationRuntimes,
    publicationRevision,
    releasePublication,
    repo,
    repoList,
    requestPublicationSuccessor,
    requestReplaySuccessor,
    retireRuntime,
    tab,
    visit,
  ]);

  const currentPresentation = (
    candidate: GitHubPickerPresentation,
    changing: PickerChangingControl = null,
  ): GitHubPickerPublication | null => {
    const publication = publicationCoordinator.active();
    if (
      !publication ||
      publication.presentation !== candidate ||
      publication.runtime !== publicationRuntimes.get(candidate)
    ) {
      return null;
    }
    const runtime = publication.runtime;
    if (
      runtime.phase !== "active" ||
      runtime.claimed ||
      publicationCoordinator.isRetired(publication) ||
      !presentationIsCurrent(candidate) ||
      !runtime.history?.isPristine(true) ||
      !pickerPlacementMatches(publication) ||
      !pickerPresentationDomIsExact(candidate, runtime, changing) ||
      !pickerDomMatches(publication.dom, publication.ownerDocument)
    ) {
      invalidateRuntime(runtime);
      return null;
    }
    return publication;
  };

  const claimMouse = (
    candidate: GitHubPickerPresentation,
    event: ReactMouseEvent<HTMLButtonElement>,
    expected: HTMLButtonElement | null | undefined,
  ): GitHubPickerPublication | null => {
    const runtime = publicationRuntimes.get(candidate);
    const activePublication = publicationCoordinator.active();
    const nativeEvent = event?.nativeEvent;
    if (
      !runtime ||
      runtime.claimed ||
      !activePublication ||
      activePublication.presentation !== candidate ||
      activePublication.runtime !== runtime ||
      !expected ||
      !exactPickerClick(event, expected, activePublication) ||
      publicationCoordinator.hasClaimed(event) ||
      publicationCoordinator.hasClaimed(nativeEvent)
    ) {
      return null;
    }
    const publication = currentPresentation(candidate);
    if (!publication || publication.runtime !== runtime) return null;
    runtime.claimed = true;
    publicationCoordinator.claim(event);
    publicationCoordinator.claim(nativeEvent);
    return publication;
  };

  const claimChange = <T extends HTMLInputElement | HTMLSelectElement>(
    candidate: GitHubPickerPresentation,
    event: ReactChangeEvent<T>,
    expected: T | null,
    changing: Exclude<PickerChangingControl, null>,
    destinationMatches: (control: T) => boolean,
  ): GitHubPickerPublication | null => {
    const runtime = publicationRuntimes.get(candidate);
    const activePublication = publicationCoordinator.active();
    if (
      !runtime ||
      runtime.claimed ||
      !activePublication ||
      activePublication.presentation !== candidate ||
      activePublication.runtime !== runtime ||
      !expected ||
      !exactPickerChange(event, expected, activePublication) ||
      !destinationMatches(expected) ||
      publicationCoordinator.hasClaimed(event) ||
      publicationCoordinator.hasClaimed(event.nativeEvent)
    ) {
      return null;
    }
    const publication = currentPresentation(candidate, changing);
    if (!publication || publication.runtime !== runtime) return null;
    runtime.claimed = true;
    publicationCoordinator.claim(event);
    publicationCoordinator.claim(event.nativeEvent);
    return publication;
  };

  const claimSubmit = (
    candidate: GitHubPickerPresentation,
    event: ReactFormEvent<HTMLFormElement>,
  ): GitHubPickerPublication | null => {
    const runtime = publicationRuntimes.get(candidate);
    const activePublication = publicationCoordinator.active();
    const form = runtime?.elements.pathForm;
    const submit = runtime?.elements.pathSubmit;
    const ownerWindow = form?.ownerDocument.defaultView;
    if (
      !runtime ||
      runtime.claimed ||
      !activePublication ||
      activePublication.presentation !== candidate ||
      activePublication.runtime !== runtime ||
      !ownerWindow ||
      !(form instanceof ownerWindow.HTMLFormElement) ||
      !(submit instanceof ownerWindow.HTMLButtonElement) ||
      !exactPickerSubmit(event, form, submit, activePublication) ||
      publicationCoordinator.hasClaimed(event) ||
      publicationCoordinator.hasClaimed(event.nativeEvent)
    ) {
      return null;
    }
    const publication = currentPresentation(candidate);
    if (
      !publication ||
      publication.runtime !== runtime ||
      candidate.mode !== "link" ||
      !candidate.path.trim()
    ) {
      return null;
    }
    runtime.claimed = true;
    publicationCoordinator.claim(event);
    publicationCoordinator.claim(event.nativeEvent);
    return publication;
  };

  const run = (candidate: GitHubPickerPresentation, action: GitHubPickerAction) => {
    const documentId = candidate.documentId;
    if (candidate.mode === "link" && !documentId) {
      setActionError("Something went wrong");
      return;
    }
    const operation = Object.freeze<GitHubPickerOperation>({
      id: ++githubPickerOperationSequence,
      visit: candidate.visit,
      mode: candidate.mode,
      documentId,
      action,
    });
    activeOperationRef.current = operation;
    setBusyOperation(operation);
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
        setBusyOperation((current) => (current === operation ? null : current));
      }
    })();
  };

  const linkGist = (
    candidate: GitHubPickerPresentation,
    gistId?: string,
    filename?: string,
  ) => {
    if (candidate.mode === "import") {
      const payload = Object.freeze({ source: "gist" as const, gistId, filename });
      run(candidate, Object.freeze({ kind: "gist-import" as const, payload }));
      return;
    }
    if (!candidate.document || (!filename && !candidate.gistName.trim())) {
      setActionError("Something went wrong");
      return;
    }
    const payload = Object.freeze({
      storage: "gist" as const,
      gistId,
      filename: filename ?? candidate.gistName,
      isPublic: candidate.gistPublic,
      description: candidate.documentTitle!,
    });
    run(candidate, Object.freeze({ kind: "gist-link" as const, payload }));
  };

  const linkRepo = (candidate: GitHubPickerPresentation, filePath: string) => {
    const destination = candidate.selectedRepo;
    if (!destination || !candidate.branch || !filePath.trim()) {
      setActionError("Something went wrong");
      return;
    }
    if (candidate.mode === "import") {
      const payload = Object.freeze({
        source: "repo" as const,
        owner: destination.owner,
        repo: destination.name,
        branch: candidate.branch,
        path: filePath,
      });
      run(candidate, Object.freeze({ kind: "repo-import" as const, payload }));
      return;
    }
    if (!candidate.document) {
      setActionError("Something went wrong");
      return;
    }
    const payload = Object.freeze({
      storage: "repo" as const,
      owner: destination.owner,
      repo: destination.name,
      branch: candidate.branch,
      path: filePath,
    });
    run(candidate, Object.freeze({ kind: "repo-link" as const, payload }));
  };

  if (!githubAvailable) {
    return <GitHubSignInPrompt githubConfigured={githubConfigured} />;
  }

  return (
    <div
      ref={elementRef(presentation, "root")}
      className="flex flex-col gap-3"
      data-testid="github-picker"
    >
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg border border-line p-0.5">
          {(["gist", "repo"] as Tab[]).map((t) => (
            <button
              key={t}
              ref={elementRef(presentation, t === "gist" ? "tabGist" : "tabRepo")}
              type="button"
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                presentation.tab === t ? "bg-inverse text-white" : "text-ink-2 hover:bg-surface-3",
              )}
              onClick={(event) => {
                if (t === presentation.tab) return;
                const runtime = publicationRuntimes.get(presentation);
                const publication = claimMouse(
                  presentation,
                  event,
                  (runtime?.elements[t === "gist" ? "tabGist" : "tabRepo"] as HTMLButtonElement | null) ?? null,
                );
                if (!publication) return;
                if (presentation.tab === "gist") {
                  presentation.callbacks.invalidateGistLoad();
                } else if (presentation.selectedRepo) {
                  presentation.callbacks.invalidateBranchLoad();
                  presentation.callbacks.invalidateFileLoad();
                } else {
                  presentation.callbacks.invalidateRepoLoad();
                }
                setTab(t);
                setFilter("");
              }}
              disabled={presentation.busy}
              data-testid={`picker-tab-${t}`}
            >
              {t === "gist" ? "Gist" : "Repository"}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
          <input
            ref={elementRef(presentation, "filter")}
            className="input pl-9"
            placeholder={
              presentation.tab === "gist"
                ? "Filter gists"
                : presentation.selectedRepo
                  ? "Filter files"
                  : "Filter repositories"
            }
            value={presentation.filter}
            disabled={presentation.busy}
            onChange={(event) => {
              const nextFilter = event.currentTarget.value;
              if (nextFilter === presentation.filter) return;
              const runtime = publicationRuntimes.get(presentation);
              if (
                !claimChange(
                  presentation,
                  event,
                  (runtime?.elements.filter as HTMLInputElement | null) ?? null,
                  "filter",
                  (control) => control.value === nextFilter,
                )
              ) {
                return;
              }
              setFilter(nextFilter);
            }}
          />
        </div>
      </div>
      {presentation.actionError && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true" data-testid="github-action-error">
          {presentation.actionError}
        </div>
      )}

      {presentation.tab === "gist" && (
        <div className="flex flex-col gap-3">
          {presentation.mode === "link" && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  ref={elementRef(presentation, "newGist")}
                  type="radio"
                  name={presentation.gistChoiceName}
                  checked={presentation.newGist}
                  disabled={presentation.busy}
                  onChange={(event) => {
                    if (presentation.newGist) return;
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimChange(
                        presentation,
                        event,
                        (runtime?.elements.newGist as HTMLInputElement | null) ?? null,
                        "newGist",
                        (control) =>
                          control.checked &&
                          (runtime?.elements.existingGist as HTMLInputElement | null)?.checked === false,
                      )
                    ) {
                      return;
                    }
                    setNewGist(true);
                  }}
                />{" "}
                Create a new gist
              </label>
              {presentation.newGist && (
                <div className="mt-3 flex items-center gap-2 pl-6">
                  <input
                    ref={elementRef(presentation, "gistName")}
                    className="input flex-1"
                    value={presentation.gistName}
                    disabled={presentation.busy}
                    onChange={(event) => {
                      const nextName = event.currentTarget.value;
                      if (nextName === presentation.gistName) return;
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimChange(
                          presentation,
                          event,
                          (runtime?.elements.gistName as HTMLInputElement | null) ?? null,
                          "gistName",
                          (control) => control.value === nextName,
                        )
                      ) {
                        return;
                      }
                      setGistName(nextName);
                    }}
                    placeholder="filename.md"
                    data-testid="gist-filename"
                  />
                  <label className="flex items-center gap-1.5 text-sm text-ink-2">
                    <input
                      ref={elementRef(presentation, "gistPublic")}
                      type="checkbox"
                      checked={presentation.gistPublic}
                      disabled={presentation.busy}
                      onChange={(event) => {
                        const nextPublic = event.currentTarget.checked;
                        if (nextPublic === presentation.gistPublic) return;
                        const runtime = publicationRuntimes.get(presentation);
                        if (
                          !claimChange(
                            presentation,
                            event,
                            (runtime?.elements.gistPublic as HTMLInputElement | null) ?? null,
                            "gistPublic",
                            (control) => control.checked === nextPublic,
                          )
                        ) {
                          return;
                        }
                        setGistPublic(nextPublic);
                      }}
                    />{" "}
                    Public
                  </label>
                  <button
                    ref={elementRef(presentation, "gistCreate")}
                    type="button"
                    className="btn btn-primary"
                    disabled={presentation.busy || !presentation.gistName.trim()}
                    onClick={(event) => {
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimMouse(
                          presentation,
                          event,
                          (runtime?.elements.gistCreate as HTMLButtonElement | null) ?? null,
                        )
                      ) {
                        return;
                      }
                      linkGist(presentation);
                    }}
                    data-testid="gist-create"
                  >
                    {presentation.busy ? <Loader2 size={16} className="animate-spin" /> : "Create & publish"}
                  </button>
                </div>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  ref={elementRef(presentation, "existingGist")}
                  type="radio"
                  name={presentation.gistChoiceName}
                  checked={!presentation.newGist}
                  disabled={presentation.busy}
                  onChange={(event) => {
                    if (!presentation.newGist) return;
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimChange(
                        presentation,
                        event,
                        (runtime?.elements.existingGist as HTMLInputElement | null) ?? null,
                        "newGist",
                        (control) =>
                          control.checked &&
                          (runtime?.elements.newGist as HTMLInputElement | null)?.checked === false,
                      )
                    ) {
                      return;
                    }
                    setNewGist(false);
                  }}
                />{" "}
                Use an existing gist
              </label>
            </div>
          )}
          {(presentation.mode === "import" || !presentation.newGist) && (
            <div
              ref={elementRef(presentation, "gistList")}
              className="scrollbar-thin max-h-72 overflow-y-auto rounded-xl border border-line"
              data-testid="gist-list"
            >
              {presentation.gists.error ? (
                <ListLoadError
                  error={presentation.gists.error}
                  pending={presentation.gists.pending}
                  onRetry={(event) => {
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimMouse(
                        presentation,
                        event,
                        (runtime?.elements.gistRetry as HTMLButtonElement | null) ?? null,
                      )
                    ) {
                      return;
                    }
                    presentation.callbacks.loadGists();
                  }}
                  buttonRef={elementRef(presentation, "gistRetry")}
                  testId="gist-load-error"
                />
              ) : presentation.gists.sourceItems === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : presentation.gistRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown gists found.</div>
              ) : (
                <ul ref={elementRef(presentation, "gistRows")} className="divide-y divide-line">
                  {presentation.gistRows.map((row) => (
                    <li key={row.gist.id + row.file.filename}>
                      <button
                        ref={mappedElementRef(presentation, "gistRows", row)}
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        disabled={presentation.busy}
                        onClick={(event) => {
                          const runtime = publicationRuntimes.get(presentation);
                          if (!claimMouse(presentation, event, runtime?.gistRows.get(row))) return;
                          linkGist(presentation, row.gist.id, row.file.filename);
                        }}
                        data-testid="gist-item"
                      >
                        <FileText size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{row.file.filename}</div>
                          <div className="truncate text-xs text-ink-3">{row.gist.description || row.gist.id}</div>
                        </div>
                        <span className="flex items-center gap-2 text-xs text-ink-4">
                          {!row.gist.public && <Lock size={12} />}
                          {relativeTime(row.gist.updatedAt)}
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

      {presentation.tab === "repo" && (
        <div className="flex flex-col gap-3">
          {!presentation.selectedRepo ? (
            <div
              ref={elementRef(presentation, "repositoryList")}
              className="scrollbar-thin max-h-80 overflow-y-auto rounded-xl border border-line"
              data-testid="repo-list"
            >
              {presentation.repositories.error ? (
                <ListLoadError
                  error={presentation.repositories.error}
                  pending={presentation.repositories.pending}
                  onRetry={(event) => {
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimMouse(
                        presentation,
                        event,
                        (runtime?.elements.repositoryRetry as HTMLButtonElement | null) ?? null,
                      )
                    ) {
                      return;
                    }
                    presentation.callbacks.loadRepos();
                  }}
                  buttonRef={elementRef(presentation, "repositoryRetry")}
                  testId="repo-load-error"
                />
              ) : presentation.repositories.sourceItems === null ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : presentation.repositoryRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-ink-3">No repositories found.</div>
              ) : (
                <ul
                  ref={elementRef(presentation, "repositoryRows")}
                  className="divide-y divide-line"
                >
                  {presentation.repositoryRows.map((row) => (
                    <li key={row.fullName}>
                      <button
                        ref={mappedElementRef(presentation, "repositoryRows", row)}
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
                        onClick={(event) => {
                          const runtime = publicationRuntimes.get(presentation);
                          if (!claimMouse(presentation, event, runtime?.repositoryRows.get(row))) return;
                          presentation.callbacks.resetBranchLoad();
                          presentation.callbacks.resetFileLoad();
                          setRepo(row.value);
                          setBranch(row.defaultBranch);
                        }}
                        disabled={presentation.busy}
                        data-testid="repo-item"
                      >
                        <GitHubIcon size={16} className="shrink-0 text-ink-4" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{row.fullName}</div>
                          {row.description && <div className="truncate text-xs text-ink-3">{row.description}</div>}
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
                  ref={elementRef(presentation, "repositoryBack")}
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={(event) => {
                    const runtime = publicationRuntimes.get(presentation);
                    if (
                      !claimMouse(
                        presentation,
                        event,
                        (runtime?.elements.repositoryBack as HTMLButtonElement | null) ?? null,
                      )
                    ) {
                      return;
                    }
                    presentation.callbacks.resetBranchLoad();
                    presentation.callbacks.resetFileLoad();
                    setRepo(null);
                    setBranch("");
                  }}
                  disabled={presentation.busy}
                >
                  ← Repositories
                </button>
                <span className="font-medium text-ink">{presentation.selectedRepo.fullName}</span>
                <div
                  ref={elementRef(presentation, "branchList")}
                  className="ml-auto inline-flex items-center gap-1.5 text-ink-3"
                  data-testid="branch-list"
                >
                  <GitBranch size={14} />
                  {presentation.branches.error ? (
                    <ListLoadError
                      error={presentation.branches.error}
                      pending={presentation.branches.pending}
                      onRetry={(event) => {
                        const runtime = publicationRuntimes.get(presentation);
                        if (
                          !claimMouse(
                            presentation,
                            event,
                            (runtime?.elements.branchRetry as HTMLButtonElement | null) ?? null,
                          )
                        ) {
                          return;
                        }
                        presentation.callbacks.loadBranches();
                      }}
                      buttonRef={elementRef(presentation, "branchRetry")}
                      testId="branch-load-error"
                    />
                  ) : presentation.branches.sourceItems === null ? (
                    <Spinner />
                  ) : presentation.branches.items.length === 0 ? (
                    <span data-testid="branch-empty">No branches found.</span>
                  ) : (
                    <select
                      ref={elementRef(presentation, "branchSelect")}
                      className="select h-8 text-xs"
                      value={presentation.branch}
                      onChange={(event) => {
                        const option = presentation.branches.items[event.currentTarget.selectedIndex];
                        if (!option || option.value === presentation.branch) return;
                        const runtime = publicationRuntimes.get(presentation);
                        if (
                          !claimChange(
                            presentation,
                            event,
                            (runtime?.elements.branchSelect as HTMLSelectElement | null) ?? null,
                            "branch",
                            (control) =>
                              control.value === option.value &&
                              control.options.item(option.index) === runtime?.branchOptions.get(option),
                          )
                        ) {
                          return;
                        }
                        presentation.callbacks.resetFileLoad();
                        setBranch(option.value);
                      }}
                      disabled={presentation.busy}
                      data-testid="branch-select"
                    >
                      {presentation.branches.items.map((item) => (
                        <option
                          ref={mappedElementRef(presentation, "branchOptions", item)}
                          key={`${item.value}:${item.index}`}
                          value={item.value}
                        >
                          {item.value}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {presentation.mode === "link" && (
                <form
                  ref={elementRef(presentation, "pathForm")}
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!claimSubmit(presentation, event)) return;
                    linkRepo(presentation, presentation.path.trim());
                  }}
                >
                  <input
                    ref={elementRef(presentation, "path")}
                    className="input flex-1 font-mono text-[13px]"
                    placeholder="docs/new-file.md (new or existing path)"
                    value={presentation.path}
                    disabled={presentation.busy}
                    onChange={(event) => {
                      const nextPath = event.currentTarget.value;
                      if (nextPath === presentation.path) return;
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimChange(
                          presentation,
                          event,
                          (runtime?.elements.path as HTMLInputElement | null) ?? null,
                          "path",
                          (control) => control.value === nextPath,
                        )
                      ) {
                        return;
                      }
                      setPath(nextPath);
                    }}
                    data-testid="repo-path"
                  />
                  <button
                    ref={elementRef(presentation, "pathSubmit")}
                    type="submit"
                    className="btn btn-primary"
                    disabled={presentation.busy || !presentation.path.trim()}
                    data-testid="repo-link"
                  >
                    {presentation.busy ? <Loader2 size={16} className="animate-spin" /> : "Connect"}
                  </button>
                </form>
              )}
              <div
                ref={elementRef(presentation, "fileList")}
                className="scrollbar-thin max-h-64 overflow-y-auto rounded-xl border border-line"
                data-testid="file-list"
              >
                {presentation.files.error ? (
                  <ListLoadError
                    error={presentation.files.error}
                    pending={presentation.files.pending}
                    onRetry={(event) => {
                      const runtime = publicationRuntimes.get(presentation);
                      if (
                        !claimMouse(
                          presentation,
                          event,
                          (runtime?.elements.fileRetry as HTMLButtonElement | null) ?? null,
                        )
                      ) {
                        return;
                      }
                      presentation.callbacks.loadFiles();
                    }}
                    buttonRef={elementRef(presentation, "fileRetry")}
                    testId="file-load-error"
                  />
                ) : presentation.files.sourceItems === null ? (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                ) : presentation.fileRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-ink-3">No Markdown files on this branch.</div>
                ) : (
                  <ul ref={elementRef(presentation, "fileRows")} className="divide-y divide-line">
                    {presentation.fileRows.map((row) => (
                      <li key={row.path}>
                        <button
                          ref={mappedElementRef(presentation, "fileRows", row)}
                          type="button"
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                          disabled={presentation.busy}
                          onClick={(event) => {
                            if (presentation.mode === "link" && presentation.path === row.path) return;
                            const runtime = publicationRuntimes.get(presentation);
                            if (!claimMouse(presentation, event, runtime?.fileRows.get(row))) return;
                            if (presentation.mode === "link") setPath(row.path);
                            else linkRepo(presentation, row.path);
                          }}
                          data-testid="repo-file"
                        >
                          <FileText size={15} className="shrink-0 text-ink-4" />
                          <span className="truncate font-mono text-[13px] text-ink-2">{row.path}</span>
                          {presentation.mode === "import" && <span className="ml-auto text-xs text-accent">Open</span>}
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

type CommitPrimitive = string | number | boolean | null | undefined;
type CommitRetirement = "element" | "layout" | "ordinary";
type CommitChangingControl = "message" | null;

const COMMIT_FORM_CLASS = "flex flex-col gap-3";
const COMMIT_LABEL_CLASS = "text-sm font-medium text-ink-2";
const COMMIT_STATIC_CLASS = "text-xs text-ink-3";
const COMMIT_ERROR_CLASS = "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40";
const COMMIT_ACTIONS_CLASS = "flex justify-end gap-2";
const COMMIT_CANCEL_CLASS = "btn btn-ghost";
const COMMIT_SUBMIT_CLASS = "btn btn-primary gap-2";
const COMMIT_POINTER_DOWN_OUTSIDE = "dismissableLayer.pointerDownOutside";
const COMMIT_RADIX_ATTRIBUTES = new Set(["aria-describedby", "aria-labelledby", "style"]);
const COMMIT_OVERLAY_ATTRIBUTES = new Set(["aria-hidden", "data-aria-hidden", "style"]);

interface CommitDocumentFacts {
  readonly source: DocumentDto;
  readonly values: readonly (readonly [string, CommitPrimitive])[];
}

interface CommitDialogVisit {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly doc: DocumentDto;
  readonly documentFacts: CommitDocumentFacts;
  readonly destination: string;
  readonly open: true;
  readonly onCommit: (message: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
  readonly isOwner: boolean;
  readonly initialMessage: string;
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly gistControlPresent: boolean;
}

interface CommitDialogOperation {
  readonly identity: symbol;
  readonly visit: CommitDialogVisit;
  readonly currentVisit: CommitCurrentValue<CommitDialogVisit>;
  readonly origin: CommitDialogPublication;
  readonly message: string;
  readonly commit: (message: string) => Promise<void>;
}

interface CommitDialogTimerOwner {
  readonly identity: symbol;
  readonly visit: CommitDialogVisit;
  readonly currentVisit: CommitCurrentValue<CommitDialogVisit>;
  readonly operation: CommitDialogOperation;
  readonly onOpenChange: (open: boolean) => void;
  handle: ReturnType<typeof setTimeout> | undefined;
}

interface CommitDialogOperationHandoff {
  readonly previous: CommitDialogVisit;
  readonly current: CommitDialogVisit;
  readonly operation: CommitDialogOperation;
  readonly timer: CommitDialogTimerOwner | null;
}

interface CommitDialogState {
  readonly visit: CommitDialogVisit;
  readonly message: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly done: boolean;
  readonly operation: CommitDialogOperation | null;
  readonly closeTimer: CommitDialogTimerOwner | null;
}

interface CommitDialogAuthority {
  readonly visit: CommitDialogVisit;
  readonly revision: number;
  readonly state: CommitDialogState;
  readonly message: string;
  readonly trimmedMessage: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly done: boolean;
  readonly operation: CommitDialogOperation | null;
  readonly closeTimer: CommitDialogTimerOwner | null;
  readonly submitDisabled: boolean;
  readonly submitText: "Commit" | "Update gist" | "Published";
  readonly submitIcon: "busy" | "done" | null;
}

interface CommitDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly CommitDomSnapshot[];
  readonly opaque: boolean;
}

interface CommitAncestorPlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface CommitNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly ancestors: readonly CommitAncestorPlacement[];
}

interface CommitPlacement {
  readonly document: Document;
  readonly bridge: CommitNodePlacement;
  readonly overlay: CommitNodePlacement;
  readonly content: CommitNodePlacement;
}

interface CommitElementOwnerView {
  readonly element: () => Element | null;
}

interface CommitRefReplay {
  readonly owner: CommitElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface CommitDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface CommitEventSuppressionAuthority {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly EventConstructor: typeof Event;
  readonly CustomEventConstructor: typeof CustomEvent;
  readonly eventPrototype: Event;
  readonly reflectObject: typeof Reflect;
  readonly objectConstructor: ObjectConstructor;
  readonly apply: typeof Reflect.apply;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly preventDefault: Event["preventDefault"];
  readonly stopPropagation: Event["stopPropagation"];
  readonly defaultPrevented: () => boolean;
  readonly cancelBubble: () => boolean;
  readonly descriptors: Readonly<{
    eventConstructor: PropertyDescriptor;
    customEventConstructor: PropertyDescriptor;
    eventPrototype: PropertyDescriptor;
    reflectApply: PropertyDescriptor;
    objectGetOwnPropertyDescriptor: PropertyDescriptor;
    preventDefault: PropertyDescriptor;
    stopPropagation: PropertyDescriptor;
    defaultPrevented: PropertyDescriptor;
    cancelBubble: PropertyDescriptor;
  }>;
}

interface CommitDialogPublication {
  readonly identity: symbol;
  readonly presentation: CommitDialogRender;
  readonly authority: CommitDialogAuthority;
  readonly ownerDocument: Document;
  readonly eventSuppression: CommitEventSuppressionAuthority;
  readonly bridge: HTMLDivElement;
  readonly overlay: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly gistSlot: HTMLDivElement;
  readonly placement: CommitPlacement;
  readonly bridgeDom: CommitDomSnapshot;
  readonly overlayDom: CommitDomSnapshot;
  readonly contentDom: CommitDomSnapshot;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
}

interface CommitPublicationReplay {
  readonly source: CommitDialogPublication;
  readonly bridgeDom: CommitDomSnapshot;
  readonly overlayDom: CommitDomSnapshot;
  readonly contentDom: CommitDomSnapshot;
  readonly placement: CommitPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface CommitPublicationRuntime {
  readonly publication: CommitDialogPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireOrdinary: () => void;
  readonly noteRef: (
    owner: CommitElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly replay: () => CommitPublicationReplay | null;
}

interface CommitDialogRender {
  readonly authority: CommitDialogAuthority;
  readonly captureBridge: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureGistSlot: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureForm: (element: HTMLFormElement | null) => void | (() => void);
  readonly captureLabel: (element: HTMLLabelElement | null) => void | (() => void);
  readonly captureMessage: (element: HTMLInputElement | null) => void | (() => void);
  readonly captureStatic: (element: HTMLParagraphElement | null) => void | (() => void);
  readonly captureError: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureCancel: (element: HTMLButtonElement | null) => void | (() => void);
  readonly captureSubmit: (element: HTMLButtonElement | null) => void | (() => void);
  readonly establish: () => void | (() => void);
  readonly owns: (publication: CommitDialogPublication, changing?: CommitChangingControl) => boolean;
  readonly onBridgeChangeCapture: (event: ReactChangeEvent<HTMLDivElement>) => void;
  readonly onBridgeChange: (event: ReactChangeEvent<HTMLDivElement>) => void;
  readonly onBridgeClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onBridgeClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onBridgeKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onBridgeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onBridgeSubmitCapture: (event: ReactFormEvent<HTMLDivElement>) => void;
  readonly onBridgeSubmit: (event: ReactFormEvent<HTMLDivElement>) => void;
  readonly onMessageChange: (event: ReactChangeEvent<HTMLInputElement>) => void;
  readonly onMessageKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onCancel: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onSubmitClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly authorizeNativeDismissal: (publication: CommitDialogPublication, event: Event) => void;
  readonly authorizePointerDownOutside: (
    publication: CommitDialogPublication,
    event: Event,
  ) => void;
  readonly authorizeNativeDelivery: (publication: CommitDialogPublication, event: Event) => void;
}

class CommitCurrentValue<T> {
  constructor(private value: T) {}

  get() {
    return this.value;
  }

  set(value: T) {
    this.value = value;
  }
}

class CommitElementOwner<T extends Element> implements CommitElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;
  private binding: object | null = null;

  constructor(
    private readonly onChange: (
      owner: CommitElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.current;

  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    const last = this.last;
    const binding = element ? Object.freeze({}) : null;
    this.current = element;
    this.binding = binding;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
    if (!element || !binding) return;
    return () => {
      if (this.current !== element || this.binding !== binding) return;
      const detachedLast = this.last;
      this.current = null;
      this.binding = null;
      this.onChange(this, null, element, detachedLast);
    };
  };
}

function commitDescriptor(
  authority: Pick<
    CommitEventSuppressionAuthority,
    "apply" | "getOwnPropertyDescriptor" | "objectConstructor"
  >,
  target: object,
  property: PropertyKey,
) {
  return authority.apply(
    authority.getOwnPropertyDescriptor,
    authority.objectConstructor,
    [target, property],
  );
}

function freezeCommitDescriptor(descriptor: PropertyDescriptor) {
  return Object.freeze({ ...descriptor });
}

function commitDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.writable === expected.writable &&
      current.value === expected.value &&
      current.get === expected.get &&
      current.set === expected.set,
  );
}

function captureCommitEventSuppressionAuthority(
  ownerDocument: Document,
): CommitEventSuppressionAuthority | null {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const EventConstructor = ownerWindow.Event;
  const CustomEventConstructor = ownerWindow.CustomEvent;
  const eventPrototype = EventConstructor.prototype;
  const reflectObject = ownerWindow.Reflect;
  const objectConstructor = ownerWindow.Object;
  const apply = reflectObject.apply;
  const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
  if (
    typeof apply !== "function" ||
    typeof getOwnPropertyDescriptor !== "function"
  ) {
    return null;
  }
  const descriptorAuthority = {
    apply,
    getOwnPropertyDescriptor,
    objectConstructor,
  };
  const eventConstructorDescriptor = commitDescriptor(
    descriptorAuthority,
    ownerWindow,
    "Event",
  );
  const customEventConstructorDescriptor = commitDescriptor(
    descriptorAuthority,
    ownerWindow,
    "CustomEvent",
  );
  const eventPrototypeDescriptor = commitDescriptor(
    descriptorAuthority,
    EventConstructor,
    "prototype",
  );
  const reflectApplyDescriptor = commitDescriptor(
    descriptorAuthority,
    reflectObject,
    "apply",
  );
  const objectGetOwnPropertyDescriptor = commitDescriptor(
    descriptorAuthority,
    objectConstructor,
    "getOwnPropertyDescriptor",
  );
  const preventDefaultDescriptor = commitDescriptor(
    descriptorAuthority,
    eventPrototype,
    "preventDefault",
  );
  const stopPropagationDescriptor = commitDescriptor(
    descriptorAuthority,
    eventPrototype,
    "stopPropagation",
  );
  const defaultPreventedDescriptor = commitDescriptor(
    descriptorAuthority,
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubbleDescriptor = commitDescriptor(
    descriptorAuthority,
    eventPrototype,
    "cancelBubble",
  );
  if (
    !eventConstructorDescriptor ||
    !customEventConstructorDescriptor ||
    eventPrototypeDescriptor?.value !== eventPrototype ||
    reflectApplyDescriptor?.value !== apply ||
    objectGetOwnPropertyDescriptor?.value !== getOwnPropertyDescriptor ||
    typeof preventDefaultDescriptor?.value !== "function" ||
    typeof stopPropagationDescriptor?.value !== "function" ||
    typeof defaultPreventedDescriptor?.get !== "function" ||
    typeof cancelBubbleDescriptor?.get !== "function"
  ) {
    return null;
  }
  return Object.freeze({
    ownerDocument,
    ownerWindow,
    EventConstructor,
    CustomEventConstructor,
    eventPrototype,
    reflectObject,
    objectConstructor,
    apply,
    getOwnPropertyDescriptor,
    preventDefault: preventDefaultDescriptor.value as Event["preventDefault"],
    stopPropagation: stopPropagationDescriptor.value as Event["stopPropagation"],
    defaultPrevented: defaultPreventedDescriptor.get as () => boolean,
    cancelBubble: cancelBubbleDescriptor.get as () => boolean,
    descriptors: Object.freeze({
      eventConstructor: freezeCommitDescriptor(eventConstructorDescriptor),
      customEventConstructor: freezeCommitDescriptor(
        customEventConstructorDescriptor,
      ),
      eventPrototype: freezeCommitDescriptor(eventPrototypeDescriptor),
      reflectApply: freezeCommitDescriptor(reflectApplyDescriptor),
      objectGetOwnPropertyDescriptor: freezeCommitDescriptor(
        objectGetOwnPropertyDescriptor,
      ),
      preventDefault: freezeCommitDescriptor(preventDefaultDescriptor),
      stopPropagation: freezeCommitDescriptor(stopPropagationDescriptor),
      defaultPrevented: freezeCommitDescriptor(defaultPreventedDescriptor),
      cancelBubble: freezeCommitDescriptor(cancelBubbleDescriptor),
    }),
  });
}

function commitEventSuppressionAuthorityMatches(
  authority: CommitEventSuppressionAuthority,
) {
  const descriptors = authority.descriptors;
  return (
    authority.ownerDocument.defaultView === authority.ownerWindow &&
    commitDescriptorsMatch(
      commitDescriptor(authority, authority.ownerWindow, "Event"),
      descriptors.eventConstructor,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(authority, authority.ownerWindow, "CustomEvent"),
      descriptors.customEventConstructor,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(authority, authority.EventConstructor, "prototype"),
      descriptors.eventPrototype,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(authority, authority.reflectObject, "apply"),
      descriptors.reflectApply,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(
        authority,
        authority.objectConstructor,
        "getOwnPropertyDescriptor",
      ),
      descriptors.objectGetOwnPropertyDescriptor,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(
        authority,
        authority.eventPrototype,
        "preventDefault",
      ),
      descriptors.preventDefault,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(
        authority,
        authority.eventPrototype,
        "stopPropagation",
      ),
      descriptors.stopPropagation,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(
        authority,
        authority.eventPrototype,
        "defaultPrevented",
      ),
      descriptors.defaultPrevented,
    ) &&
    commitDescriptorsMatch(
      commitDescriptor(authority, authority.eventPrototype, "cancelBubble"),
      descriptors.cancelBubble,
    )
  );
}

function suppressCommitPointerDownOutside(
  authority: CommitEventSuppressionAuthority,
  event: Event,
) {
  let preventDefaultApplied = false;
  let stopPropagationApplied = false;
  try {
    authority.apply(authority.preventDefault, event, []);
    preventDefaultApplied = true;
  } catch {
    preventDefaultApplied = false;
  }
  try {
    authority.apply(authority.stopPropagation, event, []);
    stopPropagationApplied = true;
  } catch {
    stopPropagationApplied = false;
  }
  if (!preventDefaultApplied || !stopPropagationApplied) return false;
  try {
    return (
      authority.apply(authority.defaultPrevented, event, []) === true &&
      authority.apply(authority.cancelBubble, event, []) === true
    );
  } catch {
    return false;
  }
}

class CommitPublicationCoordinator {
  private activePublication: CommitDialogPublication | null = null;
  private successor: CommitDialogPublication | null = null;
  private replayValue: CommitPublicationReplay | null = null;
  private eventSuppressionAuthority: CommitEventSuppressionAuthority | null =
    null;
  private readonly retired = new WeakSet<CommitDialogPublication>();
  private readonly terminalPublications = new WeakSet<CommitDialogPublication>();
  private readonly actions = new WeakSet<object>();
  private readonly events = new WeakSet<object>();
  private readonly deliveredReactEvents = new WeakSet<object>();
  private readonly deliveredNativeEvents = new WeakSet<Event>();
  private readonly rejectedOutsidePointerDowns = new WeakSet<Event>();
  private readonly preparedSubmits = new WeakSet<Event>();
  private readonly forms = new WeakSet<HTMLFormElement>();
  private readonly operations = new WeakSet<CommitDialogOperation>();
  private readonly timers = new WeakSet<CommitDialogTimerOwner>();
  private readonly firedTimers = new WeakSet<CommitDialogTimerOwner>();

  constructor(private readonly mount: symbol) {}

  active() {
    return this.activePublication;
  }

  replay() {
    return this.replayValue;
  }

  prepareEventSuppression(ownerDocument: Document) {
    if (this.eventSuppressionAuthority?.ownerDocument === ownerDocument) {
      return this.eventSuppressionAuthority;
    }
    this.eventSuppressionAuthority =
      captureCommitEventSuppressionAuthority(ownerDocument);
    return this.eventSuppressionAuthority;
  }

  eventSuppression(ownerDocument: Document) {
    return this.eventSuppressionAuthority?.ownerDocument === ownerDocument
      ? this.eventSuppressionAuthority
      : null;
  }

  publish(publication: CommitDialogPublication) {
    if (publication.authority.visit.mount !== this.mount || this.retired.has(publication)) return false;
    const previous = this.activePublication;
    if (previous && previous !== publication) previous.retire();
    this.activePublication = publication;
    this.successor = null;
    this.replayValue = null;
    return true;
  }

  retire(publication: CommitDialogPublication) {
    if (this.retired.has(publication)) return false;
    this.retired.add(publication);
    if (this.activePublication === publication) {
      this.activePublication = null;
      this.successor = publication;
    }
    return true;
  }

  isCurrent(publication: CommitDialogPublication) {
    return this.activePublication === publication && !this.retired.has(publication);
  }

  acceptsSuccessorOf(publication: CommitDialogPublication) {
    return (
      this.activePublication === null &&
      this.successor === publication &&
      this.retired.has(publication) &&
      !this.terminalPublications.has(publication)
    );
  }

  stageReplay(replay: CommitPublicationReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.replayValue = replay;
    return true;
  }

  abandonReplay(publication: CommitDialogPublication) {
    if (this.replayValue?.source === publication) this.replayValue = null;
    if (this.successor === publication) this.successor = null;
  }

  registerForm(form: HTMLFormElement) {
    this.forms.add(form);
  }

  ownsForm(form: HTMLFormElement) {
    return this.forms.has(form);
  }

  noteNativeEvent(event: Event) {
    this.deliveredNativeEvents.add(event);
  }

  nativeEventWasDelivered(event: Event) {
    return this.deliveredNativeEvents.has(event);
  }

  rejectOutsidePointerDown(event: Event) {
    this.rejectedOutsidePointerDowns.add(event);
  }

  outsidePointerDownWasRejected(event: Event) {
    return this.rejectedOutsidePointerDowns.has(event);
  }

  noteReactEvent(event: object) {
    this.deliveredReactEvents.add(event);
  }

  prepareSubmit(event: Event) {
    this.preparedSubmits.add(event);
  }

  submitIsPrepared(event: Event) {
    return this.preparedSubmits.has(event);
  }

  claimEvent(publication: CommitDialogPublication, action: object, event: object, nativeEvent: object) {
    if (
      !this.isCurrent(publication) ||
      this.actions.has(action) ||
      this.events.has(event) ||
      this.events.has(nativeEvent)
    ) {
      return false;
    }
    this.actions.add(action);
    this.events.add(event);
    this.events.add(nativeEvent);
    return true;
  }

  claimReactEvent(
    publication: CommitDialogPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    return (
      this.deliveredReactEvents.has(event) &&
      this.deliveredNativeEvents.has(nativeEvent) &&
      this.claimEvent(publication, action, event, nativeEvent)
    );
  }

  claimTerminal(publication: CommitDialogPublication, action: object, event: object, nativeEvent: object) {
    if (this.terminalPublications.has(publication) || !this.claimEvent(publication, action, event, nativeEvent)) {
      return false;
    }
    this.terminalPublications.add(publication);
    return true;
  }

  claimTerminalReact(
    publication: CommitDialogPublication,
    action: object,
    event: object,
    nativeEvent: Event,
  ) {
    if (
      this.terminalPublications.has(publication) ||
      !this.claimReactEvent(publication, action, event, nativeEvent)
    ) {
      return false;
    }
    this.terminalPublications.add(publication);
    return true;
  }

  claimTerminalSequence(
    publication: CommitDialogPublication,
    action: object,
    events: readonly Event[],
    kind: "instant" | "outside-pointer",
  ) {
    const exactSequence =
      kind === "instant"
        ? events.length === 1
        : events.length === 4 &&
          events[0]?.type === "pointerdown" &&
          events[1]?.type === "pointerup" &&
          events[2]?.type === "click" &&
          events[3]?.type === COMMIT_POINTER_DOWN_OUTSIDE;
    if (
      !exactSequence ||
      this.terminalPublications.has(publication) ||
      !this.isCurrent(publication) ||
      this.actions.has(action) ||
      events.some(
        (event) =>
          !this.deliveredNativeEvents.has(event) || this.events.has(event),
      )
    ) {
      return false;
    }
    this.terminalPublications.add(publication);
    this.actions.add(action);
    events.forEach((event) => this.events.add(event));
    return true;
  }

  claimOperation(operation: CommitDialogOperation) {
    if (this.operations.has(operation)) return false;
    this.operations.add(operation);
    return true;
  }

  claimTimer(timer: CommitDialogTimerOwner) {
    if (this.timers.has(timer)) return false;
    this.timers.add(timer);
    return true;
  }

  claimTimerClose(
    publication: CommitDialogPublication,
    action: object,
    operation: CommitDialogOperation,
    timer: CommitDialogTimerOwner,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.terminalPublications.has(publication) ||
      this.actions.has(action) ||
      !this.operations.has(operation) ||
      !this.timers.has(timer) ||
      this.firedTimers.has(timer)
    ) {
      return false;
    }
    this.terminalPublications.add(publication);
    this.actions.add(action);
    this.firedTimers.add(timer);
    return true;
  }
}

class CommitPresentationCache {
  private current: {
    readonly authority: CommitDialogAuthority;
    readonly render: CommitDialogRender;
  } | null = null;

  resolve(authority: CommitDialogAuthority, create: () => CommitDialogRender) {
    if (!this.current || !commitAuthoritiesMatch(this.current.authority, authority)) {
      this.current = Object.freeze({ authority, render: create() });
    }
    return this.current.render;
  }
}

function commitDocumentFacts(doc: DocumentDto): CommitDocumentFacts {
  const values = Object.entries(doc)
    .filter((entry) => {
      const value: unknown = entry[1];
      return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
    })
    .sort(([left], [right]) => left.localeCompare(right))
    .map((entry) => Object.freeze(entry as readonly [string, CommitPrimitive]));
  return Object.freeze({ source: doc, values: Object.freeze(values) });
}

function commitDocumentFactsMatch(facts: CommitDocumentFacts) {
  const current = commitDocumentFacts(facts.source);
  return (
    current.values.length === facts.values.length &&
    current.values.every(([name, value], index) => {
      const expected = facts.values[index];
      return expected?.[0] === name && Object.is(expected[1], value);
    })
  );
}

function commitDocumentFactsAllowOperationHandoff(
  previous: CommitDocumentFacts,
  current: CommitDocumentFacts,
) {
  if (
    previous.source === current.source ||
    previous.values.length !== current.values.length ||
    !commitDocumentFactsMatch(previous) ||
    !commitDocumentFactsMatch(current)
  ) {
    return false;
  }
  let unpublishedTransition = false;
  let publicationClockChange = false;
  let valueChanged = false;
  const exactResultShape = current.values.every(([name, value], index) => {
    const prior = previous.values[index];
    if (!prior || prior[0] !== name) return false;
    if (Object.is(prior[1], value)) return true;
    valueChanged = true;
    if (name === "hasUnpublishedChanges") {
      unpublishedTransition = prior[1] === true && value === false;
      return unpublishedTransition;
    }
    if (name === "publishedAt" || name === "updatedAt") {
      publicationClockChange = true;
      return true;
    }
    return false;
  });
  return (
    exactResultShape &&
    (!valueChanged || (unpublishedTransition && publicationClockChange))
  );
}

function commitVisitsAllowMetadataHandoff(
  previous: CommitDialogVisit,
  current: CommitDialogVisit,
) {
  return (
    previous !== current &&
    previous.mount === current.mount &&
    previous.destination === current.destination &&
    previous.open === current.open &&
    previous.onCommit === current.onCommit &&
    previous.onOpenChange === current.onOpenChange &&
    previous.isOwner === current.isOwner &&
    previous.initialMessage === current.initialMessage &&
    previous.title === current.title &&
    previous.description === current.description &&
    previous.label === current.label &&
    previous.gistControlPresent === current.gistControlPresent &&
    commitVisitFactsMatch(previous) &&
    commitVisitFactsMatch(current)
  );
}

function commitGistFirstPublicationAllowsVisitHandoff(
  previous: CommitDialogVisit,
  current: CommitDialogVisit,
) {
  const previousDoc = previous.doc;
  const currentDoc = current.doc;
  return (
    previousDoc.storage === "gist" &&
    currentDoc.storage === "gist" &&
    previous.isOwner &&
    current.isOwner &&
    previous.destination !== current.destination &&
    previousDoc.id === currentDoc.id &&
    Boolean(previousDoc.gistId) &&
    previousDoc.gistId === currentDoc.gistId &&
    Boolean(previousDoc.gistFile) &&
    previousDoc.gistFile === currentDoc.gistFile &&
    Boolean(previousDoc.githubUrl) &&
    previousDoc.githubUrl === currentDoc.githubUrl &&
    previousDoc.ownerId === currentDoc.ownerId &&
    previousDoc.publishedAt === null &&
    typeof currentDoc.publishedAt === "string" &&
    currentDoc.publishedAt.length > 0 &&
    !previous.gistControlPresent &&
    current.gistControlPresent
  );
}

function commitOperationAllowsVisitHandoff(
  operation: CommitDialogOperation,
  previous: CommitDialogVisit,
  current: CommitDialogVisit,
) {
  const presentationIsCompatible =
    (previous.destination === current.destination &&
      previous.gistControlPresent === current.gistControlPresent) ||
    commitGistFirstPublicationAllowsVisitHandoff(previous, current);
  return (
    operation.currentVisit.get() === previous &&
    operation.visit === previous &&
    previous.mount === current.mount &&
    presentationIsCompatible &&
    previous.open === current.open &&
    previous.onCommit === current.onCommit &&
    previous.onOpenChange === current.onOpenChange &&
    previous.isOwner === current.isOwner &&
    previous.initialMessage === current.initialMessage &&
    previous.title === current.title &&
    previous.description === current.description &&
    previous.label === current.label &&
    operation.commit === current.onCommit &&
    commitDocumentFactsAllowOperationHandoff(
      previous.documentFacts,
      current.documentFacts,
    )
  );
}

function commitDocumentKey(facts: CommitDocumentFacts) {
  return JSON.stringify(facts.values);
}

function initialCommitDialogState(visit: CommitDialogVisit): CommitDialogState {
  return Object.freeze({
    visit,
    message: visit.initialMessage,
    busy: false,
    error: null,
    done: false,
    operation: null,
    closeTimer: null,
  });
}

function commitState(
  state: CommitDialogState,
  change: Partial<Omit<CommitDialogState, "visit">>,
): CommitDialogState {
  return Object.freeze({ ...state, ...change });
}

function commitAuthoritiesMatch(
  previous: CommitDialogAuthority,
  current: CommitDialogAuthority,
  includeRevision = true,
) {
  return (
    previous.visit === current.visit &&
    (!includeRevision || previous.revision === current.revision) &&
    previous.state === current.state &&
    previous.message === current.message &&
    previous.trimmedMessage === current.trimmedMessage &&
    previous.busy === current.busy &&
    previous.error === current.error &&
    previous.done === current.done &&
    previous.operation === current.operation &&
    previous.closeTimer === current.closeTimer &&
    previous.submitDisabled === current.submitDisabled &&
    previous.submitText === current.submitText &&
    previous.submitIcon === current.submitIcon
  );
}

function commitVisitFactsMatch(visit: CommitDialogVisit) {
  const doc = visit.doc;
  return (
    commitDocumentFactsMatch(visit.documentFacts) &&
    visit.destination ===
      JSON.stringify([
        doc.id,
        doc.storage,
        doc.repoOwner,
        doc.repoName,
        doc.repoBranch,
        doc.repoPath,
        doc.gistId,
        doc.gistFile,
        doc.githubUrl,
        doc.ownerId,
        doc.storage === "gist" ? Boolean(doc.publishedAt) : null,
      ]) &&
    visit.initialMessage === `Update ${doc.repoPath ?? doc.gistFile ?? "document"}` &&
    visit.title === (doc.storage === "gist" ? "Update gist" : "Commit to GitHub") &&
    visit.description ===
      (doc.storage === "gist"
        ? "Publishes the current text to the gist."
        : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`) &&
    visit.label === (doc.storage === "gist" ? "Description" : "Commit message") &&
    visit.gistControlPresent ===
      Boolean(
        visit.isOwner &&
          doc.storage === "gist" &&
          doc.gistId &&
          doc.gistFile &&
          doc.githubUrl &&
          doc.publishedAt,
      )
  );
}

function commitAuthorityFactsMatch(
  authority: CommitDialogAuthority,
  latestAuthority: CommitCurrentValue<CommitDialogAuthority | null>,
  currentVisit: CommitCurrentValue<CommitDialogVisit | null>,
  activeOperation: CommitCurrentValue<CommitDialogOperation | null>,
  activeTimer: CommitCurrentValue<CommitDialogTimerOwner | null>,
  closedVisits: WeakSet<CommitDialogVisit>,
) {
  const state = authority.state;
  const operation = authority.operation;
  const timer = authority.closeTimer;
  return (
    latestAuthority.get() === authority &&
    currentVisit.get() === authority.visit &&
    !closedVisits.has(authority.visit) &&
    state.visit === authority.visit &&
    state.message === authority.message &&
    state.message.trim() === authority.trimmedMessage &&
    state.busy === authority.busy &&
    state.error === authority.error &&
    state.done === authority.done &&
    state.operation === operation &&
    state.closeTimer === timer &&
    authority.submitDisabled === (authority.busy || authority.done) &&
    authority.submitText ===
      (authority.done
        ? "Published"
        : authority.visit.doc.storage === "gist"
          ? "Update gist"
          : "Commit") &&
    authority.submitIcon === (authority.done ? "done" : authority.busy ? "busy" : null) &&
    commitVisitFactsMatch(authority.visit) &&
    (operation === null ||
      (activeOperation.get() === operation &&
        operation.currentVisit.get() === authority.visit &&
        commitVisitFactsMatch(operation.visit) &&
        operation.commit === authority.visit.onCommit &&
        operation.message === operation.message.trim())) &&
    (timer === null ||
      (activeTimer.get() === timer &&
        operation === timer.operation &&
        timer.currentVisit.get() === authority.visit &&
        commitVisitFactsMatch(timer.visit) &&
        timer.onOpenChange === authority.visit.onOpenChange))
  );
}

function commitSnapshotAttributes(
  node: Node,
  content: HTMLDivElement,
  overlay: HTMLDivElement,
) {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const controlledMessage =
    element.tagName === "INPUT" &&
    (element as HTMLElement).dataset.testid === "commit-message";
  return Object.freeze(
    [...element.attributes]
      .filter(
        ({ name }) =>
          !(element === content && COMMIT_RADIX_ATTRIBUTES.has(name)) &&
          !(element === overlay && COMMIT_OVERLAY_ATTRIBUTES.has(name)) &&
          !(controlledMessage && (name === "name" || name === "value")),
      )
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function commitSnapshotDom(
  node: Node,
  content: HTMLDivElement,
  overlay: HTMLDivElement,
  gistSlot: HTMLDivElement,
  opaque = false,
): CommitDomSnapshot {
  const gistChild = node.parentNode === gistSlot;
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: commitSnapshotAttributes(node, content, overlay),
    children: Object.freeze(
      opaque || gistChild
        ? []
        : [...node.childNodes].map((child) =>
            commitSnapshotDom(child, content, overlay, gistSlot, child.parentNode === gistSlot),
          ),
    ),
    opaque: opaque || gistChild,
  });
}

function commitDomMatches(
  snapshot: CommitDomSnapshot,
  ownerDocument: Document,
  content: HTMLDivElement,
  overlay: HTMLDivElement,
): boolean {
  const node = snapshot.node;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue
  ) {
    return false;
  }
  const attributes = commitSnapshotAttributes(node, content, overlay);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  if (snapshot.opaque) return true;
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        commitDomMatches(child, ownerDocument, content, overlay),
    )
  );
}

function isCommitRadixFocusGuard(node: Node | null) {
  if (!node || node.nodeType !== 1) return false;
  const element = node as Element;
  return element.tagName === "SPAN" && element.hasAttribute("data-radix-focus-guard");
}

function commitPreviousSibling(node: Node) {
  let sibling = node.previousSibling;
  while (isCommitRadixFocusGuard(sibling)) sibling = sibling?.previousSibling ?? null;
  return sibling;
}

function commitNextSibling(node: Node) {
  let sibling = node.nextSibling;
  while (isCommitRadixFocusGuard(sibling)) sibling = sibling?.nextSibling ?? null;
  return sibling;
}

function captureCommitNodePlacement(
  node: Node,
  ownerDocument: Document,
  skipFocusGuards: boolean,
): CommitNodePlacement | null {
  const parent = node.parentNode;
  if (!parent || node.ownerDocument !== ownerDocument || !node.isConnected) return null;
  const ancestors: CommitAncestorPlacement[] = [];
  let ancestor = parent;
  while (ancestor !== ownerDocument) {
    const ancestorParent = ancestor.parentNode;
    if (!ancestorParent) return null;
    ancestors.push(
      Object.freeze({
        node: ancestor,
        parent: ancestorParent,
        previousSibling: commitPreviousSibling(ancestor),
        nextSibling: commitNextSibling(ancestor),
      }),
    );
    ancestor = ancestorParent;
  }
  return Object.freeze({
    node,
    parent,
    previousSibling: skipFocusGuards ? commitPreviousSibling(node) : node.previousSibling,
    nextSibling: skipFocusGuards ? commitNextSibling(node) : node.nextSibling,
    ancestors: Object.freeze(ancestors),
  });
}

function captureCommitPlacement(
  bridge: HTMLDivElement,
  overlay: HTMLDivElement,
  content: HTMLDivElement,
): CommitPlacement | null {
  const ownerDocument = content.ownerDocument;
  const bridgePlacement = captureCommitNodePlacement(bridge, ownerDocument, false);
  const overlayPlacement = captureCommitNodePlacement(overlay, ownerDocument, true);
  const contentPlacement = captureCommitNodePlacement(content, ownerDocument, true);
  if (!bridgePlacement || !overlayPlacement || !contentPlacement) return null;
  return Object.freeze({
    document: ownerDocument,
    bridge: bridgePlacement,
    overlay: overlayPlacement,
    content: contentPlacement,
  });
}

function commitNodePlacementMatches(placement: CommitNodePlacement, skipFocusGuards: boolean) {
  const node = placement.node;
  return (
    node.isConnected &&
    node.ownerDocument === placement.parent.ownerDocument &&
    node.parentNode === placement.parent &&
    (skipFocusGuards ? commitPreviousSibling(node) : node.previousSibling) === placement.previousSibling &&
    (skipFocusGuards ? commitNextSibling(node) : node.nextSibling) === placement.nextSibling &&
    placement.ancestors.every(
      (ancestor) =>
        ancestor.node.isConnected &&
        ancestor.node.parentNode === ancestor.parent &&
        commitPreviousSibling(ancestor.node) === ancestor.previousSibling &&
        commitNextSibling(ancestor.node) === ancestor.nextSibling,
    )
  );
}

function commitPlacementMatches(placement: CommitPlacement) {
  return (
    placement.bridge.node.ownerDocument === placement.document &&
    placement.overlay.node.ownerDocument === placement.document &&
    placement.content.node.ownerDocument === placement.document &&
    commitNodePlacementMatches(placement.bridge, false) &&
    commitNodePlacementMatches(placement.overlay, true) &&
    commitNodePlacementMatches(placement.content, true)
  );
}

function createCommitDomGuard(
  publication: CommitDialogPublication,
): CommitDomGuard | null {
  const ownerWindow = publication.ownerDocument.defaultView;
  const Observer = ownerWindow?.MutationObserver;
  if (!ownerWindow || !Observer) return null;
  const records: MutationRecord[] = [];
  let dirty = false;
  const opaqueNodes = new WeakSet<Node>();
  const rememberOpaqueNode = (node: Node) => {
    opaqueNodes.add(node);
    for (const child of node.childNodes) rememberOpaqueNode(child);
  };
  for (const child of publication.gistSlot.childNodes) rememberOpaqueNode(child);
  const isAllowed = (record: MutationRecord) => {
    if (
      record.type === "attributes" &&
      record.target === publication.content &&
      record.attributeName &&
      COMMIT_RADIX_ATTRIBUTES.has(record.attributeName)
    ) {
      return true;
    }
    if (
      record.type === "attributes" &&
      record.target === publication.overlay &&
      record.attributeName &&
      COMMIT_OVERLAY_ATTRIBUTES.has(record.attributeName)
    ) {
      return true;
    }
    if (
      record.type === "childList" &&
      record.target === publication.content.parentNode &&
      [...record.addedNodes, ...record.removedNodes].length > 0 &&
      [...record.addedNodes, ...record.removedNodes].every(isCommitRadixFocusGuard)
    ) {
      return true;
    }
    return (
      record.target !== publication.gistSlot &&
      opaqueNodes.has(record.target)
    );
  };
  const recordsAreAllowed = () => {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) return false;
      if (isAllowed(record)) continue;
      const input = record.target;
      const Input = publication.ownerDocument.defaultView?.HTMLInputElement;
      if (
        !Input ||
        record.type !== "attributes" ||
        record.attributeName !== "name" ||
        record.oldValue !== null ||
        !(input instanceof Input) ||
        input.type !== "text" ||
        input.dataset.testid !== "commit-message" ||
        !publication.content.contains(input) ||
        input.hasAttribute("name")
      ) {
        return false;
      }
      let restoredName = records[index + 1];
      const valueWrite = restoredName;
      if (
        valueWrite?.target === input &&
        valueWrite.type === "attributes" &&
        valueWrite.attributeName === "value"
      ) {
        if (input.getAttribute("value") !== publication.authority.message) return false;
        index += 1;
        restoredName = records[index + 1];
      }
      if (
        !restoredName ||
        restoredName.target !== input ||
        restoredName.type !== "attributes" ||
        restoredName.attributeName !== "name" ||
        restoredName.oldValue !== ""
      ) {
        return false;
      }
      index += 1;
    }
    return true;
  };
  const inspect = () => {
    records.push(...observer.takeRecords());
    if (!dirty && records.length > 0) {
      for (const record of records) {
        if (
          record.type !== "childList" ||
          record.target === publication.gistSlot ||
          !opaqueNodes.has(record.target)
        ) {
          continue;
        }
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          rememberOpaqueNode(node);
        }
      }
      dirty = !recordsAreAllowed();
      records.length = 0;
    }
  };
  const observer = new Observer((queued) => records.push(...queued));
  observer.observe(publication.bridge, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(publication.overlay, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(publication.content, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const observedParents = new Set<Node>();
  for (const placement of [
    publication.placement.bridge,
    publication.placement.overlay,
    publication.placement.content,
  ]) {
    if (!observedParents.has(placement.parent)) {
      observedParents.add(placement.parent);
      observer.observe(placement.parent, { childList: true });
    }
    for (const ancestor of placement.ancestors) {
      if (observedParents.has(ancestor.parent)) continue;
      observedParents.add(ancestor.parent);
      observer.observe(ancestor.parent, { childList: true });
    }
  }
  return Object.freeze({
    isClean: () => {
      inspect();
      return !dirty;
    },
    release: () => {
      inspect();
      observer.disconnect();
    },
  });
}

function commitSyntheticEventShape(
  event: unknown,
  reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit",
  defaultPrevented: boolean,
) {
  if (!event || typeof event !== "object") return false;
  const candidate = event as {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  return (
    candidate._reactName === reactName &&
    typeof candidate.isDefaultPrevented === "function" &&
    candidate.isDefaultPrevented() === defaultPrevented &&
    typeof candidate.isPropagationStopped === "function" &&
    candidate.isPropagationStopped() === false &&
    typeof candidate.persist === "function"
  );
}

function commitEventPath(
  nativeEvent: Event,
  target: EventTarget,
  ownerDocument: Document,
  required: readonly EventTarget[],
) {
  const ownerWindow = ownerDocument.defaultView;
  const path = nativeEvent.composedPath();
  return (
    !!ownerWindow &&
    path[0] === target &&
    required.every((entry) => path.includes(entry)) &&
    path.includes(ownerDocument)
  );
}

function exactCommitChange(
  event: ReactChangeEvent<HTMLInputElement>,
  input: HTMLInputElement,
  form: HTMLFormElement,
  content: HTMLDivElement,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = input.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const nativeConstructorIsExact =
    !!ownerWindow &&
    (nativeEvent.constructor === ownerWindow.Event ||
      (!!ownerWindow.InputEvent && nativeEvent.constructor === ownerWindow.InputEvent));
  return ownerWindow &&
    commitSyntheticEventShape(event, "onChange", false) &&
    event.type === "change" &&
    nativeEvent instanceof ownerWindow.Event &&
    nativeConstructorIsExact &&
    (nativeEvent.type === "input" || nativeEvent.type === "change") &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    !event.defaultPrevented &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === input &&
    event.target === input &&
    nativeEvent.target === input &&
    input.isConnected &&
    input.form === form &&
    form.parentElement === content &&
    commitEventPath(nativeEvent, input, ownerDocument, [input, form, content])
    ? nativeEvent
    : null;
}

function exactCommitClick(
  event: ReactMouseEvent<HTMLElement>,
  currentTarget: HTMLElement,
  control: HTMLButtonElement,
  content: HTMLDivElement,
  form: HTMLFormElement | null,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = control.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const Pointer = ownerWindow?.PointerEvent;
  const nativeConstructorIsExact =
    !!ownerWindow &&
    (nativeEvent.constructor === ownerWindow.MouseEvent ||
      (!!Pointer && nativeEvent.constructor === Pointer));
  const target = event.target;
  const required: EventTarget[] = [control, content];
  if (form) required.push(form);
  return ownerWindow &&
    commitSyntheticEventShape(event, "onClick", false) &&
    event.type === "click" &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeConstructorIsExact &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    event.button === nativeEvent.button &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    !event.defaultPrevented &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === currentTarget &&
    target instanceof ownerWindow.Node &&
    nativeEvent.target === target &&
    target.ownerDocument === ownerDocument &&
    control.isConnected &&
    !control.disabled &&
    control.contains(target) &&
    commitEventPath(nativeEvent, target, ownerDocument, required)
    ? nativeEvent
    : null;
}

function exactCommitKey(
  event: ReactKeyboardEvent<HTMLInputElement>,
  input: HTMLInputElement,
  form: HTMLFormElement,
  content: HTMLDivElement,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = input.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  return ownerWindow &&
    commitSyntheticEventShape(event, "onKeyDown", false) &&
    event.type === "keydown" &&
    event.key === "Enter" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    nativeEvent instanceof ownerWindow.KeyboardEvent &&
    nativeEvent.constructor === ownerWindow.KeyboardEvent &&
    nativeEvent.type === "keydown" &&
    nativeEvent.key === "Enter" &&
    !nativeEvent.isComposing &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    !event.defaultPrevented &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === input &&
    event.target === input &&
    nativeEvent.target === input &&
    input.form === form &&
    input.isConnected &&
    commitEventPath(nativeEvent, input, ownerDocument, [input, form, content])
    ? nativeEvent
    : null;
}

function exactOwnedCommitSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  coordinator: CommitPublicationCoordinator,
) {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { currentTarget?: unknown };
  const possibleForm = candidate.currentTarget;
  if (!possibleForm || typeof possibleForm !== "object") return null;
  const possibleDocument = Reflect.get(possibleForm, "ownerDocument");
  if (!possibleDocument || typeof possibleDocument !== "object") return null;
  const ownerDocument = possibleDocument as Document;
  const ownerWindow = ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(possibleForm instanceof ownerWindow.HTMLFormElement)
  ) {
    return null;
  }
  const form = possibleForm;
  if (form.ownerDocument !== ownerDocument) return null;
  if (!coordinator.ownsForm(form)) return null;
  const Submit = ownerWindow.SubmitEvent;
  if (!Submit) return null;
  const nativeEvent = event.nativeEvent;
  const prepared = coordinator.submitIsPrepared(nativeEvent);
  const submitter = nativeEvent instanceof Submit ? nativeEvent.submitter : null;
  return (
    commitSyntheticEventShape(event, "onSubmit", prepared) &&
    event.type === "submit" &&
    nativeEvent instanceof Submit &&
    nativeEvent.constructor === Submit &&
    nativeEvent.type === "submit" &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.defaultPrevented === prepared &&
    nativeEvent.defaultPrevented === prepared &&
    event.target === form &&
    nativeEvent.target === form &&
    (submitter === null ||
      (submitter instanceof ownerWindow.HTMLButtonElement &&
        submitter.type === "submit" &&
        submitter.form === form)) &&
    form.isConnected &&
    commitEventPath(nativeEvent, form, ownerDocument, [form])
  )
    ? nativeEvent
    : null;
}

function exactRenderedCommitSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  submit: HTMLButtonElement,
  content: HTMLDivElement,
) {
  if (!event || typeof event !== "object") return null;
  const ownerDocument = form.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  return ownerWindow?.SubmitEvent &&
    commitSyntheticEventShape(event, "onSubmit", true) &&
    event.type === "submit" &&
    nativeEvent instanceof ownerWindow.SubmitEvent &&
    nativeEvent.constructor === ownerWindow.SubmitEvent &&
    nativeEvent.type === "submit" &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    event.eventPhase === nativeEvent.eventPhase &&
    event.bubbles === nativeEvent.bubbles &&
    event.cancelable === nativeEvent.cancelable &&
    event.defaultPrevented &&
    nativeEvent.defaultPrevented &&
    event.currentTarget === form &&
    event.target === form &&
    nativeEvent.target === form &&
    (nativeEvent.submitter === null || nativeEvent.submitter === submit) &&
    form.isConnected &&
    form.parentElement === content &&
    submit.isConnected &&
    submit.form === form &&
    form.contains(submit) &&
    commitEventPath(nativeEvent, form, ownerDocument, [form, content])
    ? nativeEvent
    : null;
}

function exactCommitNativeEvent(event: Event, publication: CommitDialogPublication) {
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const target = event.target;
  if (
    !ownerWindow ||
    event.eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
    event.currentTarget !== ownerDocument ||
    !event.bubbles ||
    event.defaultPrevented ||
    !(target instanceof ownerWindow.Node) ||
    !target.isConnected ||
    target.ownerDocument !== ownerDocument ||
    !commitEventPath(event, target, ownerDocument, [target])
  ) {
    return null;
  }
  return { ownerWindow, target };
}

function exactCommitInstantDismissal(
  event: Event,
  publication: CommitDialogPublication,
  close: HTMLButtonElement,
) {
  const exact = exactCommitNativeEvent(event, publication);
  if (!exact) return false;
  const { ownerWindow, target } = exact;
  if (event instanceof ownerWindow.KeyboardEvent) {
    return (
      event.constructor === ownerWindow.KeyboardEvent &&
      event.type === "keydown" &&
      event.key === "Escape" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      publication.content.contains(target)
    );
  }
  const Pointer = ownerWindow.PointerEvent;
  return (
    event instanceof ownerWindow.MouseEvent &&
    (event.constructor === ownerWindow.MouseEvent ||
      Boolean(Pointer && event.constructor === Pointer)) &&
    event.type === "click" &&
    event.button === 0 &&
    !event.ctrlKey &&
    close.isConnected &&
    close.contains(target) &&
    publication.content.contains(close)
  );
}

function exactCommitOutsidePointerDown(
  event: Event,
  publication: CommitDialogPublication,
) {
  const exact = exactCommitNativeEvent(event, publication);
  if (!exact) return null;
  const { ownerWindow, target } = exact;
  const Pointer = ownerWindow.PointerEvent;
  return Pointer &&
    event instanceof Pointer &&
    event.constructor === Pointer &&
    event.type === "pointerdown" &&
      event.button === 0 &&
      event.isPrimary &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !publication.content.contains(target)
    ? { event, target }
    : null;
}

function exactCommitPointerContinuation(
  event: Event,
  publication: CommitDialogPublication,
  proof: {
    readonly target: Node;
    readonly pointerId: number;
    readonly pointerType: string;
    readonly button: number;
  },
) {
  const exact = exactCommitNativeEvent(event, publication);
  if (!exact || exact.target !== proof.target) return false;
  const { ownerWindow } = exact;
  const Pointer = ownerWindow.PointerEvent;
  if (event.type === "click") {
    return (
      Boolean(Pointer) &&
      event instanceof Pointer &&
      event.constructor === Pointer &&
      event.button === proof.button &&
      event.detail > 0 &&
      event.isPrimary &&
      event.pointerId === proof.pointerId &&
      event.pointerType === proof.pointerType &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    );
  }
  return Boolean(
    Pointer &&
      event instanceof Pointer &&
      event.constructor === Pointer &&
      (event.type === "pointerup" || event.type === "pointercancel") &&
      event.pointerId === proof.pointerId &&
      event.pointerType === proof.pointerType &&
      event.isPrimary &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (event.type === "pointercancel" || event.button === proof.button),
  );
}

function exactCommitPointerDownOutsideNomination(
  event: Event,
  publication: CommitDialogPublication,
  proof: {
    readonly events: Event[];
    readonly target: Node;
    readonly pointerUp: Event | null;
    readonly click: Event | null;
  },
) {
  const originalEvent = commitPointerDownOutsideNominationOrigin(
    event,
    publication,
  );
  const ownerDocument = publication.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const click = proof.click;
  return (
    !!ownerWindow &&
    originalEvent !== null &&
    event.target === proof.target &&
    originalEvent === proof.events[0] &&
    proof.events.length === 3 &&
    proof.events[1] === proof.pointerUp &&
    proof.events[2] === click &&
    click !== null &&
    click.eventPhase === ownerWindow.Event.BUBBLING_PHASE &&
    click.currentTarget === ownerDocument &&
    click.target === proof.target &&
    !click.defaultPrevented
  );
}

function commitPointerDownOutsideNominationOrigin(
  event: Event,
  publication: CommitDialogPublication,
) {
  const ownerDocument = publication.ownerDocument;
  const suppression = publication.eventSuppression;
  const ownerWindow = suppression.ownerWindow;
  const target = event.target;
  const detail = (event as CustomEvent<unknown>).detail;
  const originalEvent =
    detail !== null && typeof detail === "object" && "originalEvent" in detail
      ? detail.originalEvent
      : null;
  return ownerDocument.defaultView === ownerWindow &&
    event instanceof suppression.CustomEventConstructor &&
    event.constructor === suppression.CustomEventConstructor &&
    event.type === COMMIT_POINTER_DOWN_OUTSIDE &&
    !event.bubbles &&
    event.cancelable &&
    !event.composed &&
    !event.defaultPrevented &&
    event.eventPhase === ownerWindow.Event.CAPTURING_PHASE &&
    event.currentTarget === ownerDocument &&
    target instanceof ownerWindow.Node &&
    target.ownerDocument === ownerDocument &&
    !publication.content.contains(target) &&
    commitEventPath(event, target, ownerDocument, [target]) &&
    originalEvent instanceof suppression.EventConstructor
    ? originalEvent
    : null;
}

function createCommitPublicationRuntime(
  presentation: CommitDialogRender,
  coordinator: CommitPublicationCoordinator,
  owners: readonly CommitElementOwnerView[],
  dom: {
    bridge: HTMLDivElement;
    overlay: HTMLDivElement;
    content: HTMLDivElement;
    gistSlot: HTMLDivElement;
  },
  onRetire: (publication: CommitDialogPublication) => void,
): CommitPublicationRuntime {
  const placement = captureCommitPlacement(dom.bridge, dom.overlay, dom.content);
  if (!placement) throw new Error("Cannot publish commit controls without a committed portal");
  const eventSuppression =
    coordinator.eventSuppression(placement.document) ??
    coordinator.prepareEventSuppression(placement.document);
  if (!eventSuppression) {
    throw new Error(
      "Cannot publish commit controls without owner-document Event suppression authority",
    );
  }
  const bridgeDom = commitSnapshotDom(dom.bridge, dom.content, dom.overlay, dom.gistSlot);
  const overlayDom = commitSnapshotDom(dom.overlay, dom.content, dom.overlay, dom.gistSlot);
  const contentDom = commitSnapshotDom(dom.content, dom.content, dom.overlay, dom.gistSlot);
  let retired = false;
  let layoutRetired = false;
  let established = false;
  let invalidReplay = false;
  let replayRefs: CommitRefReplay[] = [];
  let guard: CommitDomGuard | null = null;
  const publishedDomMatches = () =>
    Boolean(
      guard &&
        guard.isClean() &&
        commitPlacementMatches(placement) &&
        commitDomMatches(bridgeDom, placement.document, dom.content, dom.overlay) &&
        commitDomMatches(overlayDom, placement.document, dom.content, dom.overlay) &&
        commitDomMatches(contentDom, placement.document, dom.content, dom.overlay),
    );
  const retire = (reason: CommitRetirement) => {
    if (reason === "layout") layoutRetired = true;
    if (retired) return;
    retired = true;
    if (reason === "ordinary") invalidReplay = true;
    onRetire(publication);
    coordinator.retire(publication);
    queueMicrotask(() => {
      if (coordinator.replay()?.source !== publication) guard?.release();
    });
  };
  const publication: CommitDialogPublication = Object.freeze({
    identity: Symbol("commit-dialog-publication"),
    presentation,
    authority: presentation.authority,
    ownerDocument: placement.document,
    eventSuppression,
    bridge: dom.bridge,
    overlay: dom.overlay,
    content: dom.content,
    gistSlot: dom.gistSlot,
    placement,
    bridgeDom,
    overlayDom,
    contentDom,
    retire: () => retire("ordinary"),
    isRetired: () => retired,
    publishedDomMatches,
  });
  const refsHaveExactReplay = () =>
    !invalidReplay &&
    replayRefs.length === owners.length &&
    replayRefs.every(
      (entry) =>
        entry.detached &&
        entry.reattached &&
        entry.owner.element() === entry.element,
    );
  return Object.freeze({
    publication,
    publish: () => {
      established = true;
      replayRefs = owners.map((owner) => {
        const element = owner.element();
        if (!element) throw new Error("Cannot publish commit controls without every committed ref");
        return { owner, element, detached: false, reattached: false };
      });
      guard = createCommitDomGuard(publication);
      if (!guard || !coordinator.publish(publication)) {
        guard?.release();
        return false;
      }
      return true;
    },
    retireForElement: () => retire("element"),
    retireForLayout: () => retire("layout"),
    retireOrdinary: () => retire("ordinary"),
    noteRef: (
      owner: CommitElementOwnerView,
      element: Element | null,
      previous: Element | null,
    ) => {
      if (!established) return;
      const proof = replayRefs.find((entry) => entry.owner === owner);
      if (!proof) {
        invalidReplay = true;
        return;
      }
      if (element === null && previous === proof.element) {
        proof.detached = true;
        proof.reattached = false;
      } else if (element === proof.element && previous === null && proof.detached) {
        proof.reattached = true;
      } else if (element !== previous) {
        invalidReplay = true;
      }
    },
    isExactReplay: () =>
      retired &&
      layoutRetired &&
      established &&
      refsHaveExactReplay() &&
      publishedDomMatches(),
    replay: () =>
      guard
        ? Object.freeze({
            source: publication,
            bridgeDom,
            overlayDom,
            contentDom,
            placement,
            historyIsClean: guard.isClean,
            release: guard.release,
          })
        : null,
  });
}

function commitReplayAllowsPublication(
  coordinator: CommitPublicationCoordinator,
  authority: CommitDialogAuthority,
  dom: { bridge: HTMLDivElement; overlay: HTMLDivElement; content: HTMLDivElement },
) {
  const replay = coordinator.replay();
  if (!replay) return true;
  const sameAuthority = commitAuthoritiesMatch(replay.source.authority, authority, false);
  const exact =
    sameAuthority &&
    coordinator.acceptsSuccessorOf(replay.source) &&
    replay.historyIsClean() &&
    commitPlacementMatches(replay.placement) &&
    replay.source.bridge === dom.bridge &&
    replay.source.overlay === dom.overlay &&
    replay.source.content === dom.content &&
    commitDomMatches(
      replay.bridgeDom,
      replay.source.ownerDocument,
      replay.source.content,
      replay.source.overlay,
    ) &&
    commitDomMatches(
      replay.overlayDom,
      replay.source.ownerDocument,
      replay.source.content,
      replay.source.overlay,
    ) &&
    commitDomMatches(
      replay.contentDom,
      replay.source.ownerDocument,
      replay.source.content,
      replay.source.overlay,
    );
  coordinator.abandonReplay(replay.source);
  replay.release();
  return !sameAuthority || exact;
}

function createCommitDialogRender(
  authority: CommitDialogAuthority,
  coordinator: CommitPublicationCoordinator,
  latestAuthority: CommitCurrentValue<CommitDialogAuthority | null>,
  currentVisit: CommitCurrentValue<CommitDialogVisit | null>,
  activeOperation: CommitCurrentValue<CommitDialogOperation | null>,
  activeTimer: CommitCurrentValue<CommitDialogTimerOwner | null>,
  closedVisits: WeakSet<CommitDialogVisit>,
  requestSuccessor: () => void,
  updateMessage: (
    publication: CommitDialogPublication,
    authority: CommitDialogAuthority,
    message: string,
  ) => void,
  startOperation: (
    publication: CommitDialogPublication,
    authority: CommitDialogAuthority,
  ) => void,
  closeVisit: (
    publication: CommitDialogPublication,
    authority: CommitDialogAuthority,
  ) => void,
  prepareDismissalCapture: (ownerDocument: Document) => void,
): CommitDialogRender {
  let currentRuntime: CommitPublicationRuntime | null = null;
  let lastRuntime: CommitPublicationRuntime | null = null;
  let successorRequested = false;
  let establishmentQueued = false;
  let dismissal:
    | {
        readonly kind: "instant";
        readonly publication: CommitDialogPublication;
        readonly action: object;
        readonly events: readonly [Event];
      }
    | {
        readonly kind: "pointer";
        readonly publication: CommitDialogPublication;
        readonly action: object;
        readonly events: Event[];
        readonly target: Node;
        readonly pointerId: number;
        readonly pointerType: string;
        readonly button: number;
        pointerUp: Event | null;
        click: Event | null;
        expiration: number | null;
      }
    | null = null;
  const clearDismissal = () => {
    if (dismissal?.kind === "pointer" && dismissal.expiration !== null) {
      dismissal.publication.ownerDocument.defaultView?.clearTimeout(
        dismissal.expiration,
      );
    }
    dismissal = null;
  };
  const rejectDismissal = () => {
    if (dismissal?.kind === "pointer") {
      const pointerDown = dismissal.events[0];
      if (pointerDown) coordinator.rejectOutsidePointerDown(pointerDown);
    }
    clearDismissal();
  };
  const pendingReactDeliveries = new WeakMap<
    Event,
    Map<object, () => void>
  >();
  const reactCaptureProofs = new WeakMap<
    Event,
    {
      readonly publication: CommitDialogPublication;
      readonly reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit";
      readonly type: string;
      readonly captureEvent: object;
      readonly captureDefaultPrevented: boolean;
      readonly targetEvent: CommitCurrentValue<object | null>;
      readonly prototype: object;
    }
  >();
  const bridgeReactDeliveries = new WeakMap<
    Event,
    {
      readonly publication: CommitDialogPublication;
      readonly event: object;
      readonly run: () => void;
      readonly reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit";
      readonly type: string;
      readonly prototype: object;
    }
  >();
  const rejectedReactDeliveries = new WeakSet<Event>();
  const captureReactEvent = (
    event: object,
    reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit",
    type: string,
  ) => {
    const publication = coordinator.active();
    const bridge = bridgeOwner.element();
    const candidate = event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
      type?: unknown;
    };
    const nativeEvent = candidate.nativeEvent;
    const ownerWindow = publication?.ownerDocument.defaultView;
    const prototype = Object.getPrototypeOf(event);
    if (
      !publication ||
      publication.authority !== authority ||
      !bridge ||
      bridge !== publication.bridge ||
      candidate.currentTarget !== bridge ||
      candidate.type !== type ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      !coordinator.nativeEventWasDelivered(nativeEvent) ||
      !prototype ||
      pendingReactDeliveries.has(nativeEvent) ||
      reactCaptureProofs.has(nativeEvent) ||
      bridgeReactDeliveries.has(nativeEvent) ||
      rejectedReactDeliveries.has(nativeEvent) ||
      !commitSyntheticEventShape(event, reactName, nativeEvent.defaultPrevented)
    ) {
      return;
    }
    reactCaptureProofs.set(nativeEvent, {
      publication,
      reactName,
      type,
      captureEvent: event,
      captureDefaultPrevented: nativeEvent.defaultPrevented,
      targetEvent: new CommitCurrentValue<object | null>(null),
      prototype,
    });
  };
  const stageReactDelivery = (
    event: object,
    nativeEvent: Event,
    run: () => void,
  ) => {
    const proof = reactCaptureProofs.get(nativeEvent);
    if (
      !proof ||
      proof.publication !== coordinator.active() ||
      bridgeReactDeliveries.has(nativeEvent) ||
      rejectedReactDeliveries.has(nativeEvent) ||
      Object.getPrototypeOf(event) !== proof.prototype
    ) {
      return;
    }
    const stagedEvent = proof.targetEvent.get();
    if (stagedEvent && stagedEvent !== event) return;
    if (!stagedEvent) proof.targetEvent.set(event);
    const pending =
      pendingReactDeliveries.get(nativeEvent) ?? new Map<object, () => void>();
    if (!pendingReactDeliveries.has(nativeEvent)) {
      pendingReactDeliveries.set(nativeEvent, pending);
    }
    if (!pending.has(event)) pending.set(event, run);
  };
  const deliverReactEvent = (
    event: object,
    reactName: "onChange" | "onClick" | "onKeyDown" | "onSubmit",
    type: string,
  ) => {
    const possibleNativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (
      possibleNativeEvent !== null &&
      typeof possibleNativeEvent === "object" &&
      (bridgeReactDeliveries.has(possibleNativeEvent as Event) ||
        rejectedReactDeliveries.has(possibleNativeEvent as Event))
    ) {
      return;
    }
    const publication = coordinator.active();
    const bridge = bridgeOwner.element();
    const candidate = event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
      type?: unknown;
    };
    const nativeEvent = candidate.nativeEvent;
    const ownerWindow = publication?.ownerDocument.defaultView;
    const proof =
      ownerWindow && nativeEvent instanceof ownerWindow.Event
        ? reactCaptureProofs.get(nativeEvent)
        : undefined;
    const captureEvent = proof?.captureEvent as
      | {
          currentTarget?: unknown;
          nativeEvent?: unknown;
          type?: unknown;
        }
      | undefined;
    // React plugin events may reuse the capture wrapper; native events may create a bubble wrapper.
    const captureIsTargetEvent = proof?.captureEvent === event;
    if (
      !publication ||
      publication.authority !== authority ||
      !bridge ||
      bridge !== publication.bridge ||
      candidate.currentTarget !== bridge ||
      candidate.type !== type ||
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      !coordinator.nativeEventWasDelivered(nativeEvent) ||
      !proof ||
      proof.publication !== publication ||
      proof.reactName !== reactName ||
      proof.type !== type ||
      captureEvent?.currentTarget !== (captureIsTargetEvent ? bridge : null) ||
      captureEvent.nativeEvent !== nativeEvent ||
      captureEvent.type !== type ||
      Object.getPrototypeOf(proof.captureEvent) !== proof.prototype ||
      !commitSyntheticEventShape(
        proof.captureEvent,
        reactName,
        captureIsTargetEvent
          ? nativeEvent.defaultPrevented
          : proof.captureDefaultPrevented,
      ) ||
      Object.getPrototypeOf(event) !== proof.prototype ||
      !commitSyntheticEventShape(event, reactName, nativeEvent.defaultPrevented)
    ) {
      return;
    }
    if (proof.targetEvent.get() !== event) {
      rejectedReactDeliveries.add(nativeEvent);
      pendingReactDeliveries.delete(nativeEvent);
      reactCaptureProofs.delete(nativeEvent);
      return;
    }
    const pending = pendingReactDeliveries.get(nativeEvent);
    const run = pending?.get(event);
    if (!run) {
      rejectedReactDeliveries.add(nativeEvent);
      pendingReactDeliveries.delete(nativeEvent);
      reactCaptureProofs.delete(nativeEvent);
      return;
    }
    bridgeReactDeliveries.set(nativeEvent, {
      publication,
      event,
      run,
      reactName,
      type,
      prototype: proof.prototype,
    });
    pendingReactDeliveries.delete(nativeEvent);
    reactCaptureProofs.delete(nativeEvent);
  };
  const authorizeNativeDelivery = (
    publication: CommitDialogPublication,
    nativeEvent: Event,
  ) => {
    const candidate = bridgeReactDeliveries.get(nativeEvent);
    bridgeReactDeliveries.delete(nativeEvent);
    pendingReactDeliveries.delete(nativeEvent);
    reactCaptureProofs.delete(nativeEvent);
    if (!candidate) return;
    const ownerDocument = publication.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const reactEvent = candidate.event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
      type?: unknown;
    };
    if (
      !ownerWindow ||
      nativeEvent.currentTarget !== ownerDocument ||
      nativeEvent.eventPhase !== ownerWindow.Event.BUBBLING_PHASE ||
      candidate.publication !== publication ||
      publication.authority !== authority ||
      reactEvent.currentTarget !== null ||
      reactEvent.nativeEvent !== nativeEvent ||
      reactEvent.type !== candidate.type ||
      Object.getPrototypeOf(candidate.event) !== candidate.prototype ||
      !commitSyntheticEventShape(
        candidate.event,
        candidate.reactName,
        nativeEvent.defaultPrevented,
      )
    ) {
      return;
    }
    coordinator.noteReactEvent(candidate.event);
    candidate.run();
  };
  const onElementChange = (
    owner: CommitElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
      rejectDismissal();
    }
    if (owner === bridgeOwner && element) prepareDismissalCapture(element.ownerDocument);
    const form = formOwner.element();
    if (owner === formOwner && element && form === element) {
      coordinator.registerForm(form);
    }
    if (runtime?.isExactReplay() && coordinator.acceptsSuccessorOf(runtime.publication)) {
      requestReplaySuccessor(runtime);
    }
    if (
      !lastRuntime &&
      !establishmentQueued &&
      expectedOwners().every((expected) => expected.element() !== null)
    ) {
      establishmentQueued = true;
      queueMicrotask(() => {
        establishmentQueued = false;
        if (
          !lastRuntime &&
          expectedOwners().every((expected) => expected.element() !== null)
        ) {
          establish();
        }
      });
    }
  };
  const bridgeOwner = new CommitElementOwner<HTMLDivElement>(onElementChange);
  const gistSlotOwner = new CommitElementOwner<HTMLDivElement>(onElementChange);
  const formOwner = new CommitElementOwner<HTMLFormElement>(onElementChange);
  const labelOwner = new CommitElementOwner<HTMLLabelElement>(onElementChange);
  const messageOwner = new CommitElementOwner<HTMLInputElement>(onElementChange);
  const staticOwner = new CommitElementOwner<HTMLParagraphElement>(onElementChange);
  const errorOwner = new CommitElementOwner<HTMLDivElement>(onElementChange);
  const cancelOwner = new CommitElementOwner<HTMLButtonElement>(onElementChange);
  const submitOwner = new CommitElementOwner<HTMLButtonElement>(onElementChange);
  const expectedOwners = () =>
    Object.freeze([
      bridgeOwner,
      gistSlotOwner,
      formOwner,
      labelOwner,
      messageOwner,
      staticOwner,
      errorOwner,
      cancelOwner,
      submitOwner,
    ]);
  const exactDom = (changing: CommitChangingControl = null) => {
    const bridge = bridgeOwner.element();
    const gistSlot = gistSlotOwner.element();
    const form = formOwner.element();
    const label = labelOwner.element();
    const message = messageOwner.element();
    const staticText = staticOwner.element();
    const error = errorOwner.element();
    const cancel = cancelOwner.element();
    const submit = submitOwner.element();
    const content = form?.parentElement;
    const ownerWindow = content?.ownerDocument.defaultView;
    const header = content?.firstElementChild;
    const titleWrap = header?.firstElementChild;
    const title = titleWrap?.firstElementChild;
    const description = titleWrap?.lastElementChild;
    const close = header?.lastElementChild;
    const overlay = content ? commitPreviousSibling(content) : null;
    const actions = cancel?.parentElement;
    const expectedFormChildren = 6;
    const expectedActionsIndex = 5;
    const icon = submit?.firstElementChild;
    const valid =
      bridge &&
      gistSlot &&
      form &&
      label &&
      message &&
      staticText &&
      cancel &&
      submit &&
      content &&
      ownerWindow &&
      header &&
      titleWrap &&
      title &&
      description &&
      close instanceof ownerWindow.HTMLButtonElement &&
      overlay instanceof ownerWindow.HTMLDivElement &&
      bridge instanceof ownerWindow.HTMLDivElement &&
      gistSlot instanceof ownerWindow.HTMLDivElement &&
      form instanceof ownerWindow.HTMLFormElement &&
      label instanceof ownerWindow.HTMLLabelElement &&
      message instanceof ownerWindow.HTMLInputElement &&
      staticText instanceof ownerWindow.HTMLParagraphElement &&
      cancel instanceof ownerWindow.HTMLButtonElement &&
      submit instanceof ownerWindow.HTMLButtonElement &&
      actions instanceof ownerWindow.HTMLDivElement &&
      bridge.isConnected &&
      bridge.ownerDocument === content.ownerDocument &&
      bridge.getAttribute("class") === "contents" &&
      bridge.childNodes.length === 0 &&
      content instanceof ownerWindow.HTMLDivElement &&
      content.isConnected &&
      content.getAttribute("role") === "dialog" &&
      content.children.length === 2 &&
      content.children.item(0) === header &&
      content.children.item(1) === form &&
      header.parentElement === content &&
      header.children.length === 2 &&
      titleWrap.parentElement === header &&
      titleWrap.children.length === 2 &&
      title.tagName === "H2" &&
      title.textContent === authority.visit.title &&
      description.tagName === "P" &&
      description.textContent === authority.visit.description &&
      content.getAttribute("aria-labelledby") !== "" &&
      (content.getAttribute("aria-labelledby") === null ||
        content.getAttribute("aria-labelledby") === title.id) &&
      content.getAttribute("aria-describedby") !== "" &&
      (content.getAttribute("aria-describedby") === null ||
        content.getAttribute("aria-describedby") === description.id) &&
      close.parentElement === header &&
      close.type === "button" &&
      !close.disabled &&
      close.getAttribute("aria-label") === "Close" &&
      close.children.length === 1 &&
      close.firstElementChild?.tagName.toLowerCase() === "svg" &&
      overlay.isConnected &&
      overlay.ownerDocument === content.ownerDocument &&
      overlay.parentNode === content.parentNode &&
      commitNextSibling(overlay) === content &&
      overlay.getAttribute("class") === "dialog-overlay animate-fade-in" &&
      form.parentElement === content &&
      form.getAttribute("class") === COMMIT_FORM_CLASS &&
      form.getAttribute("action") === null &&
      form.getAttribute("method") === null &&
      form.getAttribute("enctype") === null &&
      form.getAttribute("target") === null &&
      form.getAttribute("novalidate") === null &&
      form.method === "get" &&
      form.enctype === "application/x-www-form-urlencoded" &&
      form.target === "" &&
      !form.noValidate &&
      form.children.length === expectedFormChildren &&
      form.childNodes.length === expectedFormChildren &&
      form.children.item(0) === gistSlot &&
      form.children.item(1) === label &&
      form.children.item(2) === message &&
      form.children.item(3) === staticText &&
      form.children.item(expectedActionsIndex) === actions &&
      gistSlot.parentElement === form &&
      gistSlot.getAttribute("class") === "contents" &&
      gistSlot.childElementCount === (authority.visit.gistControlPresent ? 1 : 0) &&
      label.parentElement === form &&
      label.getAttribute("class") === COMMIT_LABEL_CLASS &&
      label.textContent === authority.visit.label &&
      message.parentElement === form &&
      message.tagName === "INPUT" &&
      message.type === "text" &&
      message.form === form &&
      !message.disabled &&
      message.getAttribute("class") === "input" &&
      message.dataset.testid === "commit-message" &&
      message.getAttribute("name") === null &&
      (changing === "message" || message.value === authority.message) &&
      staticText.parentElement === form &&
      staticText.getAttribute("class") === COMMIT_STATIC_CLASS &&
      staticText.textContent === "Pending suggestions are not included until they are accepted." &&
      actions.parentElement === form &&
      actions.getAttribute("class") === COMMIT_ACTIONS_CLASS &&
      actions.children.length === 2 &&
      actions.childNodes.length === 2 &&
      actions.children.item(0) === cancel &&
      actions.children.item(1) === submit &&
      cancel.type === "button" &&
      cancel.form === form &&
      !cancel.disabled &&
      cancel.getAttribute("class") === COMMIT_CANCEL_CLASS &&
      cancel.textContent === "Cancel" &&
      cancel.getAttribute("aria-disabled") === null &&
      submit.type === "submit" &&
      submit.form === form &&
      submit.disabled === authority.submitDisabled &&
      submit.matches(":disabled") === authority.submitDisabled &&
      submit.getAttribute("class") === COMMIT_SUBMIT_CLASS &&
      submit.dataset.testid === "commit-submit" &&
      submit.textContent?.trim() === authority.submitText &&
      submit.getAttribute("aria-disabled") === null &&
      (authority.submitIcon === null
        ? submit.children.length === 0
        : submit.children.length === 1 &&
          icon?.tagName.toLowerCase() === "svg" &&
          icon.getAttribute("width") === "16" &&
          icon.getAttribute("height") === "16" &&
          icon.getAttribute("aria-hidden") === "true" &&
          icon.classList.contains("animate-spin") === (authority.submitIcon === "busy"));
    if (!valid) return null;
    if (
      !(error instanceof ownerWindow.HTMLDivElement) ||
      error.parentElement !== form ||
      form.children.item(4) !== error ||
      error.getAttribute("class") !== COMMIT_ERROR_CLASS ||
      error.hidden !== (authority.error === null) ||
      error.textContent !== (authority.error ?? "") ||
      error.getAttribute("role") !== null ||
      error.getAttribute("aria-live") !== null
    ) {
      return null;
    }
    return { bridge, gistSlot, form, label, message, staticText, error, cancel, submit, content, overlay, close };
  };
  const invalidate = (
    runtime: CommitPublicationRuntime,
    requireFreshSuccessor = false,
  ) => {
    runtime.retireOrdinary();
    coordinator.abandonReplay(runtime.publication);
    if (
      (!requireFreshSuccessor && successorRequested) ||
      closedVisits.has(authority.visit)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const owns = (
    publication: CommitDialogPublication,
    changing: CommitChangingControl = null,
  ) => {
    const dom = exactDom(changing);
    const exact = Boolean(
      dom &&
        commitAuthorityFactsMatch(
          authority,
          latestAuthority,
          currentVisit,
          activeOperation,
          activeTimer,
          closedVisits,
        ) &&
        publication.presentation === render &&
        publication.authority === authority &&
        publication.bridge === dom.bridge &&
        publication.overlay === dom.overlay &&
        publication.content === dom.content &&
        publication.gistSlot === dom.gistSlot &&
        coordinator.isCurrent(publication) &&
        !publication.isRetired() &&
        publication.publishedDomMatches(),
    );
    if (!exact && currentRuntime?.publication === publication && coordinator.isCurrent(publication)) {
      invalidate(currentRuntime);
    }
    return exact;
  };
  const requestReplaySuccessor = (runtime: CommitPublicationRuntime) => {
    const replay = runtime.replay();
    const dom = exactDom();
    if (
      successorRequested ||
      !replay ||
      !dom ||
      !runtime.isExactReplay() ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !commitAuthorityFactsMatch(
        authority,
        latestAuthority,
        currentVisit,
        activeOperation,
        activeTimer,
        closedVisits,
      ) ||
      !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    requestSuccessor();
  };
  const establish = () => {
    if (lastRuntime) {
      if (lastRuntime.isExactReplay()) requestReplaySuccessor(lastRuntime);
      return undefined;
    }
    const dom = exactDom();
    if (
      !dom ||
      !commitAuthorityFactsMatch(
        authority,
        latestAuthority,
        currentVisit,
        activeOperation,
        activeTimer,
        closedVisits,
      ) ||
      !commitReplayAllowsPublication(coordinator, authority, dom)
    ) {
      return undefined;
    }
    const runtime = createCommitPublicationRuntime(
      render,
      coordinator,
      expectedOwners(),
      dom,
      () => {
        rejectDismissal();
      },
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireOrdinary();
      currentRuntime = null;
      return undefined;
    }
    return runtime.retireForLayout;
  };
  const stageInstantDismissal = (
    publication: CommitDialogPublication,
    event: Event,
  ) => {
    rejectDismissal();
    if (!owns(publication)) return;
    const proof = {
      kind: "instant" as const,
      publication,
      action: Object.freeze({ identity: Symbol("commit-dialog-dismissal") }),
      events: [event] as const,
    };
    dismissal = proof;
    publication.ownerDocument.defaultView?.queueMicrotask(() => {
      if (dismissal === proof) dismissal = null;
    });
  };
  const stagePointerDismissal = (
    publication: CommitDialogPublication,
    event: PointerEvent,
    target: Node,
  ) => {
    rejectDismissal();
    if (!owns(publication)) return;
    dismissal = {
      kind: "pointer",
      publication,
      action: Object.freeze({ identity: Symbol("commit-dialog-dismissal") }),
      events: [event],
      target,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      pointerUp: null,
      click: null,
      expiration: null,
    };
  };
  const authorizeNativeDismissal = (publication: CommitDialogPublication, event: Event) => {
    if (publication.authority !== authority) return;
    const dom = exactDom();
    if (!dom || publication.content !== dom.content) return;
    if (event.type === "keydown") {
      if (exactCommitInstantDismissal(event, publication, dom.close)) {
        stageInstantDismissal(publication, event);
      }
      return;
    }
    if (event.type === "pointerdown") {
      const exact = exactCommitOutsidePointerDown(event, publication);
      if (exact) {
        stagePointerDismissal(
          publication,
          exact.event as PointerEvent,
          exact.target,
        );
      } else {
        rejectDismissal();
      }
      return;
    }
    const proof = dismissal;
    if (proof?.kind === "pointer") {
      if (
        proof.publication !== publication ||
        !exactCommitPointerContinuation(event, publication, proof)
      ) {
        rejectDismissal();
        return;
      }
      if (event.type === "pointercancel") {
        rejectDismissal();
        return;
      }
      if (event.type === "pointerup") {
        if (proof.pointerUp) {
          rejectDismissal();
          return;
        }
        proof.pointerUp = event;
        proof.events.push(event);
        proof.expiration = publication.ownerDocument.defaultView?.setTimeout(
          () => {
            if (dismissal === proof) rejectDismissal();
          },
          0,
        ) ?? null;
        return;
      }
      if (event.type === "click") {
        if (!proof.pointerUp || proof.click) {
          rejectDismissal();
          return;
        }
        if (proof.expiration !== null) {
          publication.ownerDocument.defaultView?.clearTimeout(proof.expiration);
          proof.expiration = null;
        }
        proof.click = event;
        proof.events.push(event);
        publication.ownerDocument.defaultView?.queueMicrotask(() => {
          if (dismissal !== proof || proof.expiration !== null) return;
          proof.expiration =
            publication.ownerDocument.defaultView?.setTimeout(() => {
              if (dismissal === proof) rejectDismissal();
            }, 0) ?? null;
        });
      }
      return;
    }
    if (
      event.type === "click" &&
      exactCommitInstantDismissal(event, publication, dom.close)
    ) {
      stageInstantDismissal(publication, event);
    }
  };
  const authorizePointerDownOutside = (
    publication: CommitDialogPublication,
    event: Event,
  ) => {
    const proof = dismissal;
    const originalEvent = commitPointerDownOutsideNominationOrigin(
      event,
      publication,
    );
    const rejectedOrigin = Boolean(
      originalEvent &&
        coordinator.outsidePointerDownWasRejected(originalEvent),
    );
    const currentOrigin = Boolean(
      originalEvent &&
        proof?.kind === "pointer" &&
        proof.publication === publication &&
        proof.events[0] === originalEvent,
    );
    const linkedOrigin = rejectedOrigin || currentOrigin;
    const suppressionAuthorityMatches =
      commitEventSuppressionAuthorityMatches(publication.eventSuppression);
    if (
      publication.authority !== authority ||
      proof?.kind !== "pointer" ||
      proof.publication !== publication ||
      !originalEvent ||
      coordinator.outsidePointerDownWasRejected(originalEvent) ||
      !suppressionAuthorityMatches ||
      !owns(publication) ||
      !exactCommitPointerDownOutsideNomination(event, publication, proof)
    ) {
      const suppressionSucceeded = linkedOrigin
        ? suppressCommitPointerDownOutside(publication.eventSuppression, event)
        : true;
      const runtime =
        currentRuntime?.publication === publication
          ? currentRuntime
          : lastRuntime?.publication === publication
            ? lastRuntime
            : null;
      const preservesCurrentProof =
        rejectedOrigin &&
        !currentOrigin &&
        proof?.kind === "pointer" &&
        proof.publication === publication &&
        suppressionAuthorityMatches &&
        suppressionSucceeded;
      if (!preservesCurrentProof) rejectDismissal();
      if (
        linkedOrigin &&
        (!suppressionAuthorityMatches || !suppressionSucceeded) &&
        runtime &&
        coordinator.isCurrent(publication)
      ) {
        invalidate(runtime, true);
      }
      return;
    }
    proof.events.push(event);
  };
  const onOpenChange = (open: boolean) => {
    const proof = dismissal;
    if (
      open ||
      !proof ||
      proof.publication.authority !== authority ||
      !owns(proof.publication) ||
      !coordinator.claimTerminalSequence(
        proof.publication,
        proof.action,
        proof.events,
        proof.kind === "pointer" ? "outside-pointer" : "instant",
      )
    ) {
      rejectDismissal();
      return;
    }
    clearDismissal();
    closeVisit(proof.publication, authority);
  };
  const onBridgeChangeCapture = (event: ReactChangeEvent<HTMLDivElement>) => {
    captureReactEvent(event, "onChange", "change");
  };
  const onBridgeChange = (event: ReactChangeEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onChange", "change");
  };
  const onBridgeClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    captureReactEvent(event, "onClick", "click");
  };
  const onBridgeClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onClick", "click");
  };
  const onBridgeKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    captureReactEvent(event, "onKeyDown", "keydown");
  };
  const onBridgeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onKeyDown", "keydown");
  };
  const onBridgeSubmitCapture = (event: ReactFormEvent<HTMLDivElement>) => {
    captureReactEvent(event, "onSubmit", "submit");
  };
  const onBridgeSubmit = (event: ReactFormEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onSubmit", "submit");
  };
  const onMessageChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const publication = coordinator.active();
    const dom = exactDom("message");
    if (
      !publication ||
      !dom ||
      publication.authority !== authority ||
      event.currentTarget !== dom.message
    ) {
      return;
    }
    const nativeEvent = exactCommitChange(event, dom.message, dom.form, dom.content);
    const action = Object.freeze({ identity: Symbol("commit-message-change") });
    if (!nativeEvent) return;
    const message = dom.message.value;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        !owns(publication, "message") ||
        !coordinator.claimReactEvent(publication, action, event, nativeEvent)
      ) {
        return;
      }
      updateMessage(publication, authority, message);
    });
  };
  const onMessageKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    const publication = coordinator.active();
    const dom = exactDom();
    if (!publication || !dom || event.currentTarget !== dom.message) return;
    const nativeEvent = exactCommitKey(event, dom.message, dom.form, dom.content);
    const action = Object.freeze({ identity: Symbol("commit-message-key") });
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        owns(publication) &&
        coordinator.claimReactEvent(publication, action, event, nativeEvent)
      ) {
        return;
      }
    });
  };
  const onSubmitClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = coordinator.active();
    const dom = exactDom();
    if (!publication || !dom || event.currentTarget !== dom.submit) return;
    const nativeEvent = exactCommitClick(event, dom.submit, dom.submit, dom.content, dom.form);
    const action = Object.freeze({ identity: Symbol("commit-submit-click") });
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        owns(publication) &&
        coordinator.claimReactEvent(publication, action, event, nativeEvent)
      ) {
        return;
      }
    });
  };
  const onCancel = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const publication = coordinator.active();
    const dom = exactDom();
    if (!publication || !dom || event.currentTarget !== dom.cancel) return;
    const nativeEvent = exactCommitClick(event, dom.cancel, dom.cancel, dom.content, dom.form);
    const action = Object.freeze({ identity: Symbol("commit-cancel") });
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        !owns(publication) ||
        !coordinator.claimTerminalReact(
          publication,
          action,
          event,
          nativeEvent,
        )
      ) {
        return;
      }
      closeVisit(publication, authority);
    });
  };
  const onSubmit = (event: ReactFormEvent<HTMLFormElement>) => {
    const ownedNativeEvent = exactOwnedCommitSubmit(event, coordinator);
    if (!ownedNativeEvent) return;
    if (!coordinator.submitIsPrepared(ownedNativeEvent)) {
      event.preventDefault();
      if (
        !commitSyntheticEventShape(event, "onSubmit", true) ||
        !event.defaultPrevented ||
        !ownedNativeEvent.defaultPrevented
      ) {
        return;
      }
      coordinator.prepareSubmit(ownedNativeEvent);
    }
    const dom = exactDom();
    if (!dom || event.currentTarget !== dom.form) return;
    const nativeEvent = exactRenderedCommitSubmit(event, dom.form, dom.submit, dom.content);
    if (!nativeEvent) return;
    const publication = coordinator.active();
    const action = Object.freeze({ identity: Symbol("commit-submit") });
    if (!publication) return;
    stageReactDelivery(event, nativeEvent, () => {
      if (
        publication.authority !== authority ||
        authority.submitDisabled ||
        !owns(publication) ||
        !coordinator.claimTerminalReact(
          publication,
          action,
          event,
          nativeEvent,
        )
      ) {
        return;
      }
      startOperation(publication, authority);
    });
  };
  const render: CommitDialogRender = Object.freeze({
    authority,
    captureBridge: bridgeOwner.capture,
    captureGistSlot: gistSlotOwner.capture,
    captureForm: formOwner.capture,
    captureLabel: labelOwner.capture,
    captureMessage: messageOwner.capture,
    captureStatic: staticOwner.capture,
    captureError: errorOwner.capture,
    captureCancel: cancelOwner.capture,
    captureSubmit: submitOwner.capture,
    establish,
    owns,
    onBridgeChangeCapture,
    onBridgeChange,
    onBridgeClickCapture,
    onBridgeClick,
    onBridgeKeyDownCapture,
    onBridgeKeyDown,
    onBridgeSubmitCapture,
    onBridgeSubmit,
    onMessageChange,
    onMessageKeyDown,
    onCancel,
    onSubmitClick,
    onSubmit,
    onOpenChange,
    authorizeNativeDismissal,
    authorizePointerDownOutside,
    authorizeNativeDelivery,
  });
  return render;
}

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
  const [mount] = useState(() => Symbol("commit-dialog"));
  const [coordinator] = useState(() => new CommitPublicationCoordinator(mount));
  const [presentationCache] = useState(() => new CommitPresentationCache());
  const [latestAuthority] = useState(
    () => new CommitCurrentValue<CommitDialogAuthority | null>(null),
  );
  const [currentVisit] = useState(
    () => new CommitCurrentValue<CommitDialogVisit | null>(null),
  );
  const [activeOperation] = useState(
    () => new CommitCurrentValue<CommitDialogOperation | null>(null),
  );
  const [activeTimer] = useState(
    () => new CommitCurrentValue<CommitDialogTimerOwner | null>(null),
  );
  const [pendingHandoff] = useState(
    () => new CommitCurrentValue<CommitDialogOperationHandoff | null>(null),
  );
  const [closedVisits] = useState(() => new WeakSet<CommitDialogVisit>());
  const [dismissalCapture] = useState(
    () =>
      new CommitCurrentValue<{
        readonly ownerDocument: Document;
        readonly remove: () => void;
      } | null>(null),
  );
  const [publicationRevision, setPublicationRevision] = useState(0);
  const documentFacts = commitDocumentFacts(doc);
  const documentKey = commitDocumentKey(documentFacts);
  const destination = JSON.stringify([
    doc.id,
    doc.storage,
    doc.repoOwner,
    doc.repoName,
    doc.repoBranch,
    doc.repoPath,
    doc.gistId,
    doc.gistFile,
    doc.githubUrl,
    doc.ownerId,
    doc.storage === "gist" ? Boolean(doc.publishedAt) : null,
  ]);
  const visit = useMemo(
    () =>
      open
        ? Object.freeze<CommitDialogVisit>({
            identity: Symbol("commit-dialog-visit"),
            mount,
            destination,
            doc,
            documentFacts: commitDocumentFacts(doc),
            open: true,
            onCommit,
            onOpenChange,
            isOwner,
            initialMessage: `Update ${doc.repoPath ?? doc.gistFile ?? "document"}`,
            title: doc.storage === "gist" ? "Update gist" : "Commit to GitHub",
            description:
              doc.storage === "gist"
                ? "Publishes the current text to the gist."
                : `Creates a commit on ${doc.repoBranch} in ${doc.repoOwner}/${doc.repoName}.`,
            label: doc.storage === "gist" ? "Description" : "Commit message",
            gistControlPresent: Boolean(
              isOwner &&
                doc.storage === "gist" &&
                doc.gistId &&
                doc.gistFile &&
                doc.githubUrl &&
                doc.publishedAt,
            ),
          })
        : null,
    // `documentKey` detects in-place DTO mutation; `doc` separates equal-looking replacements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [destination, doc, documentKey, isOwner, mount, onCommit, onOpenChange, open],
  );
  const [storedState, setStoredState] = useState<CommitDialogState | null>(() =>
    visit ? initialCommitDialogState(visit) : null,
  );
  let state = storedState;
  let handoff: CommitDialogOperationHandoff | null = null;
  if (visit ? state?.visit !== visit : state !== null) {
    const operation = activeOperation.get();
    const timer = activeTimer.get();
    const pendingOperation =
      state !== null &&
      state.busy &&
      !state.done &&
      state.error === null &&
      state.closeTimer === null &&
      timer === null;
    const settledOperation =
      state !== null &&
      timer !== null &&
      !state.busy &&
      state.done &&
      state.error === null &&
      state.closeTimer !== null &&
      state.closeTimer === timer &&
      timer.operation === operation &&
      timer.visit === state.visit &&
      timer.currentVisit.get() === state.visit &&
      timer.onOpenChange === state.visit.onOpenChange &&
      timer.handle !== undefined;
    const idleMetadataRefresh =
      visit !== null &&
      state !== null &&
      operation === null &&
      timer === null &&
      state.operation === null &&
      state.closeTimer === null &&
      !state.busy &&
      !state.done &&
      commitVisitsAllowMetadataHandoff(state.visit, visit);
    if (
      visit &&
      state &&
      state.operation &&
      state.operation === operation &&
      (pendingOperation || settledOperation) &&
      commitOperationAllowsVisitHandoff(operation, state.visit, visit)
    ) {
      handoff = Object.freeze({
        previous: state.visit,
        current: visit,
        operation,
        timer,
      });
      state = Object.freeze({ ...state, visit });
    } else if (idleMetadataRefresh && state && visit) {
      state = Object.freeze({ ...state, visit });
    } else {
      state = visit ? initialCommitDialogState(visit) : null;
    }
    setStoredState(state);
  }
  if (!handoff) {
    const staged = pendingHandoff.get();
    if (
      staged?.current === visit &&
      state?.visit === visit &&
      state.operation === staged.operation &&
      state.closeTimer === staged.timer
    ) {
      handoff = staged;
    }
  }
  pendingHandoff.set(handoff);
  // Insertion effects commit before layout cleanup, so abandoned renders never steal ownership.
  useInsertionEffect(() => {
    if (!handoff) return;
    if (
      activeOperation.get() !== handoff.operation ||
      handoff.operation.currentVisit.get() !== handoff.previous ||
      (handoff.timer
        ? activeTimer.get() !== handoff.timer ||
          handoff.timer.currentVisit.get() !== handoff.previous
        : activeTimer.get() !== null)
    ) {
      if (pendingHandoff.get() === handoff) pendingHandoff.set(null);
      return;
    }
    handoff.operation.currentVisit.set(handoff.current);
    handoff.timer?.currentVisit.set(handoff.current);
    if (pendingHandoff.get() === handoff) pendingHandoff.set(null);
  }, [activeOperation, activeTimer, handoff, pendingHandoff]);

  const clearVisitResources = useCallback(
    (candidate: CommitDialogVisit) => {
      const timer = activeTimer.get();
      if (timer?.currentVisit.get() === candidate) {
        activeTimer.set(null);
        if (timer.handle !== undefined) clearTimeout(timer.handle);
        timer.handle = undefined;
      }
      const operation = activeOperation.get();
      if (operation?.currentVisit.get() === candidate) activeOperation.set(null);
    },
    [activeOperation, activeTimer],
  );
  useLayoutEffect(() => {
    currentVisit.set(visit);
    return () => {
      if (currentVisit.get() === visit) currentVisit.set(null);
      if (visit) clearVisitResources(visit);
    };
  }, [clearVisitResources, currentVisit, visit]);

  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const updateMessage = useCallback(
    (
      publication: CommitDialogPublication,
      authority: CommitDialogAuthority,
      message: string,
    ) => {
      if (
        coordinator.active() !== publication ||
        latestAuthority.get() !== authority ||
        currentVisit.get() !== authority.visit
      ) {
        return;
      }
      setStoredState((current) =>
        current?.visit === authority.visit
          ? commitState(current, { message })
          : current,
      );
    },
    [coordinator, currentVisit, latestAuthority],
  );
  const operationOwns = useCallback(
    (operation: CommitDialogOperation) => {
      const publication = coordinator.active();
      const state = publication?.authority.state;
      return Boolean(
        publication &&
          activeOperation.get() === operation &&
          currentVisit.get() === operation.currentVisit.get() &&
          !closedVisits.has(operation.currentVisit.get()) &&
          state?.visit === operation.currentVisit.get() &&
          (state.operation === operation || publication === operation.origin) &&
          publication.authority.visit === operation.currentVisit.get() &&
          coordinator.isCurrent(publication) &&
          !publication.isRetired() &&
          publication.publishedDomMatches() &&
          commitVisitFactsMatch(operation.visit) &&
          commitVisitFactsMatch(operation.currentVisit.get()),
      );
    },
    [activeOperation, closedVisits, coordinator, currentVisit],
  );
  const closeVisit = useCallback(
    (
      publication: CommitDialogPublication,
      authority: CommitDialogAuthority,
    ) => {
      if (
        coordinator.active() !== publication ||
        currentVisit.get() !== authority.visit ||
        latestAuthority.get() !== authority ||
        closedVisits.has(authority.visit)
      ) {
        return;
      }
      closedVisits.add(authority.visit);
      clearVisitResources(authority.visit);
      publication.retire();
      authority.visit.onOpenChange(false);
    },
    [
      clearVisitResources,
      closedVisits,
      coordinator,
      currentVisit,
      latestAuthority,
    ],
  );
  const startOperation = useCallback(
    (
      publication: CommitDialogPublication,
      authority: CommitDialogAuthority,
    ) => {
      if (activeOperation.get()) return;
      const operation = Object.freeze<CommitDialogOperation>({
        identity: Symbol("commit-dialog-operation"),
        visit: authority.visit,
        currentVisit: new CommitCurrentValue(authority.visit),
        origin: publication,
        message: authority.trimmedMessage,
        commit: authority.visit.onCommit,
      });
      if (!coordinator.claimOperation(operation)) return;
      activeOperation.set(operation);
      setStoredState((current) =>
        current?.visit === operation.currentVisit.get()
          ? commitState(current, {
              busy: true,
              error: null,
              done: false,
              operation,
              closeTimer: null,
            })
          : current,
      );
      let pending: Promise<void>;
      try {
        pending = operation.commit(operation.message);
      } catch (error) {
        pending = Promise.reject(error);
      }
      void Promise.resolve(pending).then(
        () => {
          if (!operationOwns(operation) || activeTimer.get()) return;
          const operationVisit = operation.currentVisit.get();
          const timer: CommitDialogTimerOwner = {
            identity: Symbol("commit-dialog-close-timer"),
            visit: operationVisit,
            currentVisit: new CommitCurrentValue(operationVisit),
            operation,
            onOpenChange: operationVisit.onOpenChange,
            handle: undefined,
          };
          if (!coordinator.claimTimer(timer)) return;
          activeTimer.set(timer);
          const timerAction = Object.freeze({
            identity: Symbol("commit-dialog-timer-close"),
          });
          timer.handle = setTimeout(() => {
            const currentPublication = coordinator.active();
            const currentState = currentPublication?.authority.state;
            if (
              !currentPublication ||
              activeTimer.get() !== timer ||
              activeOperation.get() !== operation ||
              currentVisit.get() !== timer.currentVisit.get() ||
              closedVisits.has(timer.currentVisit.get()) ||
              currentState?.visit !== timer.currentVisit.get() ||
              currentState.operation !== operation ||
              currentState.closeTimer !== timer ||
              !currentState.done ||
              currentState.busy ||
              currentPublication.authority.state !== currentState ||
              !currentPublication.presentation.owns(currentPublication) ||
              !coordinator.claimTimerClose(
                currentPublication,
                timerAction,
                operation,
                timer,
              )
            ) {
              return;
            }
            activeTimer.set(null);
            activeOperation.set(null);
            closedVisits.add(timer.currentVisit.get());
            currentPublication.retire();
            timer.onOpenChange(false);
          }, 900);
          setStoredState((current) =>
            current?.visit === operation.currentVisit.get() &&
            current.operation === operation
              ? commitState(current, {
                  busy: false,
                  error: null,
                  done: true,
                  closeTimer: timer,
                })
              : current,
          );
        },
        (error: unknown) => {
          if (!operationOwns(operation)) return;
          const operationVisit = operation.currentVisit.get();
          activeOperation.set(null);
          setStoredState((current) =>
            current?.visit === operationVisit &&
            (current.operation === operation || current === authority.state)
              ? commitState(current, {
                  busy: false,
                  error: apiErrorText(error, "Publish failed"),
                  done: false,
                  operation: null,
                  closeTimer: null,
                })
              : current,
          );
        },
      );
    },
    [
      activeOperation,
      activeTimer,
      closedVisits,
      coordinator,
      currentVisit,
      operationOwns,
    ],
  );
  const prepareDismissalCapture = useCallback(
    (ownerDocument: Document) => {
      if (!coordinator.prepareEventSuppression(ownerDocument)) return;
      const previous = dismissalCapture.get();
      if (previous?.ownerDocument === ownerDocument) {
        dismissalCapture.set({ ...previous });
        return;
      }
      previous?.remove();
      const remember = (event: Event) => {
        coordinator.noteNativeEvent(event);
        const publication = coordinator.active();
        if (publication) {
          publication.presentation.authorizeNativeDismissal(publication, event);
        }
      };
      const finish = (event: Event) => {
        const publication = coordinator.active();
        if (publication) {
          publication.presentation.authorizeNativeDelivery(publication, event);
        }
      };
      const rememberPointerDownOutside = (event: Event) => {
        coordinator.noteNativeEvent(event);
        const publication = coordinator.active();
        if (publication) {
          publication.presentation.authorizePointerDownOutside(publication, event);
        }
      };
      ownerDocument.addEventListener("keydown", remember, true);
      ownerDocument.addEventListener("input", remember, true);
      ownerDocument.addEventListener("change", remember, true);
      ownerDocument.addEventListener("click", remember, true);
      ownerDocument.addEventListener("submit", remember, true);
      ownerDocument.addEventListener("pointerdown", remember, true);
      ownerDocument.addEventListener("pointerup", remember, true);
      ownerDocument.addEventListener("pointercancel", remember, true);
      ownerDocument.addEventListener(
        COMMIT_POINTER_DOWN_OUTSIDE,
        rememberPointerDownOutside,
        true,
      );
      ownerDocument.addEventListener("keydown", finish);
      ownerDocument.addEventListener("input", finish);
      ownerDocument.addEventListener("change", finish);
      ownerDocument.addEventListener("click", finish);
      ownerDocument.addEventListener("submit", finish);
      const capture = {
        ownerDocument,
        remove: () => {
          ownerDocument.removeEventListener("keydown", remember, true);
          ownerDocument.removeEventListener("input", remember, true);
          ownerDocument.removeEventListener("change", remember, true);
          ownerDocument.removeEventListener("click", remember, true);
          ownerDocument.removeEventListener("submit", remember, true);
          ownerDocument.removeEventListener("pointerdown", remember, true);
          ownerDocument.removeEventListener("pointerup", remember, true);
          ownerDocument.removeEventListener("pointercancel", remember, true);
          ownerDocument.removeEventListener(
            COMMIT_POINTER_DOWN_OUTSIDE,
            rememberPointerDownOutside,
            true,
          );
          ownerDocument.removeEventListener("keydown", finish);
          ownerDocument.removeEventListener("input", finish);
          ownerDocument.removeEventListener("change", finish);
          ownerDocument.removeEventListener("click", finish);
          ownerDocument.removeEventListener("submit", finish);
        },
      };
      dismissalCapture.set(capture);
    },
    [coordinator, dismissalCapture],
  );

  const authority =
    visit && state?.visit === visit
      ? Object.freeze<CommitDialogAuthority>({
          visit,
          revision: publicationRevision,
          state,
          message: state.message,
          trimmedMessage: state.message.trim(),
          busy: state.busy,
          error: state.error,
          done: state.done,
          operation: state.operation,
          closeTimer: state.closeTimer,
          submitDisabled: state.busy || state.done,
          submitText: state.done
            ? "Published"
            : visit.doc.storage === "gist"
              ? "Update gist"
              : "Commit",
          submitIcon: state.done ? "done" : state.busy ? "busy" : null,
        })
      : null;
  const presentation = authority
    ? presentationCache.resolve(authority, () =>
        createCommitDialogRender(
          authority,
          coordinator,
          latestAuthority,
          currentVisit,
          activeOperation,
          activeTimer,
          closedVisits,
          requestPublicationSuccessor,
          updateMessage,
          startOperation,
          closeVisit,
          prepareDismissalCapture,
        ),
      )
    : null;
  useInsertionEffect(() => {
    const committedAuthority = presentation?.authority ?? null;
    latestAuthority.set(committedAuthority);
    return () => {
      if (latestAuthority.get() === committedAuthority) latestAuthority.set(null);
    };
  }, [latestAuthority, presentation]);

  useLayoutEffect(() => presentation?.establish(), [presentation]);

  useLayoutEffect(
    () => () => {
      const capture = dismissalCapture.get();
      const replay = coordinator.replay();
      queueMicrotask(() => {
        if (
          replay &&
          currentVisit.get() === null &&
          coordinator.replay() === replay
        ) {
          coordinator.abandonReplay(replay.source);
          replay.release();
        }
        if (!coordinator.active() && dismissalCapture.get() === capture) {
          capture?.remove();
          dismissalCapture.set(null);
        }
      });
    },
    [coordinator, currentVisit, dismissalCapture],
  );

  const shown = presentation?.authority ?? null;
  const captureBridge = presentation?.captureBridge;
  const captureGistSlot = presentation?.captureGistSlot;
  const captureForm = presentation?.captureForm;
  const captureLabel = presentation?.captureLabel;
  const captureMessage = presentation?.captureMessage;
  const captureStatic = presentation?.captureStatic;
  const captureError = presentation?.captureError;
  const captureCancel = presentation?.captureCancel;
  const captureSubmit = presentation?.captureSubmit;
  const onBridgeChangeCapture = presentation?.onBridgeChangeCapture;
  const onBridgeChange = presentation?.onBridgeChange;
  const onBridgeClickCapture = presentation?.onBridgeClickCapture;
  const onBridgeClick = presentation?.onBridgeClick;
  const onBridgeKeyDownCapture = presentation?.onBridgeKeyDownCapture;
  const onBridgeKeyDown = presentation?.onBridgeKeyDown;
  const onBridgeSubmitCapture = presentation?.onBridgeSubmitCapture;
  const onBridgeSubmit = presentation?.onBridgeSubmit;
  const onMessageChange = presentation?.onMessageChange;
  const onMessageKeyDown = presentation?.onMessageKeyDown;
  const onCancel = presentation?.onCancel;
  const onSubmitClick = presentation?.onSubmitClick;
  const onSubmit = presentation?.onSubmit;
  const changeOpen = presentation?.onOpenChange;

  return (
    <Dialog open={open} onOpenChange={changeOpen ?? (() => undefined)}>
      <div
        ref={captureBridge}
        className="contents"
        onChangeCapture={onBridgeChangeCapture}
        onChange={onBridgeChange}
        onClickCapture={onBridgeClickCapture}
        onClick={onBridgeClick}
        onKeyDownCapture={onBridgeKeyDownCapture}
        onKeyDown={onBridgeKeyDown}
        onSubmitCapture={onBridgeSubmitCapture}
        onSubmit={onBridgeSubmit}
      >
        {presentation && shown && (
          <DialogContent title={shown.visit.title} description={shown.visit.description}>
            <form
              ref={captureForm}
              className={COMMIT_FORM_CLASS}
              onSubmit={onSubmit}
            >
              <div ref={captureGistSlot} className="contents">
                <GistAutoUpdateControl doc={shown.visit.doc} isOwner={shown.visit.isOwner} />
              </div>
              <label ref={captureLabel} className={COMMIT_LABEL_CLASS}>
                {shown.visit.label}
              </label>
              <input
                ref={captureMessage}
                className="input"
                value={shown.message}
                onChange={onMessageChange}
                onKeyDown={onMessageKeyDown}
                autoFocus
                data-testid="commit-message"
              />
              <p ref={captureStatic} className={COMMIT_STATIC_CLASS}>
                Pending suggestions are not included until they are accepted.
              </p>
              <div ref={captureError} className={COMMIT_ERROR_CLASS} hidden={shown.error === null}>
                {shown.error ?? ""}
              </div>
              <div className={COMMIT_ACTIONS_CLASS}>
                <button
                  ref={captureCancel}
                  type="button"
                  className={COMMIT_CANCEL_CLASS}
                  onClick={onCancel}
                >
                  Cancel
                </button>
                <button
                  ref={captureSubmit}
                  type="submit"
                  className={COMMIT_SUBMIT_CLASS}
                  disabled={shown.submitDisabled}
                  onClick={onSubmitClick}
                  data-testid="commit-submit"
                >
                  {shown.submitIcon === "done" ? (
                    <Check size={16} />
                  ) : shown.submitIcon === "busy" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null}
                  {shown.submitText}
                </button>
              </div>
            </form>
          </DialogContent>
        )}
      </div>
    </Dialog>
  );
});
