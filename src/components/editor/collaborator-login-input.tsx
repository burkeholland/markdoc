"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Loader2, UserPlus } from "lucide-react";
import { api, apiErrorText, type GitHubUserDto } from "@/lib/api";
import { cn, initials } from "@/lib/utils";

/** Keystrokes settle for this long before one request goes out for the typed prefix. */
export const SUGGEST_DEBOUNCE_MS = 250;
/** Shorter prefixes are not searched (the route refuses them as well). */
export const SUGGEST_MIN_CHARS = 2;
/** The route answers at most this many; the list never shows more. */
export const SUGGEST_MAX = 8;

function SuggestionAvatar({
  login,
  src,
  onFallback,
}: {
  login: string;
  src: string;
  onFallback: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="avatar"
      style={{ width: 20, height: 20, fontSize: 10 }}
      title={login}
    >
      <span hidden={!failed}>
        {failed ? initials(login) : null}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={login}
        width={20}
        height={20}
        className="h-full w-full object-cover"
        onError={() => {
          if (failed) return;
          onFallback();
          setFailed(true);
        }}
        referrerPolicy="no-referrer"
        hidden={failed}
      />
    </span>
  );
}

/** The login prefix worth searching for what was typed — trimmed, without a leading `@` — or null when too short or not a login. */
export function suggestQuery(value: string): string | null {
  const q = value.trim().replace(/^@/, "");
  return q.length >= SUGGEST_MIN_CHARS &&
    q.length <= 39 &&
    /^[a-zA-Z0-9-]+$/.test(q)
    ? q
    : null;
}

type InputScope = Readonly<{
  value: string;
  onChange: (value: string) => void;
  onPick?: (login: string) => void;
  exclusionKey: string;
  excluded: ReadonlySet<string>;
  query: string | null;
}>;

type ControlBinding = Readonly<{
  identity: symbol;
  scope: InputScope;
}>;

type QueryMode = "debounce" | "immediate";

type TimerAuthority = {
  readonly query: QueryAuthority;
  handle: ReturnType<typeof setTimeout> | null;
  pending: boolean;
};

type RequestAuthority = {
  readonly query: QueryAuthority;
  readonly controller: AbortController;
  claimed: boolean;
};

type QueryAuthority = {
  readonly binding: ControlBinding;
  readonly scope: InputScope;
  readonly query: string;
  readonly mode: QueryMode;
  timer: TimerAuthority | null;
  request: RequestAuthority | null;
  started: boolean;
  retired: boolean;
};

type LookupState =
  | Readonly<{ query: QueryAuthority; status: "loading" }>
  | Readonly<{
      query: QueryAuthority;
      status: "error";
      message: string;
      retrying: boolean;
    }>;

type PublishedState = Readonly<{
  scope: InputScope;
  query: QueryAuthority | null;
  options: readonly GitHubUserDto[];
  open: boolean;
  active: number;
  lookup: LookupState | null;
}>;

class InputCoordinator {
  private bindingValue: ControlBinding | null = null;
  private queryValue: QueryAuthority | null = null;
  private publishedValue: PublishedState | null = null;
  private pickedValue: string | null = null;
  private noTokenValue = false;
  private reactEventValue: Event | null = null;
  private readonly queryReplays = new WeakMap<
    QueryAuthority,
    QueryReplay
  >();
  readonly cache = new Map<string, readonly GitHubUserDto[]>();

  readonly binding = () => this.bindingValue;
  readonly setBinding = (binding: ControlBinding | null) => {
    this.bindingValue = binding;
  };
  readonly query = () => this.queryValue;
  readonly setQuery = (query: QueryAuthority | null) => {
    this.queryValue = query;
  };
  readonly published = () => this.publishedValue;
  readonly setPublished = (published: PublishedState | null) => {
    this.publishedValue = published;
  };
  readonly picked = () => this.pickedValue;
  readonly setPicked = (login: string | null) => {
    this.pickedValue = login;
  };
  readonly noToken = () => this.noTokenValue;
  readonly reactEvent = () => this.reactEventValue;
  readonly queryReplay = (query: QueryAuthority) =>
    this.queryReplays.get(query) ?? null;
  readonly setQueryReplay = (
    query: QueryAuthority,
    replay: QueryReplay,
  ) => {
    this.queryReplays.set(query, replay);
  };
  readonly beginReactEvent = (event: Event) => {
    this.reactEventValue = event;
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (this.reactEventValue === event) {
          this.reactEventValue = null;
        }
      });
    });
  };
  readonly disableSuggestions = () => {
    this.noTokenValue = true;
  };
}

type CandidatePresentation = Readonly<{
  candidate: GitHubUserDto;
  index: number;
  optionId: string;
  login: string;
  name: string | null;
  avatarUrl: string;
}>;

type InputPresentation = Readonly<{
  mount: symbol;
  binding: ControlBinding;
  scope: InputScope;
  sourceState: PublishedState | null;
  state: PublishedState | null;
  query: QueryAuthority | null;
  candidates: readonly CandidatePresentation[];
  expanded: boolean;
  activeIndex: number;
  lookup: LookupState | null;
  cacheKey: string | null;
  cacheEntry: readonly GitHubUserDto[] | null;
  picked: string | null;
  noToken: boolean;
  listId: string;
  feedbackId: string;
}>;

type ActionKind =
  | "change"
  | "focus"
  | "keydown"
  | "blur"
  | "retry"
  | "row-down"
  | "row-enter"
  | "row-click";

type ActionPublication = Readonly<{
  identity: symbol;
  publicationIdentity: symbol;
  kind: ActionKind;
  rowIndex: number | null;
}>;

interface InputRowPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly authority: CandidatePresentation;
  readonly element: HTMLLIElement;
  readonly down: ActionPublication;
  readonly enter: ActionPublication;
  readonly click: ActionPublication;
}

interface InputPublication {
  readonly identity: symbol;
  readonly presentation: InputPresentation;
  readonly ownerDocument: Document;
  readonly root: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly feedback: HTMLDivElement | null;
  readonly retry: HTMLButtonElement | null;
  readonly list: HTMLUListElement | null;
  readonly rows: readonly InputRowPublication[];
  readonly rootTargets: readonly Node[];
  readonly inputTargets: readonly Node[];
  readonly retryTargets: readonly Node[];
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly ownsQuery: (query: QueryAuthority) => boolean;
}

interface InputElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class InputElementOwner<T extends HTMLElement>
  implements InputElementOwnerView
{
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: InputElementOwnerView,
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
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

interface InputDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly InputDomSnapshot[];
}

