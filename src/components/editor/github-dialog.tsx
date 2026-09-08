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
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
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

interface CommitDialogTimerOwner {
  handle: ReturnType<typeof setTimeout> | undefined;
}

interface CommitDialogOperation {
  readonly visit: CommitDialogVisit;
  readonly message: string;
  readonly commit: (message: string) => Promise<void>;
}

interface CommitDialogVisit {
  readonly token: symbol;
  readonly destination: string;
  readonly doc: DocumentDto;
  readonly onCommit: (message: string) => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
  readonly isOwner: boolean;
  operation: CommitDialogOperation | null;
  closeTimer: CommitDialogTimerOwner | null;
}

interface CommitDialogPresentation {
  readonly visit: CommitDialogVisit;
  readonly message: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly done: boolean;
}

function initialCommitDialogPresentation(visit: CommitDialogVisit): CommitDialogPresentation {
  return {
    visit,
    message: `Update ${visit.doc.repoPath ?? visit.doc.gistFile ?? "document"}`,
    busy: false,
    error: null,
    done: false,
  };
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
  const latestDoc = useRef(doc);
  latestDoc.current = doc;
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
    Boolean(doc.publishedAt),
  ]);
  const visit = useMemo<CommitDialogVisit | null>(
    () =>
      open
        ? {
            token: Symbol("commit-dialog-visit"),
            destination,
            doc: latestDoc.current,
            onCommit,
            onOpenChange,
            isOwner,
            operation: null,
            closeTimer: null,
          }
        : null,
    [destination, isOwner, onCommit, onOpenChange, open],
  );
  const currentVisit = useRef<CommitDialogVisit | null>(null);
  const [presentation, setPresentation] = useState<CommitDialogPresentation | null>(() =>
    visit ? initialCommitDialogPresentation(visit) : null,
  );
  const retire = useCallback((candidate: CommitDialogVisit) => {
    if (currentVisit.current === candidate) currentVisit.current = null;
    candidate.operation = null;
    const timer = candidate.closeTimer;
    candidate.closeTimer = null;
    if (timer?.handle !== undefined) clearTimeout(timer.handle);
  }, []);

  useLayoutEffect(() => {
    if (!visit) {
      setPresentation((current) => (current === null ? current : null));
      return;
    }
    currentVisit.current = visit;
    setPresentation((current) => (current?.visit === visit ? current : initialCommitDialogPresentation(visit)));
    return () => retire(visit);
  }, [retire, visit]);

  const shown = visit && presentation?.visit === visit ? presentation : visit ? initialCommitDialogPresentation(visit) : null;
  const shownDoc = visit?.doc ?? doc;
  const changeOpen = (nextOpen: boolean) => {
    if (!visit || currentVisit.current !== visit) return;
    if (!nextOpen) retire(visit);
    visit.onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent title={shownDoc.storage === "gist" ? "Update gist" : "Commit to GitHub"} description={shownDoc.storage === "gist" ? "Publishes the current text to the gist." : `Creates a commit on ${shownDoc.repoBranch} in ${shownDoc.repoOwner}/${shownDoc.repoName}.`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!visit || !shown || currentVisit.current !== visit || visit.operation) return;
            const operation: CommitDialogOperation = {
              visit,
              message: shown.message.trim(),
              commit: visit.onCommit,
            };
            visit.operation = operation;
            setPresentation((current) =>
              current?.visit === visit ? { ...current, busy: true, error: null } : current,
            );
            const ownsOperation = () => currentVisit.current === visit && visit.operation === operation;
            void (async () => {
              let succeeded = false;
              try {
                await operation.commit(operation.message);
                if (!ownsOperation()) return;
                succeeded = true;
                setPresentation((current) =>
                  current?.visit === visit ? { ...current, done: true } : current,
                );
                const timerOwner: CommitDialogTimerOwner = { handle: undefined };
                visit.closeTimer = timerOwner;
                timerOwner.handle = setTimeout(() => {
                  if (!ownsOperation() || visit.closeTimer !== timerOwner) return;
                  visit.closeTimer = null;
                  retire(visit);
                  visit.onOpenChange(false);
                }, 900);
              } catch (error) {
                if (!ownsOperation()) return;
                setPresentation((current) =>
                  current?.visit === visit ? { ...current, error: apiErrorText(error, "Publish failed") } : current,
                );
              } finally {
                if (!ownsOperation()) return;
                if (!succeeded) visit.operation = null;
                setPresentation((current) =>
                  current?.visit === visit ? { ...current, busy: false } : current,
                );
              }
            })();
          }}
        >
          {visit && <GistAutoUpdateControl doc={visit.doc} isOwner={visit.isOwner} />}
          <label className="text-sm font-medium text-ink-2">{shownDoc.storage === "gist" ? "Description" : "Commit message"}</label>
          <input
            className="input"
            value={shown?.message ?? ""}
            onChange={(e) => {
              if (!visit || currentVisit.current !== visit) return;
              setPresentation((current) =>
                current?.visit === visit ? { ...current, message: e.target.value } : current,
              );
            }}
            autoFocus
            data-testid="commit-message"
          />
          <p className="text-xs text-ink-3">Pending suggestions are not included until they are accepted.</p>
          {shown?.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{shown.error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => changeOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary gap-2" disabled={shown?.busy || shown?.done} data-testid="commit-submit">
              {shown?.done ? <Check size={16} /> : shown?.busy ? <Loader2 size={16} className="animate-spin" /> : null}
              {shown?.done ? "Published" : shownDoc.storage === "gist" ? "Update gist" : "Commit"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});
