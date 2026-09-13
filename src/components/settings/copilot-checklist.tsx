"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";
import { Check, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type ApiTokenDto } from "@/lib/api";
import { copilotAllowToolLine } from "@/lib/mcp";

const CHECKLIST_CLASS = "rounded-2xl border border-line bg-surface p-5";
const ALERT_CLASS =
  "mt-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40";
const RETRY_CLASS = "btn btn-outline btn-sm shrink-0";
const REFRESH_ERROR = "Couldn't check setup progress.";

export interface CopilotChecklistProps {
  /** An agent request exists for this user (asked from the editor): the last step counts as done too. */
  hasAgentRequests: boolean;
  /** Server-rendered first state so the list is right before the first fetch. */
  initialTokens?: Pick<ApiTokenDto, "lastMcpSeenAt" | "lastMcpCallAt">[];
  /** How often to re-read /api/tokens while a step is still open (ms); 0 disables. */
  pollMs?: number;
}

export interface ChecklistState {
  hasToken: boolean;
  mcpSeen: boolean;
  mcpCalled: boolean;
}

interface ChecklistProgress extends ChecklistState {
  tried: boolean;
}

interface PollRequest {
  readonly identity: symbol;
  readonly visit: PollVisit;
  readonly kind: "automatic" | "retry";
  readonly list: typeof api.tokens.list;
  readonly failureAtStart: PollFailure | null;
  action: RetryAction | null;
  settled: boolean;
}

interface PollVisit {
  readonly identity: symbol;
  readonly cadence: symbol;
  readonly document: Document;
  readonly mount: symbol;
  readonly section: HTMLElement;
  readonly sectionRevision: number;
  readonly list: typeof api.tokens.list;
  readonly hasAgentRequests: boolean;
  readonly initialHasToken: boolean;
  readonly initialMcpSeen: boolean;
  readonly initialMcpCalled: boolean;
  readonly pollMs: number;
  owns: () => boolean;
  retry: ((action: RetryAction) => boolean) | null;
  request: PollRequest | null;
  failure: PollFailure | null;
  retired: boolean;
}

interface PollFailure {
  readonly identity: symbol;
  readonly visit: PollVisit;
  readonly request: PollRequest;
}

interface ElementBinding<T extends HTMLElement> {
  element: T | null;
  revision: number;
}

interface DomSnapshot {
  readonly node: Node;
  readonly value: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly DomSnapshot[];
}

interface Placement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previous: Node | null;
  readonly next: Node | null;
}

type PlacementChain = readonly Placement[];

interface RetryAction {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly failure: PollFailure;
  readonly list: typeof api.tokens.list;
  readonly callback: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  claimed: boolean;
}