interface InputPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface InputRefReplay {
  readonly owner: InputElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface QueryReplay {
  readonly source: QueryAuthority;
  readonly mode: QueryMode;
  readonly settled: boolean;
}

interface InputReplay {
  readonly source: InputPublication;
  readonly dom: InputDomSnapshot;
  readonly placement: InputPlacement;
  readonly partialElements: ReadonlySet<HTMLElement>;
  readonly query: QueryReplay | null;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface InputPublicationCells {
  active: InputPublication | null;
  successorOf: InputPublication | null;
  replay: InputReplay | null;
  renderToken: symbol | null;
  renderBinding: ControlBinding | null;
  readonly retiredPublications: WeakSet<InputPublication>;
  readonly retiredRows: WeakSet<InputRowPublication>;
  readonly retiredActions: WeakSet<ActionPublication>;
  readonly claimedPublications: WeakSet<InputPublication>;
  readonly claimedRows: WeakSet<InputRowPublication>;
  readonly claimedActions: WeakSet<ActionPublication>;
  readonly claimedQueries: WeakSet<QueryAuthority>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly deliveredReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly consumedPublications: WeakSet<InputPublication>;
  readonly seenElements: WeakSet<HTMLElement>;
}

interface InputPublicationRuntime {
  readonly publication: InputPublication;
  readonly publish: (
    dom: InputDomSnapshot,
    placement: InputPlacement,
    owners: readonly InputElementOwnerView[],
    partialReplayElements: ReadonlySet<HTMLElement>,
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: InputElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly layoutWasRetired: () => boolean;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: (allowInputValue?: boolean) => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => InputDomSnapshot | null;
  readonly placement: () => InputPlacement | null;
  readonly partialReplayElements: () => ReadonlySet<HTMLElement>;
  readonly queryReplay: () => QueryReplay | null;
}

interface InputPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureInput: (element: HTMLInputElement | null) => void;
  readonly captureFeedback: (element: HTMLDivElement | null) => void;
  readonly captureRetry: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly rows: readonly {
    readonly capture: (element: HTMLLIElement | null) => void;
    readonly onMouseDown: (event: MouseEvent<HTMLLIElement>) => void;
    readonly onMouseOver: (event: MouseEvent<HTMLLIElement>) => void;
    readonly onClick: (event: MouseEvent<HTMLLIElement>) => void;
  }[];
  readonly establish: () => void | (() => void);
  readonly deliverChange: (event: ChangeEvent<HTMLDivElement>) => void;
  readonly deliverFocus: (event: FocusEvent<HTMLDivElement>) => void;
  readonly deliverKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly deliverBlur: (event: FocusEvent<HTMLDivElement>) => void;
  readonly deliverClick: (event: MouseEvent<HTMLDivElement>) => void;
  readonly deliverMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  readonly deliverMouseOver: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onFocus: (event: FocusEvent<HTMLInputElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onBlur: (
    event: FocusEvent<HTMLInputElement | HTMLButtonElement>,
  ) => void;
  readonly onRetry: (event: MouseEvent<HTMLButtonElement>) => void;
}

interface InputPublicationContext {
  readonly coordinator: InputCoordinator;
  readonly retireQuery: (query: QueryAuthority) => void;
  readonly makeQuery: (
    binding: ControlBinding,
    mode?: QueryMode,
    started?: boolean,
  ) => QueryAuthority | null;
  readonly replacePublished: (
    expected: PublishedState | null,
    next: PublishedState,
  ) => boolean;
}

function freezeUsers(
  users: readonly GitHubUserDto[],
): readonly GitHubUserDto[] {
  return Object.freeze(
    users.map(({ login, name, avatarUrl }) =>
      Object.freeze({ login, name, avatarUrl }),
    ),
  );
}

function freezeLookup(lookup: LookupState): LookupState {
  return Object.freeze(lookup);
}

function freezePublished(
  state: Omit<PublishedState, "options"> & {
    options: readonly GitHubUserDto[];
  },
): PublishedState {
  return Object.freeze({
    ...state,
    options: Object.isFrozen(state.options)
      ? state.options
      : freezeUsers(state.options),
  });
}

function userFactsMatch(
  user: GitHubUserDto,
  login: string,
  name: string | null,
  avatarUrl: string,
) {
  return (
    user.login === login &&
    user.name === name &&
    user.avatarUrl === avatarUrl
  );
}

function scopeFactsMatch(scope: InputScope) {
  const normalized = [
    ...new Set(
      scope.exclusionKey ? scope.exclusionKey.split("\0") : [],
    ),
  ];
  return (
    Object.isFrozen(scope) &&
    scope.query === suggestQuery(scope.value) &&
    scope.excluded.size === normalized.length &&
    normalized.every((login) => scope.excluded.has(login))
  );
}

function presentationFactsMatch(presentation: InputPresentation) {
  const { scope, state, lookup, candidates, cacheEntry } = presentation;
  if (
    !Object.isFrozen(presentation) ||
    !Object.isFrozen(scope) ||
    !Object.isFrozen(presentation.binding) ||
    presentation.binding.scope !== scope ||
    !scopeFactsMatch(scope) ||
    presentation.state !==
      (presentation.sourceState?.scope === scope
        ? presentation.sourceState
        : null) ||
    presentation.query !== (state?.query ?? null) ||
    presentation.expanded !==
      Boolean(state?.open && candidates.length > 0) ||
    presentation.activeIndex !==
      (state &&
      state.active >= 0 &&
      state.active < candidates.length
        ? state.active
        : -1) ||
    presentation.lookup !==
      (state && state.lookup?.query === state.query
        ? state.lookup
        : null) ||
    presentation.cacheKey !==
      (scope.query ? scope.query.toLowerCase() : null) ||
    !Object.isFrozen(candidates) ||
    candidates.length >
      Math.min(state?.options.length ?? 0, SUGGEST_MAX)
  ) {
    return false;
  }
  if (
    lookup &&
    (!Object.isFrozen(lookup) ||
      lookup.query !== presentation.query ||
      lookup.query.scope !== scope ||
      lookup.query.binding !== presentation.binding)
  ) {
    return false;
  }
  if (
    cacheEntry &&
    (!Object.isFrozen(cacheEntry) ||
      cacheEntry.some((candidate) => !Object.isFrozen(candidate)))
  ) {
    return false;
  }
  const visible =
    state?.options
      .filter(
        (candidate) =>
          !scope.excluded.has(candidate.login.toLowerCase()),
      )
      .slice(0, SUGGEST_MAX) ?? [];
  return (
    visible.length === candidates.length &&
    candidates.every((candidate, index) => {
      const source = visible[index];
      return (
        Object.isFrozen(candidate) &&
        candidate.index === index &&
        candidate.optionId ===
          `${presentation.listId}-option-${index}` &&
        candidate.candidate === source &&
        Boolean(
          source &&
            userFactsMatch(
              source,
              candidate.login,
              candidate.name,
              candidate.avatarUrl,
            ),
        )
      );
    })
  );
}

function presentationsMatch(
  previous: InputPresentation,
  current: InputPresentation,
) {
  return (
    previous.mount === current.mount &&
    previous.binding === current.binding &&
    previous.scope === current.scope &&
    previous.scope.value === current.scope.value &&
    previous.scope.onChange === current.scope.onChange &&
    previous.scope.onPick === current.scope.onPick &&
    previous.scope.exclusionKey === current.scope.exclusionKey &&
    previous.scope.excluded === current.scope.excluded &&
    previous.scope.query === current.scope.query &&
    previous.sourceState === current.sourceState &&
    previous.state === current.state &&
    previous.query === current.query &&
    previous.expanded === current.expanded &&
    previous.activeIndex === current.activeIndex &&
    previous.lookup === current.lookup &&
    previous.cacheKey === current.cacheKey &&
    previous.cacheEntry === current.cacheEntry &&
    previous.picked === current.picked &&
    previous.noToken === current.noToken &&
    previous.listId === current.listId &&
    previous.feedbackId === current.feedbackId &&
    previous.candidates.length === current.candidates.length &&
    previous.candidates.every((candidate, index) => {
      const other = current.candidates[index];
      if (!other) return false;
      return (
        candidate.candidate === other.candidate &&
        candidate.index === other.index &&
        candidate.optionId === other.optionId &&
        candidate.login === other.login &&
        candidate.name === other.name &&
        candidate.avatarUrl === other.avatarUrl
      );
    })
  );
}

function snapshotAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) =>
        Object.freeze([name, value] as const),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotInputDom(node: Node): InputDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map(snapshotInputDom),
    ),
  });
}

function inputDomMatches(snapshot: InputDomSnapshot): boolean {
  const attributes = snapshotAttributes(snapshot.node);
  if (
    snapshot.node.nodeValue !== snapshot.nodeValue ||
    (attributes === null) !== (snapshot.attributes === null)
  ) {
    return false;
  }
  if (
    attributes &&
    snapshot.attributes &&
    (attributes.length !== snapshot.attributes.length ||
      attributes.some(([name, value], index) => {
        const expected = snapshot.attributes?.[index];
        return (
          !expected ||
          name !== expected[0] ||
          value !== expected[1]
        );
      }))
  ) {
    return false;
  }
  return (
    snapshot.node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        snapshot.node.childNodes.item(index) === child.node &&
        inputDomMatches(child),
    )
  );
}

function snapshotContains(
  snapshot: InputDomSnapshot,
  target: Node,
): boolean {
  return (
    snapshot.node === target ||
    snapshot.children.some((child) =>
      snapshotContains(child, target),
    )
  );
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    node.childNodes.forEach(visit);
  };
  visit(element);
  return Object.freeze(nodes);
}

function captureInputPlacement(
  root: HTMLDivElement,
): InputPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function inputPlacementMatches(
  root: HTMLDivElement,
  placement: InputPlacement,
) {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function isEffectivelyEnabled(element: HTMLElement) {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() ===
      "true"
  ) {
    return false;
  }
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() ===
        "true"
    ) {
      return false;
    }
  }
  return true;
}

function isReactEvent(
  event: object,
  reactName: string,
  type: string,
) {
  try {
    const candidate = event as {
      _reactName?: unknown;
      type?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      preventDefault?: unknown;
      stopPropagation?: unknown;
      persist?: unknown;
      isPersistent?: unknown;
    };
    return (
      candidate._reactName === reactName &&
      candidate.type === type &&
      typeof candidate.isDefaultPrevented === "function" &&
      typeof candidate.isPropagationStopped === "function" &&
      typeof candidate.preventDefault === "function" &&
      typeof candidate.stopPropagation === "function" &&
      typeof candidate.persist === "function" &&
      typeof candidate.isPersistent === "function"
    );
  } catch {
    return false;
  }
}

function createInputPublication(
  presentation: InputPresentation,
  cells: InputPublicationCells,
  context: InputPublicationContext,
  requestSuccessor: () => void,
): InputPublicationSet {
  const renderToken = Symbol("collaborator input render");
  cells.renderToken = renderToken;
  cells.renderBinding = presentation.binding;
  let currentRuntime: InputPublicationRuntime | null = null;
  let lastRuntime: InputPublicationRuntime | null = null;
  let successorRequested = false;
  const newlyMountedElements = new Set<HTMLElement>();

  const rootOwner = new InputElementOwner<HTMLDivElement>(
    onElementChange,
  );
  const inputOwner = new InputElementOwner<HTMLInputElement>(
    onElementChange,
  );
  const feedbackOwner = new InputElementOwner<HTMLDivElement>(
    onElementChange,
  );
  const retryOwner = new InputElementOwner<HTMLButtonElement>(
    onElementChange,
  );
  const listOwner = new InputElementOwner<HTMLUListElement>(
    onElementChange,
  );
  const rowOwners = presentation.candidates.map(
    () => new InputElementOwner<HTMLLIElement>(onElementChange),
  );

  function onElementChange(
    owner: InputElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) {
    if (element && !cells.seenElements.has(element)) {
      cells.seenElements.add(element);
      newlyMountedElements.add(element);
    }
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime &&
      (owner === rootOwner || owner === inputOwner) &&
      (element === null ||
        (element !== null && last !== null && element !== last)) &&
      cells.renderBinding !== presentation.binding
    ) {
      const query = context.coordinator.query();
      if (query?.binding === presentation.binding) {
        context.retireQuery(query);
      }
      if (
        context.coordinator.binding() === presentation.binding
      ) {
        context.coordinator.setBinding(null);
      }
    }
    if (
      runtime &&
      (runtime.isExactLayoutReplay() ||
        runtime.isExactElementReplay()) &&
      cells.successorOf === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  }

  const expectedOwners = (): readonly InputElementOwnerView[] => [
    rootOwner,
    inputOwner,
    ...(presentation.lookup ? [feedbackOwner] : []),
    ...(presentation.lookup?.status === "error"
      ? [retryOwner]
      : []),
    ...(presentation.expanded ? [listOwner, ...rowOwners] : []),
  ];

  const immutableFactsAreCurrent = () => {
    const cacheEntry = presentation.cacheKey
      ? context.coordinator.cache.get(presentation.cacheKey) ?? null
      : null;
    return (
      presentationFactsMatch(presentation) &&
      presentation.cacheEntry === cacheEntry &&
      presentation.picked === context.coordinator.picked() &&
      presentation.noToken === context.coordinator.noToken()
    );
  };

  const factsAreCurrent = () =>
    immutableFactsAreCurrent() &&
    context.coordinator.binding() === presentation.binding &&
    context.coordinator.query() === presentation.query &&
    context.coordinator.published() === presentation.sourceState &&
    (!presentation.query ||
      (!presentation.query.retired &&
        presentation.query.binding === presentation.binding &&
        presentation.query.scope === presentation.scope &&
        presentation.query.query === presentation.scope.query));

  const replayFactsAreCurrent = (
    runtime: InputPublicationRuntime,
  ) => {
    const replay = runtime.queryReplay();
    return (
      immutableFactsAreCurrent() &&
      context.coordinator.binding() === presentation.binding &&
      context.coordinator.published() === presentation.sourceState &&
      (replay
        ? replay.source === presentation.query &&
          replay.source.retired &&
          context.coordinator.query() === null
        : presentation.query === null &&
          context.coordinator.query() === null)
    );
  };

  const exactDomIsCurrent = (allowInputValue = false) => {
    if (!immutableFactsAreCurrent()) return false;
    const root = rootOwner.element();
    const input = inputOwner.element();
    const feedback = feedbackOwner.element();
    const retry = retryOwner.element();
    const list = listOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const lookup = presentation.lookup;
    if (
      !root ||
      !ownerDocument ||
      !ownerWindow ||
      !(root instanceof ownerWindow.HTMLDivElement) ||
      !root.isConnected ||
      !root.parentNode ||
      root.className !== "relative flex-1" ||
      !(root.firstElementChild instanceof
        ownerWindow.SVGElement) ||
      !root.firstElementChild.classList.contains(
        "lucide-user-plus",
      ) ||
      !(input instanceof ownerWindow.HTMLInputElement) ||
      !input.isConnected ||
      input.ownerDocument !== ownerDocument ||
      input.parentElement !== root ||
      root.children.item(1) !== input ||
      input.className !== "input pl-9" ||
      input.getAttribute("placeholder") !==
        "GitHub handle, e.g. octocat" ||
      input.getAttribute("aria-label") !== "GitHub handle" ||
      input.getAttribute("role") !== "combobox" ||
      input.getAttribute("aria-autocomplete") !== "list" ||
      input.getAttribute("aria-expanded") !==
        String(presentation.expanded) ||
      input.getAttribute("aria-controls") !==
        presentation.listId ||
      input.getAttribute("aria-activedescendant") !==
        (presentation.expanded &&
        presentation.activeIndex >= 0
          ? `${presentation.listId}-option-${presentation.activeIndex}`
          : null) ||
      input.getAttribute("aria-describedby") !==
        (lookup ? presentation.feedbackId : null) ||
      input.autocomplete !== "off" ||
      input.spellcheck ||
      input.dataset.testid !== "share-login" ||
      (!allowInputValue &&
        input.value !== presentation.scope.value) ||
      !isEffectivelyEnabled(input)
    ) {
      return false;
    }

    let rootIndex = 2;
    if (lookup) {
      if (
        !(feedback instanceof ownerWindow.HTMLDivElement) ||
        !feedback.isConnected ||
        feedback.ownerDocument !== ownerDocument ||
        feedback.parentElement !== root ||
        root.children.item(rootIndex++) !== feedback ||
        feedback.id !== presentation.feedbackId ||
        feedback.getAttribute("aria-atomic") !== "true" ||
        feedback.dataset.testid !==
          (lookup.status === "loading"
            ? "share-login-loading"
            : "share-login-error")
      ) {
        return false;
      }
      if (lookup.status === "loading") {
        if (
          feedback.className !==
            "mt-1 flex items-center gap-1.5 text-xs text-ink-3" ||
          feedback.getAttribute("role") !== "status" ||
          feedback.getAttribute("aria-live") !== "polite" ||
          feedback.textContent?.trim() !==
            `Loading GitHub suggestions for @${lookup.query.query}…` ||
          retry !== null
        ) {
          return false;
        }
      } else {
        const message = feedback.firstElementChild;
        if (
          feedback.className !==
            "mt-1 flex items-center gap-2 text-xs text-danger" ||
          feedback.getAttribute("role") !== "alert" ||
          feedback.children.length !== 2 ||
          !(message instanceof ownerWindow.HTMLSpanElement) ||
          message.className !== "min-w-0 flex-1" ||
          message.textContent !== lookup.message ||
          !(retry instanceof ownerWindow.HTMLButtonElement) ||
          !retry.isConnected ||
          retry.ownerDocument !== ownerDocument ||
          retry.parentElement !== feedback ||
          feedback.lastElementChild !== retry ||
          retry.type !== "button" ||
          retry.className !==
            "btn btn-outline btn-sm h-6 shrink-0 px-2" ||
          retry.disabled !== lookup.retrying ||
          retry.getAttribute("aria-busy") !==
            (lookup.retrying ? "true" : null) ||
          retry.textContent?.trim() !==
            (lookup.retrying ? "Retrying…" : "Retry") ||
          (!lookup.retrying && !isEffectivelyEnabled(retry))
        ) {
          return false;
        }
      }
    } else if (feedback !== null || retry !== null) {
      return false;
    }

    if (!presentation.expanded) {
      return (
        list === null &&
        rowOwners.every((owner) => owner.element() === null) &&
        root.children.length === rootIndex
      );
    }
    if (
      !(list instanceof ownerWindow.HTMLUListElement) ||
      !list.isConnected ||
      list.ownerDocument !== ownerDocument ||
      list.parentElement !== root ||
      root.children.item(rootIndex++) !== list ||
      root.children.length !== rootIndex ||
      list.id !== presentation.listId ||
      list.getAttribute("role") !== "listbox" ||
      list.getAttribute("aria-label") !==
        "Matching GitHub accounts" ||
      list.className !==
        "menu absolute left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto" ||
      list.dataset.testid !== "share-login-suggestions" ||
      list.children.length !== presentation.candidates.length
    ) {
      return false;
    }
    return presentation.candidates.every((candidate, index) => {
      const row = rowOwners[index]?.element();
      const avatar = row?.children.item(0);
      const portrait = avatar?.firstElementChild;
      const fallback = portrait?.children.item(0);
      const image = portrait?.children.item(1);
      const name =
        candidate.name === null ? null : row?.children.item(1);
      const login = row?.lastElementChild;
      return (
        candidate.index === index &&
        candidate.candidate ===
          presentation.state?.options.filter(
            (option) =>
              !presentation.scope.excluded.has(
                option.login.toLowerCase(),
              ),
          )[index] &&
        userFactsMatch(
          candidate.candidate,
          candidate.login,
          candidate.name,
          candidate.avatarUrl,
        ) &&
        !presentation.scope.excluded.has(
          candidate.login.toLowerCase(),
        ) &&
        row instanceof ownerWindow.HTMLLIElement &&
        row.isConnected &&
        row.ownerDocument === ownerDocument &&
        row.parentElement === list &&
        list.children.item(index) === row &&
        row.id === candidate.optionId &&
        row.getAttribute("role") === "option" &&
        row.getAttribute("aria-selected") ===
          String(index === presentation.activeIndex) &&
        row.className ===
          (index === presentation.activeIndex
            ? "menu-item py-1.5 bg-surface-3"
            : "menu-item py-1.5") &&
        row.dataset.testid === "share-login-option" &&
        row.dataset.login === candidate.login &&
        avatar instanceof ownerWindow.HTMLSpanElement &&
        avatar.getAttribute("aria-hidden") === "true" &&
        avatar.children.length === 1 &&
        portrait instanceof ownerWindow.HTMLSpanElement &&
        portrait.className === "avatar" &&
        portrait.title === candidate.login &&
        portrait.style.width === "20px" &&
        portrait.style.height === "20px" &&
        portrait.style.fontSize === "10px" &&
        portrait.children.length === 2 &&
        fallback instanceof ownerWindow.HTMLSpanElement &&
        image instanceof ownerWindow.HTMLImageElement &&
        fallback.hidden === !image.hidden &&
        fallback.textContent ===
          (fallback.hidden ? "" : initials(candidate.login)) &&
        image.getAttribute("src") ===
            candidate.avatarUrl &&
        image.alt === candidate.login &&
        image.width === 20 &&
        image.height === 20 &&
        image.className ===
            "h-full w-full object-cover" &&
        image.getAttribute("referrerpolicy") === "no-referrer" &&
        (candidate.name === null ||
          (name instanceof ownerWindow.HTMLSpanElement &&
            name.textContent === candidate.name)) &&
        login instanceof ownerWindow.HTMLSpanElement &&
        login.textContent === `@${candidate.login}`
      );
    });
  };

  const publishedElements = (
    publication: InputPublication,
  ): readonly HTMLElement[] => [
    publication.root,
    publication.input,
    ...(publication.feedback ? [publication.feedback] : []),
    ...(publication.retry ? [publication.retry] : []),
    ...(publication.list ? [publication.list] : []),
    ...publication.rows.map((row) => row.element),
  ];

  const requestReplaySuccessor = (
    runtime: InputPublicationRuntime,
  ) => {
    const dom = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !dom ||
      !placement ||
      cells.successorOf !== runtime.publication ||
      cells.consumedPublications.has(runtime.publication) ||
      !replayFactsAreCurrent(runtime) ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay = Object.freeze({
      source: runtime.publication,
      dom,
      placement,
      partialElements: runtime.partialReplayElements(),
      query: runtime.queryReplay(),
      unchanged: runtime.replayDomUnchanged,
      release: runtime.releaseReplayGuard,
    });
    requestSuccessor();
  };

  const createRuntime = (): InputPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const input = inputOwner.element();
    const feedback = feedbackOwner.element();
    const retry = retryOwner.element();
    const list = listOwner.element();
    const placement = root ? captureInputPlacement(root) : null;
    if (
      !root ||
      !input ||
      !placement ||
      (presentation.lookup ? !feedback : Boolean(feedback)) ||
      (presentation.lookup?.status === "error"
        ? !retry
        : Boolean(retry)) ||
      (presentation.expanded ? !list : Boolean(list)) ||
      rowOwners.some((owner) =>
        presentation.expanded
          ? !owner.element()
          : Boolean(owner.element()),
      )
    ) {
      return null;
    }
    const committedRoot: HTMLDivElement = root;
    const committedInput: HTMLInputElement = input;
    const committedPlacement: InputPlacement = placement;

    const identity = Symbol("collaborator input publication");
    const action = (
      kind: ActionKind,
      rowIndex: number | null = null,
    ): ActionPublication =>
      Object.freeze({
        identity: Symbol(`collaborator input ${kind}`),
        publicationIdentity: identity,
        kind,
        rowIndex,
      });
    const inputActions = Object.freeze({
      change: action("change"),
      focus: action("focus"),
      keydown: action("keydown"),
      blur: action("blur"),
      retry: action("retry"),
    });
    const rows = Object.freeze(
      (presentation.expanded ? presentation.candidates : []).map(
        (authority, index) => {
        const element = rowOwners[index]?.element();
        if (!element) {
          throw new Error(
            "Cannot publish a collaborator suggestion without its committed row",
          );
        }
        return Object.freeze({
          identity: Symbol("collaborator suggestion row"),
          publicationIdentity: identity,
          authority,
          element,
          down: action("row-down", index),
          enter: action("row-enter", index),
          click: action("row-click", index),
        });
        },
      ),
    );
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let domSnapshot: InputDomSnapshot | null = null;
    let publishedPlacement: InputPlacement | null = null;
    let replayRefs: InputRefReplay[] = [];
    let partialReplayOwners = new Set<InputElementOwnerView>();
    let invalidReplay = false;
    let retiredQuery: QueryReplay | null = null;
    let initialReactReconciliation = true;

    const publication: InputPublication = Object.freeze({
      identity,
      presentation,
      ownerDocument: root.ownerDocument,
      root,
      input,
      feedback: presentation.lookup ? feedback : null,
      retry:
        presentation.lookup?.status === "error" ? retry : null,
      list: presentation.expanded ? list : null,
      rows,
      rootTargets: descendantsOf(root),
      inputTargets: descendantsOf(input),
      retryTargets: retry ? descendantsOf(retry) : Object.freeze([]),
      retire: () => retire("other"),
      isRetired: () => retired,
      ownsQuery: (query: QueryAuthority) =>
        currentRuntime === runtime &&
        !retired &&
        cells.active === publication &&
        context.coordinator.binding() === presentation.binding &&
        context.coordinator.query() === query &&
        query.binding === presentation.binding &&
        query.scope === presentation.scope &&
        query.query === presentation.scope.query &&
        !query.retired &&
        factsAreCurrent() &&
        exactDomIsCurrent() &&
        publishedDomMatches(),
    });

    const mutationIsRelevant = (record: MutationRecord) => {
      if (
        record.target === root ||
        root.contains(record.target)
      ) {
        return true;
      }
      if (
        record.type === "attributes" &&
        (record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "disabled") &&
        record.target instanceof Element &&
        record.target.contains(root)
      ) {
        return true;
      }
      if (record.type !== "childList") return false;
      if (
        publishedPlacement &&
        record.target === publishedPlacement.parent
      ) {
        return true;
      }
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node === root ||
          (node instanceof Element &&
            (node.contains(root) || root.contains(node))),
      );
    };
    const recordMutations = (
      records: readonly MutationRecord[],
      allowControlledChange = false,
    ) => {
      let exactReactCommit =
        initialReactReconciliation && records.length >= 2;
      for (
        let index = 0;
        exactReactCommit && index < records.length;
      ) {
        const start = records[index++];
        if (
          start?.type !== "attributes" ||
          start.target !== committedInput ||
          start.attributeName !== "name" ||
          start.oldValue !== null
        ) {
          exactReactCommit = false;
          break;
        }
        const value = records[index];
        if (
          value?.type === "attributes" &&
          value.target === committedInput &&
          value.attributeName === "value"
        ) {
          index += 1;
        }
        const end = records[index++];
        if (
          end?.type !== "attributes" ||
          end.target !== committedInput ||
          end.attributeName !== "name" ||
          end.oldValue !== ""
        ) {
          exactReactCommit = false;
        }
      }
      if (records.length > 0) {
        initialReactReconciliation = false;
      }
      exactReactCommit =
        exactReactCommit && !committedInput.hasAttribute("name");
      if (
        !domChanged &&
        records.some(
          (record) =>
            mutationIsRelevant(record) &&
            !(
              allowControlledChange &&
              record.type === "attributes" &&
              record.target === committedInput &&
              (record.attributeName === "name" ||
                record.attributeName === "value")
            ) &&
            !(
              exactReactCommit &&
              record.type === "attributes" &&
              record.target === committedInput &&
              record.attributeName === "name"
            ),
        )
      ) {
        domChanged = true;
      }
      return domChanged;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (
        recordMutations(
          records,
          context.coordinator.reactEvent() !== null,
        )
      )
        retire("element");
    };
    const captureQueryReplay = () => {
      if (
        retiredQuery ||
        cells.renderToken !== renderToken ||
        context.coordinator.binding() !== presentation.binding
      ) {
        return;
      }
      const query = context.coordinator.query();
      if (
        !query ||
        query !== presentation.query ||
        query.retired
      ) {
        return;
      }
      const hadRequest = Boolean(query.request);
      const hadTimer = Boolean(query.timer?.pending);
      retiredQuery = Object.freeze({
        source: query,
        mode:
          hadRequest || query.mode === "immediate"
            ? "immediate"
            : "debounce",
        settled: query.started && !hadRequest && !hadTimer,
      });
      context.coordinator.setQueryReplay(query, retiredQuery);
      context.retireQuery(query);
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) {
        recordMutations(domObserver.takeRecords());
      }
      retired = true;
      retirement = reason;
      const wasActive = cells.active === publication;
      if (wasActive) {
        captureQueryReplay();
        cells.active = null;
        cells.successorOf = publication;
      }
      cells.retiredPublications.add(publication);
      for (const row of rows) {
        cells.retiredRows.add(row);
        cells.retiredActions.add(row.down);
        cells.retiredActions.add(row.enter);
        cells.retiredActions.add(row.click);
      }
      Object.values(inputActions).forEach((ownedAction) =>
        cells.retiredActions.add(ownedAction),
      );
      if (currentRuntime?.publication === publication) {
        currentRuntime = null;
      }
      if (reason === "layout" || reason === "element") {
        queueMicrotask(() => {
          if (domObserver) {
            recordMutations(domObserver.takeRecords());
            domChanged = true;
            domObserver.disconnect();
            domObserver = null;
          }
          if (
            cells.active === null &&
            cells.successorOf === publication &&
            context.coordinator.binding() ===
              presentation.binding
          ) {
            const query = context.coordinator.query();
            if (query?.binding === presentation.binding) {
              context.retireQuery(query);
            }
            context.coordinator.setBinding(null);
          }
        });
      } else {
        releaseReplayGuard();
      }
      return wasActive;
    };
    const publishedDomMatches = (allowInputValue = false) => {
      if (domObserver) {
        if (
          recordMutations(
            domObserver.takeRecords(),
            allowInputValue ||
              context.coordinator.reactEvent() !== null,
          )
        ) {
          retire("element");
        }
      }
      return Boolean(
        !domChanged &&
          domSnapshot &&
          publishedPlacement &&
          rootOwner.element() === root &&
          inputOwner.element() === input &&
          root.isConnected &&
          inputPlacementMatches(root, publishedPlacement) &&
          inputDomMatches(domSnapshot) &&
          exactDomIsCurrent(allowInputValue),
      );
    };
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactPartialReplay = () =>
      !invalidReplay &&
      partialReplayOwners.size > 0 &&
      replayRefs.every(
        (entry) =>
          entry.owner.element() === entry.element &&
          (partialReplayOwners.has(entry.owner)
            ? entry.detached && entry.reattached
            : !entry.detached && !entry.reattached),
      );

    const runtime: ActiveRuntime = Object.freeze({
      publication,
      publish: (
        nextDom: InputDomSnapshot,
        nextPlacement: InputPlacement,
        owners: readonly InputElementOwnerView[],
        partialReplayElements: ReadonlySet<HTMLElement>,
      ) => {
        established = true;
        domSnapshot = nextDom;
        publishedPlacement = nextPlacement;
        replayRefs = owners.map((owner: InputElementOwnerView) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish CollaboratorLoginInput without every committed ref",
            );
          }
          return {
            owner,
            element,
            detached: false,
            reattached: false,
          };
        });
        partialReplayOwners = new Set(
          replayRefs
            .filter(({ element }) =>
              partialReplayElements.has(element),
            )
            .map(({ owner }) => owner),
        );
        cells.active = publication;
        cells.successorOf = null;
        cells.replay = null;
        const MutationObserverConstructor =
          publication.ownerDocument.defaultView?.MutationObserver;
        if (!MutationObserverConstructor) {
          throw new Error(
            "Cannot publish CollaboratorLoginInput without a DOM mutation observer",
          );
        }
        domObserver = new MutationObserverConstructor((records) => {
          noteMutations(records);
        });
        domObserver.observe(publication.ownerDocument, {
          attributeOldValue: true,
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: InputElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find(
          (entry) => entry.owner === owner,
        );
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (
          element === null &&
          previous === proof.element &&
          proof.element.isConnected
        ) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached &&
          proof.element.isConnected
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      layoutWasRetired: () => layoutRetired,
      isRetired: () => retired,
      publishedDomMatches,
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        established &&
        (layoutRetired
          ? refsHaveExactReplay()
          : refsHaveExactPartialReplay()) &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      replayDomUnchanged: () => {
        if (!domObserver) return false;
        recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
            domSnapshot &&
            publishedPlacement &&
            committedRoot.isConnected &&
            inputPlacementMatches(
              committedRoot,
              publishedPlacement,
            ) &&
            inputDomMatches(domSnapshot),
        );
      },
      releaseReplayGuard,
      snapshot: () => domSnapshot,
      placement: () => publishedPlacement,
      partialReplayElements: () =>
        new Set(
          replayRefs
            .filter(({ owner }) =>
              partialReplayOwners.has(owner),
            )
            .map(({ element }) => element),
        ),
      queryReplay: () => retiredQuery,
      inputActions,
      continuationIsCurrent,
      nativeChange,
      nativeFocus,
      nativeKey,
      nativeMouse,
      candidateIsCurrent,
      claim,
      updateState,
      pick,
      cancelLookup,
    });

    function continuationIsCurrent() {
      return (
        cells.active === publication &&
        !publication.isRetired() &&
        context.coordinator.binding() ===
          presentation.binding &&
        committedRoot.isConnected &&
        committedInput.isConnected &&
        rootOwner.element() === committedRoot &&
        inputOwner.element() === committedInput &&
        inputPlacementMatches(
          committedRoot,
          committedPlacement,
        )
      );
    }

    function nativeEventBase(
      event:
        | ChangeEvent<HTMLInputElement>
        | FocusEvent<HTMLInputElement>
        | FocusEvent<HTMLInputElement | HTMLButtonElement>
        | FocusEvent<HTMLButtonElement>
        | FocusEvent<HTMLDivElement>
        | KeyboardEvent<HTMLInputElement>
        | MouseEvent<HTMLButtonElement>
        | MouseEvent<HTMLLIElement>,
      reactName: string,
      syntheticType: string,
      currentTarget: HTMLElement,
      targets: readonly Node[],
    ): Event | null {
      if (
        !event ||
        typeof event !== "object" ||
        !isReactEvent(event, reactName, syntheticType)
      ) {
        return null;
      }
      const ownerWindow =
        publication.ownerDocument.defaultView;
      const nativeEvent = event.nativeEvent;
      const target = event.target;
      if (
        !ownerWindow ||
        !(nativeEvent instanceof ownerWindow.Event) ||
        nativeEvent.eventPhase === ownerWindow.Event.NONE ||
        event.currentTarget !== currentTarget ||
        nativeEvent.target !== target ||
        !(target instanceof ownerWindow.Node) ||
        target.ownerDocument !== publication.ownerDocument ||
        !targets.includes(target) ||
        !nativeEvent.composedPath().includes(currentTarget) ||
        !nativeEvent.composedPath().includes(committedRoot) ||
        event.defaultPrevented ||
        nativeEvent.defaultPrevented
      ) {
        return null;
      }
      const snapshot = runtime.snapshot();
      return snapshot && snapshotContains(snapshot, target)
        ? nativeEvent
        : null;
    }

    function nativeChange(
      event: ChangeEvent<HTMLInputElement>,
    ) {
      const nativeEvent = nativeEventBase(
        event,
        "onChange",
        "change",
        committedInput,
        publication.inputTargets,
      );
      const ownerWindow =
        publication.ownerDocument.defaultView;
      return nativeEvent &&
        ownerWindow &&
        (nativeEvent.type === "input" ||
          nativeEvent.type === "change")
        ? nativeEvent
        : null;
    }

    function nativeFocus(
      event:
        | FocusEvent<HTMLInputElement>
        | FocusEvent<HTMLInputElement | HTMLButtonElement>
        | FocusEvent<HTMLDivElement>,
      reactName: "onFocus" | "onBlur",
      syntheticType: "focus" | "blur",
      currentTarget: HTMLElement,
      targets: readonly Node[],
    ) {
      const nativeEvent = nativeEventBase(
        event,
        reactName,
        syntheticType,
        currentTarget,
        targets,
      );
      const ownerWindow =
        publication.ownerDocument.defaultView;
      if (
        !nativeEvent ||
        !ownerWindow ||
        !(nativeEvent instanceof ownerWindow.FocusEvent) ||
        (syntheticType === "focus"
          ? nativeEvent.type !== "focusin" &&
            nativeEvent.type !== "focus"
          : nativeEvent.type !== "focusout" &&
            nativeEvent.type !== "blur") ||
        nativeEvent.relatedTarget !== event.relatedTarget
      ) {
        return null;
      }
      return nativeEvent;
    }

    function nativeKey(
      event: KeyboardEvent<HTMLInputElement>,
    ) {
      const nativeEvent = nativeEventBase(
        event,
        "onKeyDown",
        "keydown",
        committedInput,
        publication.inputTargets,
      );
      const ownerWindow =
        publication.ownerDocument.defaultView;
      return nativeEvent &&
        ownerWindow &&
        nativeEvent instanceof ownerWindow.KeyboardEvent &&
        nativeEvent.type === "keydown" &&
        nativeEvent.key === event.key &&
        nativeEvent.altKey === event.altKey &&
        nativeEvent.ctrlKey === event.ctrlKey &&
        nativeEvent.metaKey === event.metaKey &&
        nativeEvent.shiftKey === event.shiftKey
        ? nativeEvent
        : null;
    }

    function nativeMouse(
      event:
        | MouseEvent<HTMLButtonElement>
        | MouseEvent<HTMLLIElement>,
      reactName: "onClick" | "onMouseDown" | "onMouseOver",
      syntheticType: "click" | "mousedown" | "mouseover",
      currentTarget: HTMLElement,
      targets: readonly Node[],
      nativeTypes: readonly string[],
    ) {
      const nativeEvent = nativeEventBase(
        event,
        reactName,
        syntheticType,
        currentTarget,
        targets,
      );
      const ownerWindow =
        publication.ownerDocument.defaultView;
      return nativeEvent &&
        ownerWindow &&
        nativeEvent instanceof ownerWindow.MouseEvent &&
        nativeTypes.includes(nativeEvent.type) &&
        nativeEvent.button === event.button
        ? nativeEvent
        : null;
    }

    function candidateIsCurrent(
      row: InputRowPublication | null,
      ownedAction: ActionPublication,
      allowInputValue = false,
    ) {
      return (
        currentRuntime === runtime &&
        !runtime.isRetired() &&
        !publication.isRetired() &&
        cells.active === publication &&
        publication.presentation === presentation &&
        ownedAction.publicationIdentity === publication.identity &&
        !cells.retiredPublications.has(publication) &&
        !cells.retiredActions.has(ownedAction) &&
        !cells.claimedPublications.has(publication) &&
        !cells.claimedActions.has(ownedAction) &&
        (row === null
          ? ownedAction.rowIndex === null
          : publication.rows[row.authority.index] === row &&
            presentation.candidates[row.authority.index] ===
              row.authority &&
            row.publicationIdentity === publication.identity &&
            (ownedAction.rowIndex === row.authority.index ||
              (ownedAction.kind === "keydown" &&
                ownedAction.rowIndex === null)) &&
            !cells.retiredRows.has(row) &&
            !cells.claimedRows.has(row)) &&
        factsAreCurrent() &&
        exactDomIsCurrent(allowInputValue) &&
        runtime.publishedDomMatches(allowInputValue)
      );
    }

    function claim(
      row: InputRowPublication | null,
      ownedAction: ActionPublication,
      reactEvent: object,
      nativeEvent: Event,
      allowInputValue = false,
    ) {
      const query = presentation.query;
      if (
        !candidateIsCurrent(
          row,
          ownedAction,
          allowInputValue,
        ) ||
        !cells.deliveredReactEvents.has(reactEvent) ||
        cells.claimedReactEvents.has(reactEvent) ||
        cells.claimedNativeEvents.has(nativeEvent) ||
        (query && cells.claimedQueries.has(query))
      ) {
        return null;
      }
      cells.claimedPublications.add(publication);
      if (row) cells.claimedRows.add(row);
      cells.claimedActions.add(ownedAction);
      if (query) cells.claimedQueries.add(query);
      cells.claimedReactEvents.add(reactEvent);
      cells.claimedNativeEvents.add(nativeEvent);
      cells.consumedPublications.add(publication);
      context.coordinator.beginReactEvent(nativeEvent);
      return {
        release: () => {
          cells.claimedPublications.delete(publication);
          if (row) cells.claimedRows.delete(row);
          cells.claimedActions.delete(ownedAction);
          if (query) cells.claimedQueries.delete(query);
        },
      };
    }

    function updateState(
      update: (state: PublishedState) => PublishedState,
    ) {
      const source = presentation.state;
      if (!source) return false;
      return context.replacePublished(
        presentation.sourceState,
        update(source),
      );
    }

    function pick(row: InputRowPublication) {
      const state = presentation.state;
      if (!state) return;
      context.coordinator.setPicked(row.authority.login);
      context.replacePublished(
        presentation.sourceState,
        freezePublished({
          ...state,
          query: null,
          open: false,
          active: -1,
          lookup: null,
        }),
      );
      presentation.scope.onChange(row.authority.login);
      if (!continuationIsCurrent()) return;
      presentation.scope.onPick?.(row.authority.login);
      if (!continuationIsCurrent()) return;
      const query = context.coordinator.query();
      if (query?.binding === presentation.binding) {
        context.retireQuery(query);
      }
    }

    function cancelLookup() {
      const state = presentation.state;
      if (!state) return;
      const query = context.coordinator.query();
      if (query?.binding === presentation.binding) {
        context.retireQuery(query);
      }
      context.replacePublished(
        presentation.sourceState,
        freezePublished({
          ...state,
          query: null,
          open: false,
          active: -1,
          lookup: null,
        }),
      );
    }

    return runtime;
  };

  type ActiveRuntime = InputPublicationRuntime & {
    inputActions: Readonly<
      Record<"change" | "focus" | "keydown" | "blur" | "retry", ActionPublication>
    >;
    continuationIsCurrent: () => boolean;
    nativeChange: (
      event: ChangeEvent<HTMLInputElement>,
    ) => Event | null;
    nativeFocus: (
      event:
        | FocusEvent<HTMLInputElement>
        | FocusEvent<HTMLInputElement | HTMLButtonElement>
        | FocusEvent<HTMLDivElement>,
      reactName: "onFocus" | "onBlur",
      syntheticType: "focus" | "blur",
      currentTarget: HTMLElement,
      targets: readonly Node[],
    ) => Event | null;
    nativeKey: (
      event: KeyboardEvent<HTMLInputElement>,
    ) => Event | null;
    nativeMouse: (
      event:
        | MouseEvent<HTMLButtonElement>
        | MouseEvent<HTMLLIElement>,
      reactName: "onClick" | "onMouseDown" | "onMouseOver",
      syntheticType: "click" | "mousedown" | "mouseover",
      currentTarget: HTMLElement,
      targets: readonly Node[],
      nativeTypes: readonly string[],
    ) => Event | null;
    candidateIsCurrent: (
      row: InputRowPublication | null,
      action: ActionPublication,
      allowInputValue?: boolean,
    ) => boolean;
    claim: (
      row: InputRowPublication | null,
      action: ActionPublication,
      reactEvent: object,
      nativeEvent: Event,
      allowInputValue?: boolean,
    ) => { release: () => void } | null;
    updateState: (
      update: (state: PublishedState) => PublishedState,
    ) => boolean;
    pick: (row: InputRowPublication) => void;
    cancelLookup: () => void;
  };

  const activeRuntime = () =>
    currentRuntime as ActiveRuntime | null;

  const pendingReactDeliveries = new WeakMap<
    Event,
    Map<object, () => void>
  >();

  const stageReactDelivery = (
    event: object,
    nativeEvent: Event,
    run: () => void,
  ) => {
    const pending =
      pendingReactDeliveries.get(nativeEvent) ??
      new Map<object, () => void>();
    if (!pendingReactDeliveries.has(nativeEvent)) {
      pendingReactDeliveries.set(nativeEvent, pending);
    }
    if (!pending.has(event)) pending.set(event, run);
  };

  const deliverReactEvent = (
    event: object,
    reactName: string,
    type: string,
  ) => {
    const runtime = activeRuntime();
    const publication = runtime?.publication;
    if (!runtime || !publication || !isReactEvent(event, reactName, type)) {
      return;
    }
    const ownerWindow = publication.ownerDocument.defaultView;
    const candidate = event as {
      currentTarget?: unknown;
      nativeEvent?: unknown;
    };
    const nativeEvent = candidate.nativeEvent;
    const currentTarget = candidate.currentTarget;
    if (
      ownerWindow &&
      nativeEvent instanceof ownerWindow.Event &&
      nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
      currentTarget === publication.root &&
      nativeEvent.composedPath().includes(publication.root)
    ) {
      const pending = pendingReactDeliveries.get(nativeEvent);
      pendingReactDeliveries.delete(nativeEvent);
      const run = pending?.get(event);
      if (run) {
        cells.deliveredReactEvents.add(event);
        run();
      }
    }
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (
      !immutableFactsAreCurrent() ||
      !exactDomIsCurrent()
    ) {
      return undefined;
    }

    if (
      context.coordinator.binding() !== presentation.binding
    ) {
      const previous = context.coordinator.query();
      if (previous) context.retireQuery(previous);
      context.coordinator.setBinding(presentation.binding);
      const query = context.makeQuery(presentation.binding);
      context.coordinator.setQuery(query);
      context.replacePublished(
        presentation.sourceState,
        freezePublished({
          scope: presentation.scope,
          query,
          options: Object.freeze([]),
          open: false,
          active: -1,
          lookup: query
            ? freezeLookup({ query, status: "loading" })
            : null,
        }),
      );
      return undefined;
    }

    const root = rootOwner.element();
    const placement = root
      ? captureInputPlacement(root)
      : null;
    if (!root || !placement) return undefined;

    const replay = cells.replay;
    const retiredSource = presentation.query;
    const retiredReplay =
      retiredSource?.retired && !replay
        ? context.coordinator.queryReplay(retiredSource)
        : null;
    if (
      retiredSource &&
      retiredReplay &&
      retiredReplay.source === retiredSource &&
      presentation.sourceState?.query === retiredSource &&
      context.coordinator.binding() === presentation.binding &&
      context.coordinator.query() === null &&
      context.coordinator.published() ===
        presentation.sourceState
    ) {
      const next = context.makeQuery(
        presentation.binding,
        retiredReplay.mode,
        retiredReplay.settled,
      );
      if (!next) return undefined;
      context.coordinator.setQuery(next);
      const lookup = presentation.sourceState.lookup
        ? presentation.sourceState.lookup.status === "loading"
          ? freezeLookup({ query: next, status: "loading" })
          : freezeLookup({
              query: next,
              status: "error",
              message: presentation.sourceState.lookup.message,
              retrying:
                presentation.sourceState.lookup.retrying,
            })
        : null;
      if (
        !context.replacePublished(
          presentation.sourceState,
          freezePublished({
            ...presentation.sourceState,
            query: next,
            lookup,
          }),
        )
      ) {
        context.retireQuery(next);
      }
      return undefined;
    }
    if (replay) {
      const sameFacts = presentationsMatch(
        replay.source.presentation,
        presentation,
      );
      const exactReplay =
        cells.successorOf === replay.source &&
        !cells.consumedPublications.has(replay.source) &&
        sameFacts &&
        replay.dom.node === root &&
        inputPlacementMatches(root, replay.placement) &&
        inputDomMatches(replay.dom) &&
        replay.unchanged();
      replay.release();
      cells.replay = null;
      if (cells.successorOf === replay.source) {
        cells.successorOf = null;
      }
      if (!exactReplay) {
        if (!sameFacts) {
          // A different render generation is independent of the rejected replay.
        } else {
          return undefined;
        }
      } else if (replay.query) {
        const source = replay.query.source;
        const state = presentation.sourceState;
        if (
          presentation.query !== source ||
          !source.retired ||
          context.coordinator.query() !== null ||
          !state ||
          state.query !== source
        ) {
          return undefined;
        }
        const next = context.makeQuery(
          presentation.binding,
          replay.query.mode,
          replay.query.settled,
        );
        if (!next) return undefined;
        context.coordinator.setQuery(next);
        const lookup = state.lookup
          ? state.lookup.status === "loading"
            ? freezeLookup({ query: next, status: "loading" })
            : freezeLookup({
                query: next,
                status: "error",
                message: state.lookup.message,
                retrying: state.lookup.retrying,
              })
          : null;
        if (
          !context.replacePublished(
            state,
            freezePublished({
              ...state,
              query: next,
              lookup,
            }),
          )
        ) {
          context.retireQuery(next);
        }
        return undefined;
      }
    }

    if (!factsAreCurrent()) return undefined;
    const runtime = createRuntime();
    if (!runtime) return undefined;
    const publication = runtime.publication;
    const previous = cells.active;
    const predecessor = previous ?? cells.successorOf;
    const predecessorElements = new Set<HTMLElement>(
      predecessor?.presentation.mount === presentation.mount
        ? publishedElements(predecessor)
        : [],
    );
    const partialReplayElements = new Set<HTMLElement>(
      expectedOwners()
        .map((owner) => owner.element())
        .filter(
          (element): element is HTMLElement =>
            Boolean(
              element &&
                ((predecessor
                  ? !predecessorElements.has(element)
                  : newlyMountedElements.has(element)) ||
                  replay?.partialElements.has(element)),
            ),
        ),
    );
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotInputDom(root),
      placement,
      expectedOwners(),
      partialReplayElements,
    );
    return runtime.retireForLayout;
  };

  const deliverChange = (event: ChangeEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onChange", "change");
  };
  const deliverFocus = (event: FocusEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onFocus", "focus");
  };
  const deliverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onKeyDown", "keydown");
  };
  const deliverBlur = (event: FocusEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onBlur", "blur");
  };
  const deliverClick = (event: MouseEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onClick", "click");
  };
  const deliverMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onMouseDown", "mousedown");
  };
  const deliverMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    deliverReactEvent(event, "onMouseOver", "mouseover");
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const runtime = activeRuntime();
    if (!runtime) return;
    const nativeEvent = runtime.nativeChange(event);
    if (!nativeEvent) return;
    const value = event.currentTarget.value;
    stageReactDelivery(event, nativeEvent, () => {
      const claim = runtime.claim(
        null,
        runtime.inputActions.change,
        event,
        nativeEvent,
        true,
      );
      if (!claim) return;
      try {
        context.coordinator.setPicked(null);
        presentation.scope.onChange(value);
      } finally {
        claim.release();
      }
    });
  };

  const onFocus = (event: FocusEvent<HTMLInputElement>) => {
    const runtime = activeRuntime();
    const publication = runtime?.publication;
    if (
      !runtime ||
      !publication ||
      presentation.candidates.length === 0 ||
      publication.ownerDocument.activeElement !== publication.input
    ) {
      return;
    }
    const nativeEvent = runtime.nativeFocus(
      event,
      "onFocus",
      "focus",
      publication.input,
      publication.inputTargets,
    );
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      const claim = runtime.claim(
        null,
        runtime.inputActions.focus,
        event,
        nativeEvent,
      );
      if (!claim) return;
      try {
        runtime.updateState((state) =>
          freezePublished({ ...state, open: true }),
        );
      } finally {
        claim.release();
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const runtime = activeRuntime();
    const publication = runtime?.publication;
    if (!runtime || !publication) return;
    const isArrow =
      event.key === "ArrowDown" || event.key === "ArrowUp";
    const isPick =
      event.key === "Enter" &&
      presentation.expanded &&
      presentation.activeIndex >= 0;
    const isDismiss =
      event.key === "Escape" && presentation.expanded;
    if (
      (!isArrow || presentation.candidates.length === 0) &&
      !isPick &&
      !isDismiss
    ) {
      return;
    }
    const row = isPick
      ? publication.rows[presentation.activeIndex] ?? null
      : null;
    if (isPick && !row) return;
    const nativeEvent = runtime.nativeKey(event);
    if (!nativeEvent) return;
    const key = event.key;
    stageReactDelivery(event, nativeEvent, () => {
      const claim = runtime.claim(
        row,
        runtime.inputActions.keydown,
        event,
        nativeEvent,
      );
      if (!claim) return;
      try {
        if (isArrow) {
          event.preventDefault();
          const count = presentation.candidates.length;
          runtime.updateState((state) =>
            freezePublished({
              ...state,
              open: true,
              active:
                key === "ArrowDown"
                  ? (presentation.activeIndex + 1) % count
                  : presentation.activeIndex <= 0
                    ? count - 1
                    : presentation.activeIndex - 1,
            }),
          );
        } else if (row) {
          event.preventDefault();
          runtime.pick(row);
        } else {
          event.preventDefault();
          runtime.updateState((state) =>
            freezePublished({
              ...state,
              open: false,
              active: -1,
            }),
          );
        }
      } finally {
        claim.release();
      }
    });
  };

  const onBlur = (
    event: FocusEvent<HTMLInputElement | HTMLButtonElement>,
  ) => {
    const runtime = activeRuntime();
    const publication = runtime?.publication;
    if (!runtime || !publication) return;
    const related = event.relatedTarget;
    const ownerWindow =
      publication.ownerDocument.defaultView;
    if (
      ownerWindow &&
      related instanceof ownerWindow.Node &&
      publication.root.contains(related)
    ) {
      return;
    }
    const currentTarget = event.currentTarget;
    const targets =
      currentTarget === publication.input
        ? publication.inputTargets
        : currentTarget === publication.retry
          ? publication.retryTargets
          : null;
    if (!targets) return;
    const nativeEvent = runtime.nativeFocus(
      event,
      "onBlur",
      "blur",
      currentTarget,
      targets,
    );
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      const claim = runtime.claim(
        null,
        runtime.inputActions.blur,
        event,
        nativeEvent,
      );
      if (!claim) return;
      try {
        runtime.cancelLookup();
      } finally {
        claim.release();
      }
    });
  };

  const onRetry = (event: MouseEvent<HTMLButtonElement>) => {
    const runtime = activeRuntime();
    const publication = runtime?.publication;
    const retry = publication?.retry;
    const error =
      presentation.lookup?.status === "error"
        ? presentation.lookup
        : null;
    if (
      !runtime ||
      !publication ||
      !retry ||
      !error ||
      retry.disabled ||
      error.retrying ||
      error.query.request ||
      context.coordinator.noToken()
    ) {
      return;
    }
    const nativeEvent = runtime.nativeMouse(
      event,
      "onClick",
      "click",
      retry,
      publication.retryTargets,
      ["click"],
    );
    if (!nativeEvent) return;
    stageReactDelivery(event, nativeEvent, () => {
      const claim = runtime.claim(
        null,
        runtime.inputActions.retry,
        event,
        nativeEvent,
      );
      if (!claim) return;
      try {
        publication.input.focus();
        if (!runtime.continuationIsCurrent()) return;
        context.retireQuery(error.query);
        const next = context.makeQuery(
          presentation.binding,
          "immediate",
        );
        if (!next) return;
        context.coordinator.setQuery(next);
        const state = presentation.state;
        if (
          !state ||
          !context.replacePublished(
            presentation.sourceState,
            freezePublished({
              scope: presentation.scope,
              query: next,
              options: Object.freeze([]),
              open: false,
              active: -1,
              lookup: freezeLookup({
                query: next,
                status: "error",
                message: error.message,
                retrying: true,
              }),
            }),
          )
        ) {
          context.retireQuery(next);
        }
      } finally {
        claim.release();
      }
    });
  };

  const rows = presentation.candidates.map((candidate, index) => ({
    capture: rowOwners[index]!.capture,
    onMouseDown: (event: MouseEvent<HTMLLIElement>) => {
      const runtime = activeRuntime();
      const publication = runtime?.publication;
      const row = publication?.rows[index];
      if (
        !runtime ||
        !publication ||
        !row ||
        row.authority !== candidate
      ) {
        return;
      }
      const nativeEvent = runtime.nativeMouse(
        event,
        "onMouseDown",
        "mousedown",
        row.element,
        descendantsOf(row.element),
        ["mousedown"],
      );
      if (!nativeEvent) return;
      stageReactDelivery(event, nativeEvent, () => {
        const claim = runtime.claim(
          row,
          row.down,
          event,
          nativeEvent,
        );
        if (!claim) return;
        try {
          event.preventDefault();
        } finally {
          claim.release();
        }
      });
    },
    onMouseOver: (event: MouseEvent<HTMLLIElement>) => {
      const runtime = activeRuntime();
      const publication = runtime?.publication;
      const row = publication?.rows[index];
      if (
        !runtime ||
        !publication ||
        !row ||
        row.authority !== candidate
      ) {
        return;
      }
      const nativeEvent = runtime.nativeMouse(
        event,
        "onMouseOver",
        "mouseover",
        row.element,
        descendantsOf(row.element),
        ["mouseover"],
      );
      if (!nativeEvent) return;
      stageReactDelivery(event, nativeEvent, () => {
        const claim = runtime.claim(
          row,
          row.enter,
          event,
          nativeEvent,
        );
        if (!claim) return;
        try {
          runtime.updateState((state) =>
            freezePublished({ ...state, active: index }),
          );
        } finally {
          claim.release();
        }
      });
    },
    onClick: (event: MouseEvent<HTMLLIElement>) => {
      const runtime = activeRuntime();
      const publication = runtime?.publication;
      const row = publication?.rows[index];
      if (
        !runtime ||
        !publication ||
        !row ||
        row.authority !== candidate
      ) {
        return;
      }
      const nativeEvent = runtime.nativeMouse(
        event,
        "onClick",
        "click",
        row.element,
        descendantsOf(row.element),
        ["click"],
      );
      if (!nativeEvent) return;
      stageReactDelivery(event, nativeEvent, () => {
        const claim = runtime.claim(
          row,
          row.click,
          event,
          nativeEvent,
        );
        if (!claim) return;
        try {
          runtime.pick(row);
        } finally {
          claim.release();
        }
      });
    },
  }));

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureInput: inputOwner.capture,
    captureFeedback: feedbackOwner.capture,
    captureRetry: retryOwner.capture,
    captureList: listOwner.capture,
    rows: Object.freeze(rows),
    establish,
    deliverChange,
    deliverFocus,
    deliverKeyDown,
    deliverBlur,
    deliverClick,
    deliverMouseDown,
    deliverMouseOver,
    onChange,
    onFocus,
    onKeyDown,
    onBlur,
    onRetry,
  });
}