interface ChecklistPublication {
  readonly identity: symbol;
  readonly visit: PollVisit;
  readonly section: HTMLElement;
  sectionRevision: number;
  readonly failure: PollFailure | null;
  readonly action: RetryAction | null;
  readonly pending: PollRequest | null;
  readonly alert: HTMLDivElement | null;
  alertRevision: number;
  readonly button: HTMLButtonElement | null;
  buttonRevision: number;
  readonly dom: DomSnapshot;
  readonly placement: PlacementChain;
  readonly buttonTargets: readonly Node[];
  ready: boolean;
  retired: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

function createElementBinding<T extends HTMLElement>(): readonly [ElementBinding<T>, RefCallback<T>] {
  const binding: ElementBinding<T> = {
    element: null,
    revision: 0,
  };
  const ref: RefCallback<T> = (element) => {
    binding.revision += 1;
    binding.element = element;
    if (!element) return;
    const revision = binding.revision;
    return () => {
      binding.revision += 1;
      if (binding.element === element && binding.revision === revision + 1) binding.element = null;
    };
  };
  return [binding, ref] as const;
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): DomSnapshot {
  return Object.freeze({
    node,
    value: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function domMatches(snapshot: DomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.value) return false;
  const attributes = snapshotAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return node.childNodes.length === snapshot.children.length &&
    snapshot.children.every((child, index) =>
      node.childNodes.item(index) === child.node && domMatches(child));
}

function snapshotPlacement(node: Node, ownerDocument: Document): PlacementChain | null {
  const placement: Placement[] = [];
  let current: Node | null = node;
  while (current) {
    placement.push(Object.freeze({
      node: current,
      parent: current.parentNode,
      previous: current.previousSibling,
      next: current.nextSibling,
    }));
    if (current === ownerDocument) return Object.freeze(placement);
    current = current.parentNode;
  }
  return null;
}

function placementMatches(ownerDocument: Document, placement: PlacementChain): boolean {
  if (placement.length === 0) return false;
  for (let index = 0; index < placement.length; index++) {
    const current = placement[index]!;
    const parent = placement[index + 1];
    if (
      current.node.parentNode !== current.parent ||
      current.node.previousSibling !== current.previous ||
      current.node.nextSibling !== current.next ||
      (parent && current.parent !== parent.node)
    ) {
      return false;
    }
  }
  const last = placement.at(-1)!;
  return last.node === ownerDocument &&
    last.parent === null &&
    last.previous === null &&
    last.next === null;
}

function mutationTouchesPlacement(placement: PlacementChain, mutation: MutationRecord): boolean {
  if (mutation.type !== "childList") return false;
  return placement.some(({ node, parent }) =>
    mutation.target === parent &&
    (
      mutation.previousSibling === node ||
      mutation.nextSibling === node ||
      [...mutation.addedNodes].includes(node) ||
      [...mutation.removedNodes].includes(node)
    ));
}

function descendantNodes(node: Node | null): readonly Node[] {
  if (!node) return Object.freeze([]);
  const nodes: Node[] = [];
  const visit = (current: Node) => {
    nodes.push(current);
    for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return Object.freeze(nodes);
}

function eventPath(ownerDocument: Document, target: Node): readonly EventTarget[] | null {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  path.push(ownerWindow);
  return path;
}

function eventPathMatches(ownerDocument: Document, target: Node, event: MouseEvent): boolean {
  const expected = eventPath(ownerDocument, target);
  const actual = event.composedPath();
  const actualWindow = actual.at(-1);
  const expectedWindow = expected?.at(-1);
  const hasOwnerWindow =
    actualWindow === expectedWindow ||
    (
      typeof actualWindow === "object" &&
      actualWindow !== null &&
      "document" in actualWindow &&
      actualWindow.document === ownerDocument &&
      "window" in actualWindow &&
      actualWindow.window === actualWindow
    );
  return Boolean(
    expected &&
    actual.length === expected.length &&
    hasOwnerWindow &&
    actual.slice(0, -1).every((entry, index) => entry === expected[index]),
  );
}

class ChecklistRetryCoordinator {
  readonly #mount: symbol;
  readonly #section: ElementBinding<HTMLElement>;
  readonly #alert: ElementBinding<HTMLDivElement>;
  readonly #button: ElementBinding<HTMLButtonElement>;
  readonly #claimedNativeEvents = new WeakSet<Event>();
  #current: ChecklistPublication | null = null;

  constructor(
    mount: symbol,
    section: ElementBinding<HTMLElement>,
    alert: ElementBinding<HTMLDivElement>,
    button: ElementBinding<HTMLButtonElement>,
  ) {
    this.#mount = mount;
    this.#section = section;
    this.#alert = alert;
    this.#button = button;
  }

  publish(
    visit: PollVisit | null,
    failure: PollFailure | null,
    action: RetryAction | null,
    pending: PollRequest | null,
  ): (() => void) | undefined {
    if (this.#current) this.#retire(this.#current);
    const section = this.#section.element;
    const alert = this.#alert.element;
    const button = this.#button.element;
    if (
      !visit ||
      !section ||
      !visit.owns() ||
      visit.mount !== this.#mount ||
      visit.section !== section ||
      visit.sectionRevision !== this.#section.revision ||
      section.ownerDocument !== visit.document ||
      !section.isConnected ||
      api.tokens.list !== visit.list ||
      failure !== visit.failure ||
      Boolean(failure) !== Boolean(action) ||
      (failure && action?.failure !== failure) ||
      (action && (action.mount !== this.#mount || action.list !== visit.list)) ||
      Boolean(failure) !== Boolean(alert) ||
      Boolean(failure) !== Boolean(button) ||
      (pending && (
        pending.visit !== visit ||
        pending.kind !== "retry" ||
        pending.action !== action ||
        visit.request !== pending
      ))
    ) {
      return;
    }

    const placement = snapshotPlacement(section, visit.document);
    if (!placement) return;
    const publication: ChecklistPublication = {
      identity: Symbol("copilot-checklist-publication"),
      visit,
      section,
      sectionRevision: this.#section.revision,
      failure,
      action,
      pending,
      alert,
      alertRevision: this.#alert.revision,
      button,
      buttonRevision: this.#button.revision,
      dom: snapshotDom(section),
      placement,
      buttonTargets: descendantNodes(button),
      ready: false,
      retired: false,
      mutated: false,
      observer: null,
    };
    if (!this.#hierarchyIsCurrent(publication)) return;

    const MutationObserverConstructor = visit.document.defaultView?.MutationObserver;
    if (MutationObserverConstructor) {
      const observer = new MutationObserverConstructor((records) => {
        this.#recordMutations(publication, records);
      });
      observer.observe(section, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      const observedParents = new Set<Node>();
      for (const { parent } of placement) {
        if (parent && !observedParents.has(parent)) {
          observedParents.add(parent);
          observer.observe(parent, { childList: true });
        }
      }
      publication.observer = observer;
    }
    this.#current = publication;
    queueMicrotask(() => {
      if (
        this.#current !== publication ||
        publication.retired ||
        publication.section !== this.#section.element ||
        publication.alert !== this.#alert.element ||
        publication.button !== this.#button.element ||
        !publication.visit.owns() ||
        !placementMatches(publication.visit.document, publication.placement) ||
        !this.#mutationFree(publication) ||
        !domMatches(publication.dom)
      ) {
        return;
      }
      publication.sectionRevision = this.#section.revision;
      publication.alertRevision = this.#alert.revision;
      publication.buttonRevision = this.#button.revision;
      publication.ready = this.#hierarchyIsCurrent(publication);
    });
    return () => this.#retire(publication);
  }

  captureRequest(request: PollRequest) {
    const publication = this.#current;
    if (!publication || publication.visit !== request.visit || !this.#publicationIsCurrent(publication)) return;
    if (request.failureAtStart) request.action = publication.action;
  }

  canSettle(request: PollRequest): boolean {
    const publication = this.#current;
    if (
      !publication ||
      request.settled ||
      request.visit.request !== request ||
      request.visit.list !== request.list ||
      api.tokens.list !== request.list ||
      !request.visit.owns() ||
      publication.visit !== request.visit ||
      !this.#publicationIsCurrent(publication)
    ) {
      return false;
    }
    return request.failureAtStart
      ? request.action !== null &&
          request.action.failure === request.failureAtStart &&
          publication.failure === request.failureAtStart &&
          publication.action === request.action &&
          publication.alert === this.#alert.element &&
          publication.button === this.#button.element
      : publication.failure === null && publication.action === null;
  }

  activate(action: RetryAction, event: ReactMouseEvent<HTMLButtonElement>) {
    const publication = this.#current;
    const button = publication?.button;
    const ownerDocument = button?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !publication ||
      !button ||
      !ownerDocument ||
      !ownerWindow ||
      publication.action !== action ||
      publication.failure !== action.failure ||
      publication.pending !== null ||
      action.mount !== this.#mount ||
      action.list !== publication.visit.list ||
      action.claimed ||
      publication.visit.request !== null ||
      publication.visit.failure !== action.failure ||
      api.tokens.list !== action.list ||
      !event ||
      typeof event !== "object" ||
      event.type !== "click" ||
      event.defaultPrevented ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      !nativeEvent.bubbles ||
      !nativeEvent.cancelable ||
      nativeEvent.defaultPrevented ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== ownerDocument ||
      !target.isConnected ||
      !button.contains(target) ||
      !publication.buttonTargets.includes(target) ||
      !eventPathMatches(ownerDocument, target, nativeEvent) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      !this.#publicationIsCurrent(publication) ||
      !publication.visit.retry
    ) {
      return;
    }

    action.claimed = true;
    this.#claimedNativeEvents.add(nativeEvent);
    if (!publication.visit.retry(action)) action.claimed = false;
  }

  #hierarchyIsCurrent(publication: ChecklistPublication): boolean {
    const { section, alert, button, action, failure, pending, visit } = publication;
    const ownerWindow = visit.document.defaultView;
    if (
      !ownerWindow ||
      !(section instanceof ownerWindow.HTMLElement) ||
      section !== this.#section.element ||
      publication.sectionRevision !== this.#section.revision ||
      section.ownerDocument !== visit.document ||
      !section.isConnected ||
      section.tagName.toLowerCase() !== "section" ||
      section.className !== CHECKLIST_CLASS ||
      section.dataset.testid !== "copilot-checklist" ||
      section.getAttribute("aria-labelledby") !== "copilot-checklist-title" ||
      section.querySelectorAll('[role="alert"]').length !== (failure ? 1 : 0)
    ) {
      return false;
    }
    if (!failure) {
      return (
        !action &&
        !alert &&
        !button &&
        this.#alert.element === null &&
        this.#button.element === null
      );
    }
    const message = alert?.firstElementChild;
    return Boolean(
      action &&
      alert instanceof ownerWindow.HTMLDivElement &&
      button instanceof ownerWindow.HTMLButtonElement &&
      alert === this.#alert.element &&
      button === this.#button.element &&
      publication.alertRevision === this.#alert.revision &&
      publication.buttonRevision === this.#button.revision &&
      alert.isConnected &&
      button.isConnected &&
      alert.ownerDocument === visit.document &&
      button.ownerDocument === visit.document &&
      alert.parentElement === section &&
      section.lastElementChild === alert &&
      alert.previousElementSibling?.tagName.toLowerCase() === "ol" &&
      alert.className === ALERT_CLASS &&
      alert.dataset.testid === "copilot-checklist-error" &&
      alert.getAttribute("role") === "alert" &&
      alert.getAttribute("aria-atomic") === "true" &&
      alert.children.length === 2 &&
      message instanceof ownerWindow.HTMLSpanElement &&
      message.className === "min-w-0 flex-1" &&
      message.textContent === REFRESH_ERROR &&
      message.nextElementSibling === button &&
      button.parentElement === alert &&
      button.className === RETRY_CLASS &&
      button.dataset.testid === "copilot-checklist-retry" &&
      button.getAttribute("type") === "button" &&
      button.type === "button" &&
      button.textContent === "Retry now" &&
      button.children.length === 0 &&
      button.disabled === Boolean(pending) &&
      button.matches(":disabled") === Boolean(pending) &&
      button.getAttribute("aria-busy") === (pending ? "true" : null) &&
      action.failure === failure &&
      action.list === visit.list &&
      (!pending || pending.action === action)
    );
  }

  #publicationIsCurrent(publication: ChecklistPublication): boolean {
    return (
      this.#current === publication &&
      publication.ready &&
      !publication.retired &&
      publication.visit.owns() &&
      publication.visit.mount === this.#mount &&
      publication.visit.failure === publication.failure &&
      api.tokens.list === publication.visit.list &&
      placementMatches(publication.visit.document, publication.placement) &&
      this.#mutationFree(publication) &&
      domMatches(publication.dom) &&
      this.#hierarchyIsCurrent(publication)
    );
  }

  #retire(publication: ChecklistPublication) {
    if (publication.retired) return;
    this.#mutationFree(publication);
    publication.retired = true;
    publication.observer?.disconnect();
    publication.observer = null;
    if (this.#current === publication) this.#current = null;
  }

  #mutationFree(publication: ChecklistPublication): boolean {
    const records = publication.observer?.takeRecords();
    if (records?.length) this.#recordMutations(publication, records);
    return !publication.mutated;
  }

  #recordMutations(publication: ChecklistPublication, records: readonly MutationRecord[]) {
    if (
      publication.mutated ||
      !records.some((record) =>
        publication.section.contains(record.target) ||
        record.target === publication.section ||
        mutationTouchesPlacement(publication.placement, record))
    ) {
      return;
    }
    publication.mutated = true;
  }
}

export function checklistState(tokens: Pick<ApiTokenDto, "lastMcpSeenAt" | "lastMcpCallAt">[]): ChecklistState {
  return { hasToken: tokens.length > 0, mcpSeen: tokens.some((t) => !!t.lastMcpSeenAt), mcpCalled: tokens.some((t) => !!t.lastMcpCallAt) };
}

function advanceChecklistState(
  current: ChecklistProgress,
  next: ChecklistState,
  hasAgentRequests = false,
): ChecklistProgress {
  const advanced = {
    hasToken: current.hasToken || next.hasToken,
    mcpSeen: current.mcpSeen || next.mcpSeen,
    mcpCalled: current.mcpCalled || next.mcpCalled,
    tried: current.tried || next.mcpCalled || hasAgentRequests,
  };
  return advanced.hasToken === current.hasToken &&
    advanced.mcpSeen === current.mcpSeen &&
    advanced.mcpCalled === current.mcpCalled &&
    advanced.tried === current.tried
    ? current
    : advanced;
}

/**
 * "Set up Copilot CLI" at the top of Settings → Agents: four steps whose checkmarks come from real
 * state — a token exists, an MCP client listed the tools with it (`lastMcpSeenAt`), a tool call went
 * through (`lastMcpCallAt`, so the permission prompt was answered) or a request was sent from the editor.
 */
export function CopilotChecklist({ hasAgentRequests, initialTokens, pollMs = 5000 }: CopilotChecklistProps) {
  const activeVisit = useRef<PollVisit | null>(null);
  const [mount] = useState(() => Symbol("copilot-checklist-mount"));
  const [[section, sectionRef]] = useState(() => createElementBinding<HTMLElement>());
  const [[alert, alertRef]] = useState(() => createElementBinding<HTMLDivElement>());
  const [[button, buttonRef]] = useState(() => createElementBinding<HTMLButtonElement>());
  const [coordinator] = useState(() => new ChecklistRetryCoordinator(mount, section, alert, button));
  const [failure, setFailure] = useState<PollFailure | null>(null);
  const [retryPending, setRetryPending] = useState<PollRequest | null>(null);
  const listTokens = api.tokens.list;
  const initial = checklistState(initialTokens ?? []);
  const [state, setState] = useState<ChecklistProgress>(() => ({ ...initial, tried: initial.mcpCalled || hasAgentRequests }));
  const steps: { id: string; label: string; detail: React.ReactNode; done: boolean }[] = [
    { id: "token", label: "Create a token", detail: <>Below: name it after the agent (e.g. “GitHub Copilot CLI”) and copy the secret once.</>, done: state.hasToken },
    {
      id: "config",
      label: "Paste the config into Copilot CLI",
      detail: (
        <>
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">/mcp add</code> with the configuration shown under “Connect an agent”. Turns green when the CLI lists Markdoc’s tools.
        </>
      ),
      done: state.mcpSeen,
    },
    {
      id: "allow",
      label: "Allow the Markdoc tools",
      detail: (
        <>
          Answer the permission prompt, or start Copilot with <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">{copilotAllowToolLine()}</code>.
        </>
      ),
      done: state.mcpCalled,
    },
    {
      id: "try",
      label: "Try “read my doc”",
      detail: <>Ask Copilot to read one of your documents, or send a request from the editor (mention it in a comment). Turns green after the first tool call or request.</>,
      done: state.tried,
    },
  ];
  const effectiveState = advanceChecklistState(state, initial, hasAgentRequests);
  const effectivelyAllDone =
    effectiveState.hasToken && effectiveState.mcpSeen && effectiveState.mcpCalled && effectiveState.tried;

  useLayoutEffect(() => {
    setState((current) =>
      advanceChecklistState(
        current,
        { hasToken: initial.hasToken, mcpSeen: initial.mcpSeen, mcpCalled: initial.mcpCalled },
        hasAgentRequests,
      ),
    );
  }, [hasAgentRequests, initial.hasToken, initial.mcpCalled, initial.mcpSeen]);

  useLayoutEffect(() => {
    if (effectivelyAllDone || pollMs <= 0) return;
    const sectionElement = section.element;
    const ownerDocument = sectionElement?.ownerDocument;
    if (!ownerDocument) return;

    const cadence = Symbol("copilot-checklist-cadence");
    const visit: PollVisit = {
      identity: Symbol("copilot-checklist-visit"),
      cadence,
      document: ownerDocument,
      mount,
      section: sectionElement,
      sectionRevision: section.revision,
      list: listTokens,
      hasAgentRequests,
      initialHasToken: initial.hasToken,
      initialMcpSeen: initial.mcpSeen,
      initialMcpCalled: initial.mcpCalled,
      pollMs,
      owns: () => false,
      retry: null,
      request: null,
      failure: null,
      retired: false,
    };
    if (activeVisit.current) activeVisit.current.retired = true;
    activeVisit.current = visit;

    const ownsCadence = () =>
      !visit.retired &&
      activeVisit.current === visit &&
      visit.cadence === cadence &&
      visit.mount === mount &&
      section.element === visit.section &&
      section.revision === visit.sectionRevision &&
      visit.section.isConnected &&
      visit.section.ownerDocument === visit.document &&
      api.tokens.list === visit.list;
    visit.owns = ownsCadence;

    const load = (
      kind: PollRequest["kind"],
      action: RetryAction | null = null,
    ): PollRequest | null => {
      if (!ownsCadence() || visit.request !== null) return null;
      const request: PollRequest = {
        identity: Symbol("copilot-checklist-request"),
        visit,
        kind,
        list: visit.list,
        failureAtStart: visit.failure,
        action,
        settled: false,
      };
      visit.request = request;
      coordinator.captureRequest(request);
      if (request.failureAtStart && !request.action) {
        visit.request = null;
        return null;
      }
      if (kind === "retry") setRetryPending(request);

      const claimSettlement = () => {
        if (!coordinator.canSettle(request)) return false;
        request.settled = true;
        visit.request = null;
        return true;
      };

      const succeeded = (r: { tokens: ApiTokenDto[] }) => {
        if (claimSettlement()) {
          visit.failure = null;
          setFailure((current) => current?.visit === visit ? null : current);
          setState((current) => advanceChecklistState(current, checklistState(r.tokens)));
          if (kind === "retry") {
            setRetryPending((current) => current === request ? null : current);
          }
        }
      };
      const failed = () => {
        if (claimSettlement()) {
          const nextFailure: PollFailure = Object.freeze({
            identity: Symbol("copilot-checklist-failure"),
            visit,
            request,
          });
          visit.failure = nextFailure;
          setFailure(nextFailure);
          if (kind === "retry") {
            setRetryPending((current) => current === request ? null : current);
          }
        }
      };

      let pending: ReturnType<typeof api.tokens.list>;
      try {
        pending = visit.list();
      } catch {
        queueMicrotask(() => {
          failed();
          request.settled = true;
          if (visit.request === request) visit.request = null;
        });
        return request;
      }
      void pending.then(succeeded, failed).finally(() => {
        request.settled = true;
        if (visit.request === request) visit.request = null;
      });
      return request;
    };
    visit.retry = (action) => {
      if (
        visit.failure !== action.failure ||
        action.list !== visit.list ||
        action.claimed !== true ||
        visit.request !== null
      ) {
        return false;
      }
      return load("retry", action)?.action === action;
    };
    load("automatic");
    const timer = setInterval(() => load("automatic"), pollMs);
    return () => {
      visit.retired = true;
      visit.retry = null;
      if (activeVisit.current === visit) activeVisit.current = null;
      clearInterval(timer);
    };
  }, [
    coordinator,
    effectivelyAllDone,
    hasAgentRequests,
    initial.hasToken,
    initial.mcpCalled,
    initial.mcpSeen,
    listTokens,
    mount,
    pollMs,
    section,
  ]);

  const visitMatchesRender = (visit: PollVisit) =>
    !visit.retired &&
    visit.mount === mount &&
    visit.list === listTokens &&
    visit.hasAgentRequests === hasAgentRequests &&
    visit.initialHasToken === initial.hasToken &&
    visit.initialMcpSeen === initial.mcpSeen &&
    visit.initialMcpCalled === initial.mcpCalled &&
    visit.pollMs === pollMs &&
    !effectivelyAllDone &&
    pollMs > 0;
  const visibleFailure = failure && visitMatchesRender(failure.visit) ? failure : null;
  const retryAction = useMemo<RetryAction | null>(() => {
    if (!visibleFailure) return null;
    const action: RetryAction = {
      identity: Symbol("copilot-checklist-retry-action"),
      mount,
      failure: visibleFailure,
      list: listTokens,
      callback: (event) => coordinator.activate(action, event),
      claimed: false,
    };
    return action;
  }, [coordinator, listTokens, mount, visibleFailure]);
  const visiblePending =
    retryPending &&
    retryAction &&
    retryPending.visit === visibleFailure?.visit &&
    retryPending.action === retryAction
      ? retryPending
      : null;

  useLayoutEffect(() => {
    const visit = activeVisit.current;
    return coordinator.publish(
      visit && activeVisit.current === visit && visitMatchesRender(visit) ? visit : null,
      visibleFailure,
      retryAction,
      visiblePending,
    );
  });

  const doneCount = steps.filter((s) => s.done).length;
  return (
    <section ref={sectionRef} className={CHECKLIST_CLASS} aria-labelledby="copilot-checklist-title" data-testid="copilot-checklist" data-done={doneCount}>
      <div className="mb-3 flex items-center gap-2">
        <ListChecks size={16} className="text-accent" aria-hidden />
        <h2 id="copilot-checklist-title" className="text-sm font-semibold text-ink">
          Set up Copilot CLI
        </h2>
        <span className="ml-auto text-xs text-ink-3" data-testid="copilot-checklist-progress">
          {doneCount} of {steps.length}
        </span>
      </div>
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <li key={s.id} className="flex gap-3" data-testid={`checklist-${s.id}`} data-done={s.done}>
            <span
              className={cn(
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                s.done ? "border-green-600 bg-green-600 text-white dark:border-green-500 dark:bg-green-500" : "border-line-2 text-ink-3",
              )}
              aria-hidden
            >
              {s.done ? <Check size={12} strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0 text-sm">
              <div className={cn("font-medium", s.done ? "text-green-700 dark:text-green-400" : "text-ink")}>
                {s.label}
                <span className="sr-only">{s.done ? " — done" : " — to do"}</span>
              </div>
              <p className="mt-0.5 break-words text-xs leading-5 text-ink-3">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {visibleFailure && retryAction && (
        <div
          ref={alertRef}
          className={ALERT_CLASS}
          role="alert"
          aria-atomic="true"
          data-testid="copilot-checklist-error"
        >
          <span className="min-w-0 flex-1">{REFRESH_ERROR}</span>
          <button
            ref={buttonRef}
            type="button"
            className={RETRY_CLASS}
            disabled={Boolean(visiblePending)}
            aria-busy={visiblePending ? true : undefined}
            onClick={retryAction.callback}
            data-testid="copilot-checklist-retry"
          >
            Retry now
          </button>
        </div>
      )}
    </section>
  );
}