/**
 * The Share dialog's handle box with GitHub-account suggestions: an ARIA combobox over a listbox of
 * up to eight `@login`s that appears once two login characters have settled for 250 ms. ↓/↑ move,
 * Enter picks the active option (with none active it submits the typed handle as before), Escape
 * closes the list (the dialog stays open), a click picks. Picking fills the box and calls `onPick` so
 * the owner lands on the role select and still presses Add. Temporary lookup failures leave exact
 * handles usable and offer one guarded retry instead of looking like a truthful empty result.
 * A session without a GitHub token (`reason: "no-github-token"`) is remembered for the life of the
 * box: it asks no more and stays a plain text field.
 */
export function CollaboratorLoginInput({
  value,
  onChange,
  exclude,
  onPick,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Logins already listed (owner and collaborators): never suggested again. */
  exclude: string[];
  /** After a suggestion filled the box; the dialog moves focus on to the role select. */
  onPick?: (login: string) => void;
}) {
  const listId = useId();
  const feedbackId = `${listId}-feedback`;
  const queryText = suggestQuery(value);
  const exclusionKey = [
    ...new Set(
      exclude
        .map((login) =>
          login.trim().replace(/^@/, "").toLowerCase(),
        )
        .filter(Boolean),
    ),
  ]
    .sort()
    .join("\0");
  const excluded = useMemo<ReadonlySet<string>>(
    () =>
      new Set(exclusionKey ? exclusionKey.split("\0") : []),
    [exclusionKey],
  );
  const scope = useMemo<InputScope>(
    () =>
      Object.freeze({
        value,
        onChange,
        onPick,
        exclusionKey,
        excluded,
        query: queryText,
      }),
    [
      value,
      onChange,
      onPick,
      exclusionKey,
      excluded,
      queryText,
    ],
  );
  const binding = useMemo<ControlBinding>(
    () =>
      Object.freeze({
        identity: Symbol("collaborator input binding"),
        scope,
      }),
    [scope],
  );
  const [mount] = useState(() =>
    Symbol("collaborator login input"),
  );
  const [cells] = useState<InputPublicationCells>(() => ({
    active: null,
    successorOf: null,
    replay: null,
    renderToken: null,
    renderBinding: null,
    retiredPublications: new WeakSet(),
    retiredRows: new WeakSet(),
    retiredActions: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedRows: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedQueries: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    deliveredReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    consumedPublications: new WeakSet(),
    seenElements: new WeakSet(),
  }));
  const [coordinator] = useState(() => new InputCoordinator());
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const [published, setPublished] =
    useState<PublishedState | null>(null);
  coordinator.setPublished(published);

  const cancelTimer = useCallback(
    (owner: QueryAuthority, timer: TimerAuthority) => {
      if (owner.timer !== timer || !timer.pending) return;
      owner.timer = null;
      timer.pending = false;
      if (timer.handle !== null) clearTimeout(timer.handle);
    },
    [],
  );

  const retireQuery = useCallback(
    (owner: QueryAuthority) => {
      if (owner.retired) return;
      owner.retired = true;
      const timer = owner.timer;
      if (timer) cancelTimer(owner, timer);
      const request = owner.request;
      owner.request = null;
      if (
        request &&
        !request.controller.signal.aborted
      ) {
        request.controller.abort();
      }
      if (coordinator.query() === owner) {
        coordinator.setQuery(null);
      }
    },
    [cancelTimer, coordinator],
  );

  const makeQuery = useCallback(
    (
      ownerBinding: ControlBinding,
      mode: QueryMode = "debounce",
      started = false,
    ): QueryAuthority | null => {
      const ownerScope = ownerBinding.scope;
      if (
        !ownerScope.query ||
        ownerScope.query === coordinator.picked() ||
        coordinator.noToken()
      ) {
        return null;
      }
      return {
        binding: ownerBinding,
        scope: ownerScope,
        query: ownerScope.query,
        mode,
        timer: null,
        request: null,
        started,
        retired: false,
      };
    },
    [coordinator],
  );

  const replacePublished = useCallback(
    (
      expected: PublishedState | null,
      next: PublishedState,
    ) => {
      if (coordinator.published() !== expected) return false;
      coordinator.setPublished(next);
      setPublished((previous) =>
        previous === expected ? next : previous,
      );
      return true;
    },
    [coordinator],
  );

  const ownsQuery = useCallback(
    (owner: QueryAuthority) =>
      !owner.retired &&
      coordinator.query() === owner &&
      cells.active?.ownsQuery(owner) === true,
    [cells, coordinator],
  );

  const publishClaimedRequest = useCallback(
    (
      owner: QueryAuthority,
      request: RequestAuthority,
      update: (
        state: PublishedState,
        publication: InputPublication,
      ) => PublishedState,
    ) => {
      const publication = cells.active;
      const state = coordinator.published();
      if (
        request.claimed ||
        owner.request !== request ||
        request.query !== owner ||
        !ownsQuery(owner) ||
        !publication ||
        !state ||
        state.scope !== owner.scope ||
        state.query !== owner
      ) {
        return false;
      }
      request.claimed = true;
      owner.request = null;
      return replacePublished(
        state,
        update(state, publication),
      );
    },
    [cells, coordinator, ownsQuery, replacePublished],
  );

  const runLookup = useCallback(
    (owner: QueryAuthority) => {
      if (
        coordinator.noToken() ||
        !ownsQuery(owner) ||
        owner.request
      ) {
        return;
      }
      const controller = new AbortController();
      const request: RequestAuthority = {
        query: owner,
        controller,
        claimed: false,
      };
      owner.request = request;
      void api.github
        .searchUsers(owner.query, {
          signal: controller.signal,
        })
        .then((result) => {
          if (result.reason === "no-github-token") {
            const applied = publishClaimedRequest(
              owner,
              request,
              (state) => {
                coordinator.disableSuggestions();
                return freezePublished({
                  scope: state.scope,
                  query: null,
                  options: Object.freeze([]),
                  open: false,
                  active: -1,
                  lookup: null,
                });
              },
            );
            if (applied) retireQuery(owner);
            return;
          }
          if (result.limited) {
            publishClaimedRequest(
              owner,
              request,
              (state) =>
                freezePublished({
                  ...state,
                  options: Object.freeze([]),
                  open: false,
                  active: -1,
                  lookup: freezeLookup({
                    query: owner,
                    status: "error",
                    message: `GitHub suggestions for @${owner.query} are temporarily unavailable.`,
                    retrying: false,
                  }),
                }),
            );
            return;
          }
          const users = freezeUsers(result.users);
          publishClaimedRequest(
            owner,
            request,
            (state, publication) => {
              coordinator.cache.set(
                owner.query.toLowerCase(),
                users,
              );
              return freezePublished({
                ...state,
                options: users,
                active: -1,
                open:
                  users.some(
                    (candidate) =>
                      !owner.scope.excluded.has(
                        candidate.login.toLowerCase(),
                      ),
                  ) &&
                  publication.ownerDocument.activeElement ===
                    publication.input,
                lookup: null,
              });
            },
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const reason = apiErrorText(error, "");
          publishClaimedRequest(
            owner,
            request,
            (state) =>
              freezePublished({
                ...state,
                options: Object.freeze([]),
                open: false,
                active: -1,
                lookup: freezeLookup({
                  query: owner,
                  status: "error",
                  message: reason
                    ? `GitHub suggestions for @${owner.query}: ${reason}`
                    : `GitHub suggestions for @${owner.query} are temporarily unavailable.`,
                  retrying: false,
                }),
              }),
          );
        });
    },
    [
      coordinator,
      ownsQuery,
      publishClaimedRequest,
      retireQuery,
    ],
  );

  const state =
    published?.scope === scope ? published : null;
  const candidates = Object.freeze(
    (
      state?.options
        .filter(
          (candidate) =>
            !scope.excluded.has(candidate.login.toLowerCase()),
        )
        .slice(0, SUGGEST_MAX) ?? []
    ).map((candidate, index) =>
      Object.freeze({
        candidate,
        index,
        optionId: `${listId}-option-${index}`,
        login: candidate.login,
        name: candidate.name,
        avatarUrl: candidate.avatarUrl,
      }),
    ),
  );
  const expanded = Boolean(
    state?.open && candidates.length > 0,
  );
  const activeIndex =
    state &&
    state.active >= 0 &&
    state.active < candidates.length
      ? state.active
      : -1;
  const lookup =
    state && state.lookup?.query === state.query
      ? state.lookup
      : null;
  const cacheKey = scope.query
    ? scope.query.toLowerCase()
    : null;
  const presentation: InputPresentation = Object.freeze({
    mount,
    binding,
    scope,
    sourceState: published,
    state,
    query: state?.query ?? null,
    candidates,
    expanded,
    activeIndex,
    lookup,
    cacheKey,
    cacheEntry: cacheKey
      ? coordinator.cache.get(cacheKey) ?? null
      : null,
    picked: coordinator.picked(),
    noToken: coordinator.noToken(),
    listId,
    feedbackId,
  });
  const publication = createInputPublication(
    presentation,
    cells,
    {
      coordinator,
      retireQuery,
      makeQuery,
      replacePublished,
    },
    requestPublicationSuccessor,
  );

  useLayoutEffect(
    () => publication.establish(),
    [publication],
  );

  useEffect(() => {
    const owner = coordinator.query();
    if (
      !owner ||
      owner.scope !== scope ||
      owner.binding !== binding ||
      owner.started ||
      !ownsQuery(owner)
    ) {
      return;
    }
    owner.started = true;
    const cached = coordinator.cache.get(
      owner.query.toLowerCase(),
    );
    if (cached) {
      const state = coordinator.published();
      const active = cells.active;
      if (
        state?.scope === owner.scope &&
        state.query === owner &&
        active?.ownsQuery(owner)
      ) {
        replacePublished(
          state,
          freezePublished({
            ...state,
            options: cached,
            active: -1,
            open:
              cached.some(
                (candidate) =>
                  !owner.scope.excluded.has(
                    candidate.login.toLowerCase(),
                  ),
              ) &&
              active.ownerDocument.activeElement === active.input,
            lookup: null,
          }),
        );
      }
      return;
    }
    if (owner.mode === "immediate") {
      runLookup(owner);
      return;
    }

    const timer: TimerAuthority = {
      query: owner,
      handle: null,
      pending: true,
    };
    owner.timer = timer;
    timer.handle = setTimeout(() => {
      if (
        !timer.pending ||
        timer.query !== owner ||
        owner.timer !== timer ||
        !ownsQuery(owner)
      ) {
        return;
      }
      timer.pending = false;
      owner.timer = null;
      runLookup(owner);
    }, SUGGEST_DEBOUNCE_MS);
  }, [
    binding,
    cells,
    coordinator,
    ownsQuery,
    published,
    replacePublished,
    runLookup,
    scope,
  ]);

  const {
    captureRoot,
    captureInput,
    captureFeedback,
    captureRetry,
    captureList,
    rows: publishedRows,
    deliverChange,
    deliverFocus,
    deliverKeyDown,
    deliverBlur,
    deliverClick,
    deliverMouseDown,
    deliverMouseOver,
    onChange: handleChange,
    onFocus: handleFocus,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    onRetry: handleRetry,
  } = publication;

  return (
    <div
      ref={captureRoot}
      className="relative flex-1"
      onChange={deliverChange}
      onFocus={deliverFocus}
      onKeyDown={deliverKeyDown}
      onBlur={deliverBlur}
      onClick={deliverClick}
      onMouseDown={deliverMouseDown}
      onMouseOver={deliverMouseOver}
    >
      <UserPlus
        size={16}
        className="pointer-events-none absolute left-3 top-2.5 text-ink-4"
      />
      <input
        ref={captureInput}
        className="input pl-9"
        placeholder="GitHub handle, e.g. octocat"
        aria-label="GitHub handle"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={
          expanded && activeIndex >= 0
            ? `${listId}-option-${activeIndex}`
            : undefined
        }
        aria-describedby={lookup ? feedbackId : undefined}
        autoComplete="off"
        spellCheck={false}
        data-testid="share-login"
      />
      {lookup?.status === "loading" && (
        <div
          ref={captureFeedback}
          id={feedbackId}
          className="mt-1 flex items-center gap-1.5 text-xs text-ink-3"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="share-login-loading"
        >
          <Loader2
            size={12}
            className="animate-spin"
            aria-hidden
          />
          Loading GitHub suggestions for @{lookup.query.query}…
        </div>
      )}
      {lookup?.status === "error" && (
        <div
          ref={captureFeedback}
          id={feedbackId}
          className="mt-1 flex items-center gap-2 text-xs text-danger"
          role="alert"
          aria-atomic="true"
          data-testid="share-login-error"
        >
          <span className="min-w-0 flex-1">
            {lookup.message}
          </span>
          <button
            ref={captureRetry}
            type="button"
            className="btn btn-outline btn-sm h-6 shrink-0 px-2"
            onClick={handleRetry}
            onBlur={handleBlur}
            disabled={lookup.retrying}
            aria-busy={lookup.retrying || undefined}
          >
            {lookup.retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {expanded && (
        <ul
          ref={captureList}
          id={listId}
          role="listbox"
          aria-label="Matching GitHub accounts"
          className="menu absolute left-0 right-0 top-full mt-1 max-h-80 overflow-y-auto"
          data-testid="share-login-suggestions"
        >
          {candidates.map((candidate, index) => {
            const row = publishedRows[index]!;
            return (
              <li
                ref={row.capture}
                key={candidate.login}
                id={candidate.optionId}
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "menu-item py-1.5",
                  index === activeIndex && "bg-surface-3",
                )}
                onMouseDown={row.onMouseDown}
                onMouseOver={row.onMouseOver}
                onClick={row.onClick}
                data-testid="share-login-option"
                data-login={candidate.login}
              >
                <span aria-hidden>
                  <SuggestionAvatar
                    login={candidate.login}
                    src={candidate.avatarUrl}
                    onFallback={requestPublicationSuccessor}
                  />
                </span>
                {candidate.name && (
                  <span className="min-w-0 truncate text-[13px] text-ink">
                    {candidate.name}
                  </span>
                )}
                <span
                  className={cn(
                    "min-w-0 truncate",
                    candidate.name
                      ? "text-xs text-ink-3"
                      : "text-[13px] text-ink",
                  )}
                >
                  @{candidate.login}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
