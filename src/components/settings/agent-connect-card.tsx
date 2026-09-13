"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { Check, Copy, ExternalLink, KeyRound, Plug, TerminalSquare, X } from "lucide-react";
import { COPY_FALLBACK_HINT } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useCopy, type CopyStatus } from "@/lib/hooks";
import { AGENT_DOCS_URL, MCP_PATH, type TokenScopeName } from "@/lib/mcp";
import { CopilotPermissionsHint } from "@/components/settings/copilot-permissions-hint";

/** Placeholder used in all copyable client setup examples. */
export const TOKEN_PLACEHOLDER = "MARKDOC_TOKEN";
export const COPILOT_APP_INSTALL = "mkdir -p ~/.copilot/extensions/markdoc && cp -R extensions/markdoc/. ~/.copilot/extensions/markdoc/";
const COPILOT_APP_DOCS = "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md#inside-the-copilot-app";
type ConnectTarget = "copilot-cli" | "mcp-clients" | "other-clients" | "copilot-app";
type ConnectTargetDefinition = { id: ConnectTarget; label: string };

const CONNECT_TARGETS = Object.freeze([
  Object.freeze({ id: "copilot-cli", label: "Copilot CLI" }),
  Object.freeze({ id: "mcp-clients", label: "VS Code" }),
  Object.freeze({ id: "other-clients", label: "Other MCP clients" }),
  Object.freeze({ id: "copilot-app", label: "Copilot app" }),
]) satisfies readonly ConnectTargetDefinition[];
const CONNECT_TARGET_IDS = Object.freeze(CONNECT_TARGETS.map(({ id }) => id));
const AGENT_TAB_ROLES = Object.freeze(["list", ...CONNECT_TARGET_IDS] as const);
const AGENT_TABLIST_CLASS = "mt-3 flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1";
const AGENT_TAB_CLASS = "rounded-md px-2.5 py-1.5 text-xs font-medium";
const queueAgentTabCoordinatorDisposal =
  globalThis.queueMicrotask.bind(globalThis);

interface AgentConnectAuthority {
  mount: symbol;
  origin: string;
  scope: TokenScopeName | null | undefined;
  onCreateToken: (() => void) | undefined;
  onDismiss: (() => void) | undefined;
  hideTokenStep: boolean | undefined;
  className: string | undefined;
}

interface TabOwner {
  authority: AgentConnectAuthority;
  element: HTMLButtonElement;
}

interface ControlOwner {
  authority: AgentConnectAuthority;
  element: HTMLButtonElement;
}

/**
 * The MCP config for clients using mcpServers, pointing at this server's remote
 * endpoint (`/api/mcp`, Streamable HTTP). No checkout needed: a URL and a token.
 */
export function mcpHttpConfigFor(origin: string, token: string = TOKEN_PLACEHOLDER): string {
  return JSON.stringify(
    {
      mcpServers: {
        markdoc: {
          type: "http",
          url: `${origin}${MCP_PATH}`,
          headers: { Authorization: ["Bearer", token].join(" ") },
          tools: ["*"],
        },
      },
    },
    null,
    2,
  );
}

export function mcpVsCodeConfigFor(origin: string): string {
  return JSON.stringify({
    servers: { markdoc: { type: "http", url: `${origin}${MCP_PATH}`, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } } },
  }, null, 2);
}

/** The stdio alternative: `mcp/server.mjs` from a checkout, for clients that cannot speak HTTP. */
export function mcpConfigFor(origin: string, token: string = TOKEN_PLACEHOLDER, root: "mcpServers" | "servers" = "mcpServers"): string {
  return JSON.stringify(
    {
      [root]: {
        markdoc: {
          command: "node",
          args: ["/path/to/markdoc/mcp/server.mjs"],
          env: { MARKDOC_URL: origin, MARKDOC_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

/** The browser's origin after hydration; `fallback` (e.g. the server's AUTH_URL) until then. */
export function useOrigin(fallback = ""): string {
  const [origin, setOrigin] = useState(fallback);
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.origin) setOrigin(window.location.origin);
  }, []);
  return origin;
}

const COPY_BLOCK_CLASS = "min-w-0";
const COPY_BLOCK_PRE_CLASS = "select-text whitespace-pre-wrap break-all rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-5 text-ink-2";
const COPY_BLOCK_BUTTON_CLASS = "btn btn-outline btn-sm mt-2 h-auto max-w-full gap-1.5 whitespace-normal text-left";

interface CopyBlockRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly value: string;
  readonly label: string;
  readonly testId: string | undefined;
  readonly copyTestId: string | undefined;
  readonly copySetup: Readonly<{
    copy: () => void;
    status: CopyStatus;
    label: string;
    copied: boolean;
  }>;
  readonly copy: () => void;
  readonly status: CopyStatus;
  readonly buttonLabel: string;
  readonly copied: boolean;
  readonly ariaLabel: string;
}

interface CopyBlockElements {
  wrapper: HTMLDivElement | null;
  pre: HTMLPreElement | null;
  button: HTMLButtonElement | null;
}

type CopyBlockElementRole = keyof CopyBlockElements;

interface CopyBlockGeneration {
  readonly identity: symbol;
  readonly render: CopyBlockRender;
  readonly elements: CopyBlockElements;
  readonly bindings: Record<CopyBlockElementRole, CopyBlockBinding | null>;
  authority: CopyBlockDraft | null;
  target: RefObject<HTMLPreElement | null> | null;
}

interface CopyBlockDraft {
  readonly identity: symbol;
  readonly render: CopyBlockRender;
  readonly generation: CopyBlockGeneration;
  committed: boolean;
  retired: boolean;
}

interface CopyBlockBinding {
  readonly identity: symbol;
  readonly generation: CopyBlockGeneration;
  readonly role: CopyBlockElementRole;
  readonly element: HTMLElement;
  active: boolean;
}

interface CopyBlockDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly CopyBlockDomSnapshot[];
}

interface CopyBlockPlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

type CopyBlockPlacementChain = readonly CopyBlockPlacement[];

interface CopyBlockAction {
  readonly identity: symbol;
  readonly generation: CopyBlockGeneration;
  readonly render: CopyBlockRender;
  readonly ownerDocument: Document;
  readonly button: HTMLButtonElement;
  readonly value: string;
  readonly copy: () => void;
}

interface CopyBlockPublicationFacts {
  readonly identity: symbol;
  readonly render: CopyBlockRender;
  readonly draft: CopyBlockDraft;
  readonly generation: CopyBlockGeneration;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly ownerDocument: Document;
  readonly wrapper: HTMLDivElement;
  readonly pre: HTMLPreElement;
  readonly button: HTMLButtonElement;
  readonly bindings: Readonly<Record<CopyBlockElementRole, CopyBlockBinding>>;
  readonly placement: CopyBlockPlacementChain;
  readonly dom: CopyBlockDomSnapshot;
  readonly buttonTargets: readonly Node[];
  readonly action: CopyBlockAction;
}

interface CopyBlockPublication {
  readonly facts: CopyBlockPublicationFacts;
  retired: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

interface CopyBlockPreOwner {
  readonly binding: CopyBlockBinding;
  readonly target: RefObject<HTMLPreElement | null>;
}

interface CopyBlockReplay {
  readonly publication: CopyBlockPublication;
  readonly generation: CopyBlockGeneration;
  readonly expected: Readonly<Record<CopyBlockElementRole, CopyBlockBinding>>;
  readonly released: Set<CopyBlockElementRole>;
  readonly rebound: Map<CopyBlockElementRole, CopyBlockBinding>;
  layoutRetired: boolean;
  invalid: boolean;
}

const COPY_BLOCK_ROLES = ["wrapper", "pre", "button"] as const;

function copyBlockAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotCopyBlockDom(node: Node): CopyBlockDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: copyBlockAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotCopyBlockDom)),
  });
}

function copyBlockDomMatches(snapshot: CopyBlockDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = copyBlockAttributes(node);
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
      node.childNodes.item(index) === child.node && copyBlockDomMatches(child));
}

function snapshotCopyBlockPlacement(
  node: Node,
  ownerDocument: Document,
): CopyBlockPlacementChain | null {
  const placements: CopyBlockPlacement[] = [];
  let current: Node | null = node;
  while (current) {
    placements.push(Object.freeze({
      node: current,
      parent: current.parentNode,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
    }));
    if (current === ownerDocument) return Object.freeze(placements);
    current = current.parentNode;
  }
  return null;
}

function copyBlockPlacementMatches(
  ownerDocument: Document,
  placements: CopyBlockPlacementChain,
): boolean {
  if (placements.length === 0) return false;
  for (let index = 0; index < placements.length; index++) {
    const placement = placements[index]!;
    const next = placements[index + 1];
    if (
      placement.node.parentNode !== placement.parent ||
      placement.node.previousSibling !== placement.previousSibling ||
      placement.node.nextSibling !== placement.nextSibling ||
      (next && placement.parent !== next.node)
    ) {
      return false;
    }
  }
  const last = placements.at(-1)!;
  return (
    last.node === ownerDocument &&
    last.parent === null &&
    last.previousSibling === null &&
    last.nextSibling === null
  );
}

function copyBlockMutationTouchesPlacement(
  placements: CopyBlockPlacementChain,
  mutation: MutationRecord,
): boolean {
  if (mutation.type !== "childList") return false;
  return placements.some(({ node, parent }) =>
    parent === mutation.target &&
    (
      mutation.previousSibling === node ||
      mutation.nextSibling === node ||
      [...mutation.addedNodes].includes(node) ||
      [...mutation.removedNodes].includes(node)
    ));
}

function copyBlockNodes(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return Object.freeze(nodes);
}

function setCopyBlockElement(
  generation: CopyBlockGeneration,
  role: CopyBlockElementRole,
  element: HTMLElement | null,
) {
  if (role === "wrapper") generation.elements.wrapper = element as HTMLDivElement | null;
  else if (role === "pre") generation.elements.pre = element as HTMLPreElement | null;
  else generation.elements.button = element as HTMLButtonElement | null;
}

function copyBlockEventPath(
  ownerDocument: Document,
  target: Node,
): readonly EventTarget[] | null {
  const view = ownerDocument.defaultView;
  if (!view) return null;
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  path.push(view);
  return path;
}

function copyBlockEventPathMatches(
  ownerDocument: Document,
  target: Node,
  event: MouseEvent,
): boolean {
  const expected = copyBlockEventPath(ownerDocument, target);
  const actual = event.composedPath();
  const actualView = actual.at(-1);
  const expectedView = expected?.at(-1);
  const hasOwnerDocumentView =
    actualView === expectedView ||
    (
      typeof actualView === "object" &&
      actualView !== null &&
      "document" in actualView &&
      actualView.document === ownerDocument &&
      "window" in actualView &&
      actualView.window === actualView
    );
  return Boolean(
    expected &&
    actual.length === expected.length &&
    hasOwnerDocumentView &&
    actual.slice(0, -1).every((entry, index) => entry === expected[index]),
  );
}

class CopyBlockCoordinator {
  readonly #mount: symbol;
  #current: CopyBlockPublication | null = null;
  #replay: CopyBlockReplay | null = null;
  #elementOwners = new WeakMap<HTMLElement, CopyBlockBinding>();
  #preOwner: CopyBlockPreOwner | null = null;
  #publishedGenerations = new WeakSet<CopyBlockGeneration>();
  #replayedGenerations = new WeakSet<CopyBlockGeneration>();
  #claimedPublications = new WeakSet<CopyBlockPublication>();
  #claimedActions = new WeakSet<CopyBlockAction>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: CopyBlockRender): CopyBlockDraft {
    const generation: CopyBlockGeneration = {
      identity: Symbol("copy-block-generation"),
      render,
      elements: { wrapper: null, pre: null, button: null },
      bindings: { wrapper: null, pre: null, button: null },
      authority: null,
      target: null,
    };
    const draft: CopyBlockDraft = {
      identity: Symbol("copy-block-draft"),
      render,
      generation,
      committed: false,
      retired: false,
    };
    generation.authority = draft;
    return draft;
  }

  bindElement<Role extends "wrapper" | "button">(
    draft: CopyBlockDraft,
    role: Role,
    element: CopyBlockElements[Role],
  ) {
    return this.#bind(draft.generation, role, element);
  }

  bindPre(
    draft: CopyBlockDraft,
    target: RefObject<HTMLPreElement | null>,
    element: HTMLPreElement | null,
  ) {
    const generation = draft.generation;
    if (generation.target && generation.target !== target) {
      this.#retireAuthority(generation);
      return;
    }
    generation.target = target;
    return this.#bind(generation, "pre", element, target);
  }

  establish(initialDraft: CopyBlockDraft, target: RefObject<HTMLPreElement | null>) {
    if (initialDraft.retired) {
      const successor = this.#replaySuccessor(initialDraft, target);
      return successor ? () => this.retire(successor) : undefined;
    }
    const { generation } = initialDraft;
    if (
      generation.authority !== initialDraft ||
      generation.target !== target ||
      this.#publishedGenerations.has(generation)
    ) {
      this.#retireDraft(initialDraft);
      return;
    }
    this.#publishedGenerations.add(generation);
    if (this.#current && this.#current.facts.generation !== generation) {
      this.#retirePublication(this.#current, false);
    }
    const publication = this.#createPublication(initialDraft, target);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(initialDraft);
      return;
    }
    return () => this.retire(publication);
  }

  retire(publication: CopyBlockPublication) {
    const existingReplay = this.#replay;
    if (existingReplay?.publication === publication) {
      existingReplay.layoutRetired = true;
      return;
    }
    if (publication.retired) return;
    const replay = this.#beginReplay(publication);
    if (replay) replay.layoutRetired = true;
    this.#retirePublication(publication, Boolean(replay));
  }

  activate(generation: CopyBlockGeneration, event: ReactMouseEvent<HTMLButtonElement>) {
    const publication = this.#current;
    const facts = publication?.facts;
    const action = facts?.action;
    const button = facts?.button;
    const ownerDocument = facts?.ownerDocument;
    const view = ownerDocument?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !publication ||
      !facts ||
      !action ||
      facts.generation !== generation ||
      facts.draft !== generation.authority ||
      publication.retired ||
      facts.draft.retired ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(action) ||
      !button ||
      !ownerDocument ||
      !view ||
      !event ||
      typeof event !== "object" ||
      event.type !== "click" ||
      !(nativeEvent instanceof view.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !(target instanceof view.Node) ||
      target.ownerDocument !== ownerDocument ||
      !button.contains(target) ||
      !facts.buttonTargets.includes(target) ||
      !copyBlockEventPathMatches(ownerDocument, target, nativeEvent) ||
      this.#claimedReactEvents.has(event) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      !this.#actionIsCurrent(publication) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return;
    }

    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(event);
    this.#claimedNativeEvents.add(nativeEvent);
    action.copy();
  }

  #bind(
    generation: CopyBlockGeneration,
    role: CopyBlockElementRole,
    element: HTMLElement | null,
    target?: RefObject<HTMLPreElement | null>,
  ): (() => void) | undefined {
    const previous = generation.bindings[role];
    if (element === null) {
      if (previous) this.#release(previous, "null");
      return;
    }
    if (previous?.active && previous.element === element) return;
    if (
      previous?.active &&
      (
        !element.isConnected ||
        element.ownerDocument !== previous.element.ownerDocument
      )
    ) {
      return;
    }
    if (previous) this.#release(previous, "replace");
    if (this.#replay && this.#replay.generation !== generation) {
      this.#invalidateReplay(this.#replay);
    }
    if (!this.#canBind(generation)) return;

    const replay = this.#replay;
    if (replay?.generation === generation) {
      const expected = replay.expected[role];
      if (
        replay.invalid ||
        !replay.released.has(role) ||
        replay.rebound.has(role) ||
        expected.element !== element
      ) {
        this.#invalidateReplay(replay);
        return;
      }
    }

    const displaced = this.#elementOwners.get(element);
    if (displaced) {
      if (
        displaced.generation !== generation &&
        this.#current?.facts.generation === displaced.generation &&
        generation.authority?.retired
      ) {
        return;
      }
      this.#release(displaced, "replace");
      if (!this.#canBind(generation)) return;
    }

    const binding: CopyBlockBinding = {
      identity: Symbol(`copy-block-${role}-binding`),
      generation,
      role,
      element,
      active: true,
    };
    generation.bindings[role] = binding;
    setCopyBlockElement(generation, role, element);
    this.#elementOwners.set(element, binding);
    if (role === "pre" && target) {
      this.#preOwner = { binding, target };
      target.current = element as HTMLPreElement;
    }
    if (replay?.generation === generation) replay.rebound.set(role, binding);
    return () => this.#release(binding, "cleanup");
  }

  #release(
    binding: CopyBlockBinding,
    source: "cleanup" | "null" | "replace",
  ) {
    if (!binding.active) return;
    const publication = this.#current;
    const startsReplay =
      publication?.facts.generation === binding.generation &&
      publication.facts.bindings[binding.role] === binding
        ? this.#beginReplay(publication)
        : null;
    const replay = this.#replay;

    binding.active = false;
    const { generation, role, element } = binding;
    if (generation.bindings[role] === binding) {
      generation.bindings[role] = null;
      setCopyBlockElement(generation, role, null);
    }
    if (this.#elementOwners.get(element) === binding) this.#elementOwners.delete(element);
    if (role === "pre" && this.#preOwner?.binding === binding) {
      const { target } = this.#preOwner;
      this.#preOwner = null;
      if (target.current === element) target.current = null;
    }

    if (replay?.generation === generation) {
      if (
        source !== "cleanup" ||
        replay.expected[role] !== binding ||
        replay.released.has(role) ||
        replay.rebound.has(role)
      ) {
        replay.invalid = true;
      } else {
        replay.released.add(role);
      }
    }

    if (publication?.facts.generation === generation) {
      this.#retirePublication(publication, Boolean(startsReplay && !startsReplay.invalid));
    } else if (!replay && generation.authority && !generation.authority.retired) {
      this.#retireDraft(generation.authority);
    }
    if (replay?.invalid) this.#invalidateReplay(replay);
  }

  #canBind(generation: CopyBlockGeneration): boolean {
    const authority = generation.authority;
    return Boolean(
      authority &&
      (
        !authority.retired ||
        this.#current?.facts.generation === generation ||
        (this.#replay?.generation === generation && !this.#replay.invalid)
      ),
    );
  }

  #beginReplay(publication: CopyBlockPublication): CopyBlockReplay | null {
    if (this.#replay?.publication === publication) return this.#replay;
    if (
      this.#replay ||
      publication.retired ||
      this.#claimedPublications.has(publication) ||
      this.#current !== publication ||
      this.#replayedGenerations.has(publication.facts.generation) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return null;
    }
    const replay: CopyBlockReplay = {
      publication,
      generation: publication.facts.generation,
      expected: publication.facts.bindings,
      released: new Set(),
      rebound: new Map(),
      layoutRetired: false,
      invalid: false,
    };
    this.#replay = replay;
    queueMicrotask(() => {
      if (this.#replay === replay) this.#invalidateReplay(replay);
    });
    return replay;
  }

  #replaySuccessor(
    initialDraft: CopyBlockDraft,
    target: RefObject<HTMLPreElement | null>,
  ): CopyBlockPublication | null {
    const replay = this.#replay;
    const { generation } = initialDraft;
    if (
      !replay ||
      replay.publication.facts.draft !== initialDraft ||
      replay.generation !== generation ||
      generation.authority !== initialDraft ||
      generation.target !== target ||
      !initialDraft.committed ||
      !initialDraft.retired ||
      !replay.publication.retired ||
      replay.invalid ||
      !replay.layoutRetired ||
      this.#current ||
      this.#replayedGenerations.has(generation) ||
      replay.released.size !== COPY_BLOCK_ROLES.length ||
      replay.rebound.size !== COPY_BLOCK_ROLES.length ||
      COPY_BLOCK_ROLES.some((role) => {
        const expected = replay.expected[role];
        const rebound = replay.rebound.get(role);
        return (
          !rebound ||
          rebound.element !== expected.element ||
          generation.bindings[role] !== rebound ||
          !this.#ownsBinding(rebound)
        );
      }) ||
      !this.#renderIsCurrent(initialDraft.render) ||
      !this.#mutationFree(replay.publication) ||
      !this.#hierarchyIsCurrent(
        generation,
        initialDraft.render,
        target,
        replay.publication.facts.dom,
        replay.publication.facts.placement,
      )
    ) {
      if (replay) this.#invalidateReplay(replay);
      return null;
    }

    const successor: CopyBlockDraft = {
      identity: Symbol("copy-block-successor-draft"),
      render: initialDraft.render,
      generation,
      committed: false,
      retired: false,
    };
    this.#replayedGenerations.add(generation);
    generation.authority = successor;
    const publication = this.#createPublication(
      successor,
      target,
      replay.publication.facts.dom,
      replay.publication.facts.placement,
    );
    this.#replay = null;
    this.#disconnect(replay.publication);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(successor);
      return null;
    }
    return publication;
  }

  #createPublication(
    draft: CopyBlockDraft,
    target: RefObject<HTMLPreElement | null>,
    expectedDom?: CopyBlockDomSnapshot,
    expectedPlacement?: CopyBlockPlacementChain,
  ): CopyBlockPublication | null {
    const { generation, render } = draft;
    const { wrapper, pre, button } = generation.elements;
    const wrapperBinding = generation.bindings.wrapper;
    const preBinding = generation.bindings.pre;
    const buttonBinding = generation.bindings.button;
    if (
      !wrapper ||
      !pre ||
      !button ||
      !wrapperBinding ||
      !preBinding ||
      !buttonBinding ||
      !this.#hierarchyIsCurrent(
        generation,
        render,
        target,
        expectedDom,
        expectedPlacement,
      )
    ) {
      return null;
    }
    const ownerDocument = wrapper.ownerDocument;
    const placement = expectedPlacement ??
      snapshotCopyBlockPlacement(wrapper, ownerDocument);
    if (!placement) return null;
    const action = Object.freeze({
      identity: Symbol("copy-block-action"),
      generation,
      render,
      ownerDocument,
      button,
      value: render.value,
      copy: render.copy,
    });
    const facts: CopyBlockPublicationFacts = Object.freeze({
      identity: Symbol("copy-block-publication"),
      render,
      draft,
      generation,
      target,
      ownerDocument,
      wrapper,
      pre,
      button,
      bindings: Object.freeze({
        wrapper: wrapperBinding,
        pre: preBinding,
        button: buttonBinding,
      }),
      placement,
      dom: expectedDom ?? snapshotCopyBlockDom(wrapper),
      buttonTargets: copyBlockNodes(button),
      action,
    });
    return {
      facts,
      retired: false,
      mutated: false,
      observer: null,
    };
  }

  #publish(publication: CopyBlockPublication): boolean {
    const { facts } = publication;
    if (
      this.#current ||
      publication.retired ||
      facts.draft.retired ||
      facts.generation.authority !== facts.draft
    ) {
      return false;
    }
    facts.draft.committed = true;
    this.#current = publication;
    const MutationObserverConstructor = facts.ownerDocument.defaultView?.MutationObserver;
    if (MutationObserverConstructor) {
      const observer = new MutationObserverConstructor((records) => {
        this.#recordMutations(publication, records);
      });
      observer.observe(facts.wrapper, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      const observedParents = new Set<Node>();
      for (const { parent } of facts.placement) {
        if (parent && !observedParents.has(parent)) {
          observedParents.add(parent);
          observer.observe(parent, { childList: true });
        }
      }
      publication.observer = observer;
    }
    return true;
  }

  #retirePublication(publication: CopyBlockPublication, preserveObserver: boolean) {
    if (!publication.retired) {
      publication.retired = true;
      publication.facts.draft.retired = true;
    }
    if (this.#current === publication) this.#current = null;
    if (!preserveObserver) this.#disconnect(publication);
  }

  #retireDraft(draft: CopyBlockDraft) {
    draft.retired = true;
    if (this.#current?.facts.draft === draft) {
      this.#retirePublication(this.#current, false);
    }
  }

  #retireAuthority(generation: CopyBlockGeneration) {
    const authority = generation.authority;
    if (authority) this.#retireDraft(authority);
    if (this.#replay?.generation === generation) this.#invalidateReplay(this.#replay);
  }

  #invalidateReplay(replay: CopyBlockReplay) {
    if (this.#replay === replay) this.#replay = null;
    replay.invalid = true;
    this.#disconnect(replay.publication);
  }

  #disconnect(publication: CopyBlockPublication) {
    publication.observer?.disconnect();
    publication.observer = null;
  }

  #mutationFree(publication: CopyBlockPublication): boolean {
    const records = publication.observer?.takeRecords();
    if (records?.length) this.#recordMutations(publication, records);
    return !publication.mutated;
  }

  #recordMutations(
    publication: CopyBlockPublication,
    records: readonly MutationRecord[],
  ) {
    if (publication.mutated) return;
    const { facts } = publication;
    publication.mutated = records.some((record) =>
      facts.wrapper.contains(record.target) ||
      copyBlockMutationTouchesPlacement(facts.placement, record));
  }

  #ownsBinding(binding: CopyBlockBinding): boolean {
    return binding.active &&
      binding.generation.bindings[binding.role] === binding &&
      this.#elementOwners.get(binding.element) === binding;
  }

  #renderIsCurrent(render: CopyBlockRender): boolean {
    const setup = render.copySetup;
    return (
      render.mount === this.#mount &&
      Object.isFrozen(render) &&
      Object.isFrozen(setup) &&
      typeof render.value === "string" &&
      typeof render.label === "string" &&
      setup.copy === render.copy &&
      setup.status === render.status &&
      setup.label === render.buttonLabel &&
      setup.copied === render.copied &&
      render.copied === (render.status === "copied") &&
      render.buttonLabel === (
        render.status === "copied"
          ? "Copied"
          : render.status === "fallback"
            ? COPY_FALLBACK_HINT
            : "Copy"
      ) &&
      render.ariaLabel === `Copy ${render.label}`
    );
  }

  #hierarchyIsCurrent(
    generation: CopyBlockGeneration,
    render: CopyBlockRender,
    target: RefObject<HTMLPreElement | null>,
    expectedDom?: CopyBlockDomSnapshot,
    expectedPlacement?: CopyBlockPlacementChain,
  ): boolean {
    const { wrapper, pre, button } = generation.elements;
    const wrapperBinding = generation.bindings.wrapper;
    const preBinding = generation.bindings.pre;
    const buttonBinding = generation.bindings.button;
    if (
      !wrapper ||
      !pre ||
      !button ||
      !wrapperBinding ||
      !preBinding ||
      !buttonBinding ||
      new Set([wrapper, pre, button]).size !== 3 ||
      wrapperBinding.element !== wrapper ||
      preBinding.element !== pre ||
      buttonBinding.element !== button ||
      !this.#ownsBinding(wrapperBinding) ||
      !this.#ownsBinding(preBinding) ||
      !this.#ownsBinding(buttonBinding) ||
      generation.render !== render ||
      generation.target !== target ||
      this.#preOwner?.binding !== preBinding ||
      this.#preOwner.target !== target ||
      target.current !== pre ||
      !this.#renderIsCurrent(render)
    ) {
      return false;
    }

    const ownerDocument = wrapper.ownerDocument;
    const icon = button.firstElementChild;
    if (
      !wrapper.isConnected ||
      !pre.isConnected ||
      !button.isConnected ||
      pre.ownerDocument !== ownerDocument ||
      button.ownerDocument !== ownerDocument ||
      wrapper.tagName.toLowerCase() !== "div" ||
      wrapper.className !== COPY_BLOCK_CLASS ||
      wrapper.children.length !== 2 ||
      wrapper.firstElementChild !== pre ||
      wrapper.lastElementChild !== button ||
      pre.tagName.toLowerCase() !== "pre" ||
      pre.parentElement !== wrapper ||
      pre.nextElementSibling !== button ||
      pre.className !== COPY_BLOCK_PRE_CLASS ||
      pre.getAttribute("data-testid") !== (render.testId ?? null) ||
      pre.children.length !== 0 ||
      pre.textContent !== render.value ||
      button.tagName.toLowerCase() !== "button" ||
      button.parentElement !== wrapper ||
      button.className !== COPY_BLOCK_BUTTON_CLASS ||
      button.getAttribute("data-testid") !== (render.copyTestId ?? null) ||
      button.getAttribute("type") !== "button" ||
      button.type !== "button" ||
      button.disabled ||
      button.matches(":disabled") ||
      button.getAttribute("aria-label") !== render.ariaLabel ||
      button.textContent !== render.buttonLabel ||
      button.children.length !== 1 ||
      !icon ||
      icon.tagName.toLowerCase() !== "svg" ||
      !icon.classList.contains(render.copied ? "lucide-check" : "lucide-copy") ||
      icon.getAttribute("width") !== "14" ||
      icon.getAttribute("height") !== "14" ||
      icon.getAttribute("aria-hidden") !== "true" ||
      (expectedDom && wrapper !== expectedDom.node) ||
      (expectedDom && !copyBlockDomMatches(expectedDom)) ||
      (expectedPlacement && expectedPlacement[0]?.node !== wrapper) ||
      (expectedPlacement && !copyBlockPlacementMatches(ownerDocument, expectedPlacement))
    ) {
      return false;
    }
    return true;
  }

  #actionIsCurrent(publication: CopyBlockPublication): boolean {
    const { facts } = publication;
    const { action } = facts;
    return (
      Object.isFrozen(action) &&
      action.generation === facts.generation &&
      action.render === facts.render &&
      action.ownerDocument === facts.ownerDocument &&
      action.button === facts.button &&
      action.value === facts.render.value &&
      action.copy === facts.render.copy &&
      !this.#claimedActions.has(action)
    );
  }

  #publicationIsCurrent(publication: CopyBlockPublication): boolean {
    const { facts } = publication;
    return (
      this.#current === publication &&
      Object.isFrozen(facts) &&
      !publication.retired &&
      !facts.draft.retired &&
      facts.generation.authority === facts.draft &&
      facts.bindings.wrapper === facts.generation.bindings.wrapper &&
      facts.bindings.pre === facts.generation.bindings.pre &&
      facts.bindings.button === facts.generation.bindings.button &&
      facts.placement[0]?.node === facts.wrapper &&
      copyBlockPlacementMatches(facts.ownerDocument, facts.placement) &&
      this.#mutationFree(publication) &&
      this.#hierarchyIsCurrent(
        facts.generation,
        facts.render,
        facts.target,
        facts.dom,
        facts.placement,
      )
    );
  }
}

export function CopyBlock({ value, label, testId, copyTestId }: { value: string; label: string; testId?: string; copyTestId?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const copyResult = useCopy(value, pre);
  const copySetup = Object.freeze({
    copy: copyResult.copy,
    status: copyResult.status,
    label: copyResult.label,
    copied: copyResult.copied,
  });
  const [mount] = useState(() => Symbol("copy-block"));
  const [coordinator] = useState(() => new CopyBlockCoordinator(mount));
  const render: CopyBlockRender = Object.freeze({
    identity: Symbol("copy-block-render"),
    mount,
    value,
    label,
    testId,
    copyTestId,
    copySetup,
    copy: copySetup.copy,
    status: copySetup.status,
    buttonLabel: copySetup.label,
    copied: copySetup.copied,
    ariaLabel: `Copy ${label}`,
  });
  const draft = coordinator.createDraft(render);

  useLayoutEffect(() => coordinator.establish(draft, pre), [coordinator, draft, pre]);

  return (
    <div ref={(element) => coordinator.bindElement(draft, "wrapper", element)} className={COPY_BLOCK_CLASS}>
      {/* pre-wrap + break-all: the Bearer line wraps instead of being clipped; what is copied is `value`, not this rendering. */}
      <pre
        ref={(element) => coordinator.bindPre(draft, pre, element)}
        className={COPY_BLOCK_PRE_CLASS}
        data-testid={render.testId}
      >
        {render.value}
      </pre>
      <button
        ref={(element) => coordinator.bindElement(draft, "button", element)}
        type="button"
        className={COPY_BLOCK_BUTTON_CLASS}
        onClick={(event) => coordinator.activate(draft.generation, event)}
        aria-label={render.ariaLabel}
        data-testid={render.copyTestId}
      >
        {render.copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        {render.buttonLabel}
      </button>
    </div>
  );
}

type AgentTabRole = typeof AGENT_TAB_ROLES[number];

interface AgentTabElements {
  list: HTMLDivElement | null;
  tabs: Record<ConnectTarget, HTMLButtonElement | null>;
}

interface AgentTabRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly authority: AgentConnectAuthority;
  readonly authorityRef: RefObject<AgentConnectAuthority | null>;
  readonly selectedRef: RefObject<ConnectTarget>;
  readonly selected: ConnectTarget;
  readonly tabsId: string;
  readonly order: readonly ConnectTarget[];
  readonly setTarget: (target: ConnectTarget) => void;
}

interface AgentTabBinding {
  readonly identity: symbol;
  readonly generation: AgentTabGeneration;
  readonly role: AgentTabRole;
  readonly element: HTMLElement;
  active: boolean;
}

interface AgentTabGeneration {
  readonly identity: symbol;
  readonly render: AgentTabRender;
  readonly elements: AgentTabElements;
  readonly bindings: Record<AgentTabRole, AgentTabBinding | null>;
  authority: AgentTabDraft | null;
}

interface AgentTabDraft {
  readonly identity: symbol;
  readonly render: AgentTabRender;
  readonly generation: AgentTabGeneration;
  committed: boolean;
  retired: boolean;
}

interface AgentTabPlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface AgentTabDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly AgentTabDomSnapshot[];
}

interface AgentTabEventIntrinsics {
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly isPrototypeOf: typeof Object.prototype.isPrototypeOf;
  readonly trusted: AgentTabTrustedAuthority;
  readonly event: Readonly<{
    type: (this: Event) => string;
    target: (this: Event) => EventTarget | null;
    currentTarget: (this: Event) => EventTarget | null;
    eventPhase: (this: Event) => number;
    bubbles: (this: Event) => boolean;
    cancelable: (this: Event) => boolean;
    defaultPrevented: (this: Event) => boolean;
    cancelBubble: (this: Event) => boolean;
    composedPath: (this: Event) => EventTarget[];
    preventDefault: (this: Event) => void;
  }>;
  readonly keyboard: Readonly<{
    key: (this: KeyboardEvent) => string;
    code: (this: KeyboardEvent) => string;
    location: (this: KeyboardEvent) => number;
    altKey: (this: KeyboardEvent) => boolean;
    ctrlKey: (this: KeyboardEvent) => boolean;
    metaKey: (this: KeyboardEvent) => boolean;
    shiftKey: (this: KeyboardEvent) => boolean;
    repeat: (this: KeyboardEvent) => boolean;
    isComposing: (this: KeyboardEvent) => boolean;
  }>;
  readonly view: (this: UIEvent) => Window | null;
  readonly activeElement: (this: Document) => Element | null;
  readonly focus: (this: HTMLElement, options?: FocusOptions) => void;
  readonly setTimeout: Window["setTimeout"];
  readonly clearTimeout: Window["clearTimeout"];
}

interface AgentTabTrustedAuthority {
  readonly read: (event: object) => boolean;
  readonly matches: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface AgentTabAction {
  readonly identity: symbol;
  readonly generation: AgentTabGeneration;
  readonly render: AgentTabRender;
  readonly sourceId: ConnectTarget;
  readonly sourceIndex: number;
  readonly source: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly order: readonly ConnectTarget[];
}

interface AgentTabPublication {
  readonly identity: symbol;
  readonly draft: AgentTabDraft;
  readonly generation: AgentTabGeneration;
  readonly render: AgentTabRender;
  readonly list: HTMLDivElement;
  readonly tabs: Readonly<Record<ConnectTarget, HTMLButtonElement>>;
  readonly bindings: Readonly<Record<AgentTabRole, AgentTabBinding>>;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly placement: readonly AgentTabPlacement[];
  readonly dom: AgentTabDomSnapshot;
  readonly intrinsics: AgentTabEventIntrinsics;
  readonly actions: Readonly<Record<ConnectTarget, AgentTabAction>>;
  readonly windowListener: AgentTabWindowListener;
  pendingRoute: AgentTabEventRoute | null;
  retired: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

interface AgentTabReplay {
  readonly identity: symbol;
  readonly publication: AgentTabPublication;
  readonly generation: AgentTabGeneration;
  readonly expected: Readonly<Record<AgentTabRole, AgentTabBinding>>;
  readonly released: Set<AgentTabRole>;
  readonly rebound: Map<AgentTabRole, AgentTabBinding>;
  readonly expiry: AgentTabReplayExpiry;
  layoutRetired: boolean;
  invalid: boolean;
}

interface AgentTabReplayExpiry {
  readonly identity: symbol;
  active: boolean;
  handle: number | null;
  cancel: ((handle: number) => void) | null;
}

interface AgentTabDisposalToken {
  readonly identity: symbol;
  readonly coordinator: AgentTabCoordinator;
  active: boolean;
}

interface AgentTabNativeSnapshot {
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly isTrusted: boolean;
  readonly view: Window | null;
}

interface AgentTabReactSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly type: string;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly eventPhase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly isTrusted: boolean;
  readonly nativeEvent: KeyboardEvent;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly view: Window | null;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
}

interface AgentTabWindowListener {
  readonly identity: symbol;
  readonly target: Window & typeof globalThis;
  readonly add: Window["addEventListener"];
  readonly remove: Window["removeEventListener"];
  readonly callback: EventListener;
  active: boolean;
}

interface AgentTabWindowProof {
  readonly identity: symbol;
  readonly listener: AgentTabWindowListener;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly pathTerminal: EventTarget;
}

interface AgentTabEventRoute {
  readonly identity: symbol;
  readonly publication: AgentTabPublication;
  readonly generation: AgentTabGeneration;
  readonly action: AgentTabAction;
  readonly sourceId: ConnectTarget;
  readonly source: HTMLButtonElement;
  readonly destinationId: ConnectTarget;
  readonly destination: HTMLButtonElement;
  readonly nativeEvent: KeyboardEvent;
  readonly windowSnapshot: AgentTabNativeSnapshot;
  readonly windowProof: AgentTabWindowProof;
  captureSnapshot: AgentTabReactSnapshot | null;
  captureNativeSnapshot: AgentTabNativeSnapshot | null;
  invalid: boolean;
}

function emptyAgentTabElements(): AgentTabElements {
  return {
    list: null,
    tabs: {
      "copilot-cli": null,
      "mcp-clients": null,
      "other-clients": null,
      "copilot-app": null,
    },
  };
}

function emptyAgentTabBindings(): Record<AgentTabRole, AgentTabBinding | null> {
  return {
    list: null,
    "copilot-cli": null,
    "mcp-clients": null,
    "other-clients": null,
    "copilot-app": null,
  };
}

function agentTabAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotAgentTabDom(node: Node): AgentTabDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: agentTabAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotAgentTabDom)),
  });
}

function agentTabDomMatches(snapshot: AgentTabDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = agentTabAttributes(node);
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
      node.childNodes.item(index) === child.node && agentTabDomMatches(child));
}

function snapshotAgentTabPlacement(
  list: HTMLDivElement,
  ownerDocument: Document,
): readonly AgentTabPlacement[] | null {
  const placement: AgentTabPlacement[] = [];
  let current: Node | null = list;
  while (current) {
    placement.push(Object.freeze({
      node: current,
      parent: current.parentNode,
      previousSibling: current.previousSibling,
      nextSibling: current.nextSibling,
    }));
    if (current === ownerDocument) return Object.freeze(placement);
    current = current.parentNode;
  }
  return null;
}

function agentTabPlacementMatches(
  list: HTMLDivElement,
  ownerDocument: Document,
  placement: readonly AgentTabPlacement[],
): boolean {
  if (
    !list.isConnected ||
    list.ownerDocument !== ownerDocument ||
    list.getRootNode() !== ownerDocument ||
    placement.length < 2 ||
    placement[0]?.node !== list
  ) {
    return false;
  }
  for (let index = 0; index < placement.length; index++) {
    const current = placement[index]!;
    const next = placement[index + 1];
    if (
      !current.node.isConnected ||
      current.node.parentNode !== current.parent ||
      current.node.previousSibling !== current.previousSibling ||
      current.node.nextSibling !== current.nextSibling ||
      (next && current.parent !== next.node)
    ) {
      return false;
    }
  }
  const last = placement.at(-1)!;
  return last.node === ownerDocument &&
    last.parent === null &&
    last.previousSibling === null &&
    last.nextSibling === null;
}

function agentTabMutationTouchesPlacement(
  placement: readonly AgentTabPlacement[],
  mutation: MutationRecord,
): boolean {
  if (mutation.type !== "childList") return false;
  return placement.some(({ node, parent }) =>
    parent === mutation.target &&
    (
      mutation.previousSibling === node ||
      mutation.nextSibling === node ||
      [...mutation.addedNodes].includes(node) ||
      [...mutation.removedNodes].includes(node)
    ));
}

function agentTabGetter<This extends object, Value>(
  prototype: object,
  property: string,
): ((this: This) => Value) | null {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  return typeof getter === "function" ? getter as (this: This) => Value : null;
}

function agentTabDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean {
  return Boolean(
    current &&
    current.configurable === expected.configurable &&
    current.enumerable === expected.enumerable &&
    current.get === expected.get &&
    current.set === expected.set &&
    current.value === expected.value &&
    current.writable === expected.writable
  );
}

function captureAgentTabTrustedAuthority(
  ownerWindow: Window & typeof globalThis,
): AgentTabTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new ownerWindow.KeyboardEvent("agent-tab-keyboard-intrinsic");
  } catch {
    return null;
  }
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const apply = ownerWindow.Reflect.apply;
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    agentTabDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
      ownerWindow.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureAgentTabIntrinsics(
  ownerWindow: Window & typeof globalThis,
): AgentTabEventIntrinsics | null {
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const uiEventPrototype = ownerWindow.UIEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const trusted = captureAgentTabTrustedAuthority(ownerWindow);
  const type = agentTabGetter<Event, string>(eventPrototype, "type");
  const target = agentTabGetter<Event, EventTarget | null>(eventPrototype, "target");
  const currentTarget = agentTabGetter<Event, EventTarget | null>(eventPrototype, "currentTarget");
  const eventPhase = agentTabGetter<Event, number>(eventPrototype, "eventPhase");
  const bubbles = agentTabGetter<Event, boolean>(eventPrototype, "bubbles");
  const cancelable = agentTabGetter<Event, boolean>(eventPrototype, "cancelable");
  const defaultPrevented = agentTabGetter<Event, boolean>(eventPrototype, "defaultPrevented");
  const cancelBubble = agentTabGetter<Event, boolean>(eventPrototype, "cancelBubble");
  const key = agentTabGetter<KeyboardEvent, string>(keyboardPrototype, "key");
  const code = agentTabGetter<KeyboardEvent, string>(keyboardPrototype, "code");
  const location = agentTabGetter<KeyboardEvent, number>(keyboardPrototype, "location");
  const altKey = agentTabGetter<KeyboardEvent, boolean>(keyboardPrototype, "altKey");
  const ctrlKey = agentTabGetter<KeyboardEvent, boolean>(keyboardPrototype, "ctrlKey");
  const metaKey = agentTabGetter<KeyboardEvent, boolean>(keyboardPrototype, "metaKey");
  const shiftKey = agentTabGetter<KeyboardEvent, boolean>(keyboardPrototype, "shiftKey");
  const repeat = agentTabGetter<KeyboardEvent, boolean>(keyboardPrototype, "repeat");
  const isComposing = agentTabGetter<KeyboardEvent, boolean>(keyboardPrototype, "isComposing");
  const view = agentTabGetter<UIEvent, Window | null>(uiEventPrototype, "view");
  const activeElement = agentTabGetter<Document, Element | null>(documentPrototype, "activeElement");
  const composedPath = eventPrototype.composedPath;
  const preventDefault = eventPrototype.preventDefault;
  const focus = htmlElementPrototype.focus;
  const setTimeout = ownerWindow.setTimeout;
  const clearTimeout = ownerWindow.clearTimeout;
  const apply = ownerWindow.Reflect.apply;
  const isPrototypeOf = Object.prototype.isPrototypeOf;
  if (
    !trusted ||
    !type ||
    !target ||
    !currentTarget ||
    !eventPhase ||
    !bubbles ||
    !cancelable ||
    !defaultPrevented ||
    !cancelBubble ||
    !key ||
    !code ||
    !location ||
    !altKey ||
    !ctrlKey ||
    !metaKey ||
    !shiftKey ||
    !repeat ||
    !isComposing ||
    !view ||
    !activeElement ||
    typeof composedPath !== "function" ||
    typeof preventDefault !== "function" ||
    typeof focus !== "function" ||
    typeof setTimeout !== "function" ||
    typeof clearTimeout !== "function" ||
    typeof apply !== "function" ||
    typeof isPrototypeOf !== "function"
  ) {
    return null;
  }
  return Object.freeze({
    keyboardPrototype,
    capturingPhase: ownerWindow.Event.CAPTURING_PHASE,
    bubblingPhase: ownerWindow.Event.BUBBLING_PHASE,
    apply,
    isPrototypeOf,
    trusted,
    event: Object.freeze({
      type,
      target,
      currentTarget,
      eventPhase,
      bubbles,
      cancelable,
      defaultPrevented,
      cancelBubble,
      composedPath,
      preventDefault,
    }),
    keyboard: Object.freeze({
      key,
      code,
      location,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      repeat,
      isComposing,
    }),
    view,
    activeElement,
    focus,
    setTimeout,
    clearTimeout,
  });
}

function readAgentTabNativeEvent(
  event: Event,
  intrinsics: AgentTabEventIntrinsics,
): AgentTabNativeSnapshot | null {
  try {
    if (
      !Reflect.apply(
        intrinsics.isPrototypeOf,
        intrinsics.keyboardPrototype,
        [event],
      ) ||
      !intrinsics.trusted.isCurrent() ||
      !intrinsics.trusted.matches(event)
    ) {
      return null;
    }
    return Object.freeze({
      type: Reflect.apply(intrinsics.event.type, event, []),
      target: Reflect.apply(intrinsics.event.target, event, []),
      currentTarget: Reflect.apply(intrinsics.event.currentTarget, event, []),
      eventPhase: Reflect.apply(intrinsics.event.eventPhase, event, []),
      bubbles: Reflect.apply(intrinsics.event.bubbles, event, []),
      cancelable: Reflect.apply(intrinsics.event.cancelable, event, []),
      defaultPrevented: Reflect.apply(intrinsics.event.defaultPrevented, event, []),
      cancelBubble: Reflect.apply(intrinsics.event.cancelBubble, event, []),
      path: Object.freeze(Reflect.apply(intrinsics.event.composedPath, event, [])),
      key: Reflect.apply(intrinsics.keyboard.key, event, []),
      code: Reflect.apply(intrinsics.keyboard.code, event, []),
      location: Reflect.apply(intrinsics.keyboard.location, event, []),
      altKey: Reflect.apply(intrinsics.keyboard.altKey, event, []),
      ctrlKey: Reflect.apply(intrinsics.keyboard.ctrlKey, event, []),
      metaKey: Reflect.apply(intrinsics.keyboard.metaKey, event, []),
      shiftKey: Reflect.apply(intrinsics.keyboard.shiftKey, event, []),
      repeat: Reflect.apply(intrinsics.keyboard.repeat, event, []),
      isComposing: Reflect.apply(intrinsics.keyboard.isComposing, event, []),
      isTrusted: intrinsics.trusted.read(event),
      view: Reflect.apply(intrinsics.view, event, []),
    });
  } catch {
    return null;
  }
}

function agentTabPathMatches(
  path: readonly EventTarget[],
  source: HTMLButtonElement,
  ownerDocument: Document,
  terminal: EventTarget,
): boolean {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal;
}

function agentTabNativeSnapshotsMatch(
  first: AgentTabNativeSnapshot,
  second: AgentTabNativeSnapshot,
  includeDispatchState: boolean,
): boolean {
  return first.type === second.type &&
    first.target === second.target &&
    (!includeDispatchState || first.currentTarget === second.currentTarget) &&
    (!includeDispatchState || first.eventPhase === second.eventPhase) &&
    first.bubbles === second.bubbles &&
    first.cancelable === second.cancelable &&
    first.defaultPrevented === second.defaultPrevented &&
    first.cancelBubble === second.cancelBubble &&
    first.path.length === second.path.length &&
    first.path.every((entry, index) => second.path[index] === entry) &&
    first.key === second.key &&
    first.code === second.code &&
    first.location === second.location &&
    first.altKey === second.altKey &&
    first.ctrlKey === second.ctrlKey &&
    first.metaKey === second.metaKey &&
    first.shiftKey === second.shiftKey &&
    first.repeat === second.repeat &&
    first.isComposing === second.isComposing &&
    first.isTrusted === second.isTrusted &&
    first.view === second.view;
}

function readAgentTabReactEvent(
  event: ReactKeyboardEvent<HTMLElement>,
  nativeEvent: KeyboardEvent,
  intrinsics: AgentTabEventIntrinsics,
): AgentTabReactSnapshot | null {
  try {
    const snapshot: AgentTabReactSnapshot = Object.freeze({
      event,
      type: event.type,
      target: event.target,
      currentTarget: event.currentTarget,
      eventPhase: event.eventPhase,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      isTrusted: event.isTrusted,
      nativeEvent: event.nativeEvent,
      key: event.key,
      code: event.code,
      location: event.location,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      view: event.view,
      preventDefault: event.preventDefault,
      stopPropagation: event.stopPropagation,
      isDefaultPrevented: event.isDefaultPrevented,
      isPropagationStopped: event.isPropagationStopped,
    });
    return snapshot.nativeEvent === nativeEvent &&
      agentTabReactSnapshotMatches(snapshot, intrinsics)
        ? snapshot
        : null;
  } catch {
    return null;
  }
}

function agentTabReactSnapshotMatches(
  snapshot: AgentTabReactSnapshot,
  intrinsics: AgentTabEventIntrinsics,
  releasedCurrentTarget = false,
): boolean {
  const { event } = snapshot;
  try {
    return event.type === snapshot.type &&
      event.target === snapshot.target &&
      (
        event.currentTarget === snapshot.currentTarget ||
        (releasedCurrentTarget && event.currentTarget === null)
      ) &&
      event.eventPhase === snapshot.eventPhase &&
      event.bubbles === snapshot.bubbles &&
      event.cancelable === snapshot.cancelable &&
      event.defaultPrevented === snapshot.defaultPrevented &&
      event.isTrusted === snapshot.isTrusted &&
      event.nativeEvent === snapshot.nativeEvent &&
      event.key === snapshot.key &&
      event.code === snapshot.code &&
      event.location === snapshot.location &&
      event.altKey === snapshot.altKey &&
      event.ctrlKey === snapshot.ctrlKey &&
      event.metaKey === snapshot.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      event.repeat === snapshot.repeat &&
      event.view === snapshot.view &&
      event.preventDefault === snapshot.preventDefault &&
      event.stopPropagation === snapshot.stopPropagation &&
      event.isDefaultPrevented === snapshot.isDefaultPrevented &&
      event.isPropagationStopped === snapshot.isPropagationStopped &&
      typeof snapshot.preventDefault === "function" &&
      typeof snapshot.stopPropagation === "function" &&
      typeof snapshot.isDefaultPrevented === "function" &&
      typeof snapshot.isPropagationStopped === "function" &&
      intrinsics.apply(snapshot.isDefaultPrevented, event, []) === false &&
      intrinsics.apply(snapshot.isPropagationStopped, event, []) === false;
  } catch {
    return false;
  }
}

function agentTabDestination(key: string, sourceIndex: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (sourceIndex + 1) % CONNECT_TARGET_IDS.length;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (sourceIndex - 1 + CONNECT_TARGET_IDS.length) % CONNECT_TARGET_IDS.length;
  }
  if (key === "Home") return 0;
  if (key === "End") return CONNECT_TARGET_IDS.length - 1;
  return -1;
}

function setAgentTabElement(
  elements: AgentTabElements,
  role: AgentTabRole,
  element: HTMLElement | null,
) {
  if (role === "list") elements.list = element as HTMLDivElement | null;
  else elements.tabs[role] = element as HTMLButtonElement | null;
}

class AgentTabCoordinator {
  readonly #mount: symbol;
  #disposed = false;
  #pendingDisposal: AgentTabDisposalToken | null = null;
  #current: AgentTabPublication | null = null;
  #replay: AgentTabReplay | null = null;
  #elementOwners = new WeakMap<HTMLElement, AgentTabBinding>();
  #publishedGenerations = new WeakSet<AgentTabGeneration>();
  #replayedGenerations = new WeakSet<AgentTabGeneration>();
  #claimedPublications = new WeakSet<AgentTabPublication>();
  #claimedActions = new WeakSet<AgentTabAction>();
  #claimedReactEvents = new WeakSet<object>();
  #claimedNativeEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  establishLifetime() {
    if (this.#disposed) return;
    const pending = this.#pendingDisposal;
    if (pending) {
      pending.active = false;
      this.#pendingDisposal = null;
    }
    return () => this.#scheduleDisposal();
  }

  createDraft(render: AgentTabRender): AgentTabDraft {
    const generation: AgentTabGeneration = {
      identity: Symbol("agent-tab-generation"),
      render,
      elements: emptyAgentTabElements(),
      bindings: emptyAgentTabBindings(),
      authority: null,
    };
    const draft: AgentTabDraft = {
      identity: Symbol("agent-tab-draft"),
      render,
      generation,
      committed: false,
      retired: false,
    };
    generation.authority = draft;
    return draft;
  }

  bindList(draft: AgentTabDraft, element: HTMLDivElement | null) {
    return this.#bind(draft.generation, "list", element);
  }

  bindTab(
    draft: AgentTabDraft,
    target: ConnectTarget,
    element: HTMLButtonElement | null,
  ) {
    return this.#bind(draft.generation, target, element);
  }

  establish(initialDraft: AgentTabDraft) {
    if (this.#disposed) {
      this.#retireDraft(initialDraft);
      return;
    }
    if (initialDraft.retired) {
      const successor = this.#replaySuccessor(initialDraft);
      return successor ? () => this.retire(successor) : undefined;
    }
    const { generation } = initialDraft;
    if (
      generation.authority !== initialDraft ||
      this.#publishedGenerations.has(generation)
    ) {
      this.#retireDraft(initialDraft);
      return;
    }
    this.#publishedGenerations.add(generation);
    if (this.#current && this.#current.generation !== generation) {
      this.#retirePublication(this.#current, false);
    }
    const publication = this.#createPublication(initialDraft);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(initialDraft);
      return;
    }
    return () => this.retire(publication);
  }

  retire(publication: AgentTabPublication) {
    const existingReplay = this.#replay;
    if (existingReplay?.publication === publication) {
      existingReplay.layoutRetired = true;
      return;
    }
    if (publication.retired) return;
    const replay = this.#beginReplay(publication);
    if (replay) replay.layoutRetired = true;
    this.#retirePublication(publication, Boolean(replay));
  }

  dispose() {
    if (this.#disposed) return;
    const pending = this.#pendingDisposal;
    if (pending) {
      pending.active = false;
      this.#pendingDisposal = null;
    }
    this.#disposed = true;
    const replay = this.#replay;
    if (replay) {
      this.#invalidateReplay(replay);
    }
    const publication = this.#current;
    if (publication) {
      this.#retirePublication(publication, false);
      this.#retireGeneration(publication.generation);
    }
  }

  activate(
    generation: AgentTabGeneration,
    sourceId: ConnectTarget,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    const publication = this.#current;
    const action = publication?.actions[sourceId];
    const source = action?.source;
    const nativeEvent = event?.nativeEvent;
    const route = publication?.pendingRoute;
    const snapshot = publication && nativeEvent
      ? readAgentTabNativeEvent(nativeEvent, publication.intrinsics)
      : null;
    const bubble = publication && nativeEvent instanceof publication.ownerWindow.KeyboardEvent
      ? readAgentTabReactEvent(
          event as ReactKeyboardEvent<HTMLElement>,
          nativeEvent,
          publication.intrinsics,
        )
      : null;
    if (route && route.nativeEvent === nativeEvent) {
      publication.pendingRoute = null;
    }
    if (
      !publication ||
      !action ||
      !source ||
      !route ||
      !snapshot ||
      !bubble ||
      route.invalid ||
      route.publication !== publication ||
      route.generation !== generation ||
      route.action !== action ||
      route.sourceId !== sourceId ||
      route.source !== source ||
      route.destinationId === sourceId ||
      route.destination !== publication.tabs[route.destinationId] ||
      route.nativeEvent !== nativeEvent ||
      !route.captureSnapshot ||
      !route.captureNativeSnapshot ||
      route.captureSnapshot.event === bubble.event ||
      publication.generation !== generation ||
      publication.draft !== generation.authority ||
      publication.retired ||
      publication.draft.retired ||
      publication.render.selected !== sourceId ||
      publication.render.selectedRef.current !== sourceId ||
      action.generation !== generation ||
      action.render !== publication.render ||
      action.sourceId !== sourceId ||
      action.sourceIndex !== CONNECT_TARGET_IDS.indexOf(sourceId) ||
      action.source !== source ||
      action.ownerDocument !== publication.ownerDocument ||
      action.order !== publication.render.order ||
      !Object.isFrozen(action) ||
      bubble.type !== "keydown" ||
      bubble.currentTarget !== source ||
      bubble.target !== source ||
      bubble.eventPhase !== publication.intrinsics.bubblingPhase ||
      bubble.bubbles !== snapshot.bubbles ||
      bubble.cancelable !== snapshot.cancelable ||
      bubble.defaultPrevented ||
      bubble.isTrusted !== snapshot.isTrusted ||
      bubble.key !== snapshot.key ||
      bubble.code !== snapshot.code ||
      bubble.location !== snapshot.location ||
      bubble.altKey !== snapshot.altKey ||
      bubble.ctrlKey !== snapshot.ctrlKey ||
      bubble.metaKey !== snapshot.metaKey ||
      bubble.shiftKey !== snapshot.shiftKey ||
      bubble.repeat !== snapshot.repeat ||
      bubble.view !== snapshot.view ||
      snapshot.type !== "keydown" ||
      snapshot.target !== source ||
      snapshot.currentTarget === null ||
      snapshot.eventPhase !== publication.intrinsics.bubblingPhase ||
      !snapshot.bubbles ||
      !snapshot.cancelable ||
      snapshot.defaultPrevented ||
      snapshot.cancelBubble ||
      !snapshot.isTrusted ||
      snapshot.altKey ||
      snapshot.ctrlKey ||
      snapshot.metaKey ||
      snapshot.shiftKey ||
      snapshot.repeat ||
      snapshot.isComposing ||
      (snapshot.view !== null &&
        snapshot.view !== publication.ownerWindow &&
        snapshot.view !== route.windowProof.receiver) ||
      !snapshot.path.includes(snapshot.currentTarget) ||
      !agentTabNativeSnapshotsMatch(route.windowSnapshot, snapshot, false) ||
      !agentTabNativeSnapshotsMatch(
        route.captureNativeSnapshot,
        snapshot,
        false,
      ) ||
      route.captureNativeSnapshot.currentTarget !== snapshot.currentTarget ||
      route.captureNativeSnapshot.eventPhase !==
        publication.intrinsics.capturingPhase ||
      !this.#windowProofIsCurrent(publication, route) ||
      !agentTabReactSnapshotMatches(
        route.captureSnapshot,
        publication.intrinsics,
        true,
      ) ||
      !agentTabReactSnapshotMatches(bubble, publication.intrinsics) ||
      Reflect.apply(
        publication.intrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== source ||
      this.#claimedPublications.has(publication) ||
      this.#claimedActions.has(action) ||
      this.#claimedReactEvents.has(route.captureSnapshot.event) ||
      this.#claimedReactEvents.has(event) ||
      this.#claimedNativeEvents.has(nativeEvent) ||
      !this.#actionIsCurrent(publication, action) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return;
    }

    const claim = Object.freeze({
      identity: Symbol("agent-tab-claim"),
      authority: publication.render.authority,
      render: publication.render,
      publication,
      action,
      source,
      destination: route.destination,
      sourceId,
      destinationId: route.destinationId,
      capture: route.captureSnapshot,
      bubble,
      nativeEvent,
      windowProof: route.windowProof,
      cancellation: Object.freeze({
        capturePreventDefault: route.captureSnapshot.preventDefault,
        captureStopPropagation: route.captureSnapshot.stopPropagation,
        captureIsDefaultPrevented: route.captureSnapshot.isDefaultPrevented,
        captureIsPropagationStopped:
          route.captureSnapshot.isPropagationStopped,
        bubblePreventDefault: bubble.preventDefault,
        bubbleStopPropagation: bubble.stopPropagation,
        bubbleIsDefaultPrevented: bubble.isDefaultPrevented,
        bubbleIsPropagationStopped: bubble.isPropagationStopped,
      }),
      preventDefault: publication.intrinsics.event.preventDefault,
      setTarget: publication.render.setTarget,
      focus: publication.intrinsics.focus,
    });
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(route.captureSnapshot.event);
    this.#claimedReactEvents.add(event);
    this.#claimedNativeEvents.add(nativeEvent);
    const immediateSnapshot = readAgentTabNativeEvent(
      claim.nativeEvent,
      claim.publication.intrinsics,
    );
    if (
      !immediateSnapshot ||
      !agentTabNativeSnapshotsMatch(snapshot, immediateSnapshot, true) ||
      !this.#windowProofIsCurrent(claim.publication, route) ||
      !agentTabReactSnapshotMatches(
        claim.capture,
        claim.publication.intrinsics,
        true,
      ) ||
      !agentTabReactSnapshotMatches(
        claim.bubble,
        claim.publication.intrinsics,
      ) ||
      !this.#publicationIsCurrent(claim.publication) ||
      Reflect.apply(
        claim.publication.intrinsics.activeElement,
        claim.publication.ownerDocument,
        [],
      ) !== claim.source
    ) {
      return;
    }

    Reflect.apply(claim.preventDefault, claim.nativeEvent, []);
    if (
      !Reflect.apply(
        claim.publication.intrinsics.event.defaultPrevented,
        claim.nativeEvent,
        [],
      )
    ) {
      return;
    }
    claim.render.selectedRef.current = claim.destinationId;
    claim.setTarget(claim.destinationId);
    Reflect.apply(claim.focus, claim.destination, [
      { preventScroll: true },
    ]);
  }

  capture(
    generation: AgentTabGeneration,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const publication = this.#current;
    const nativeEvent = event?.nativeEvent;
    const route = publication?.pendingRoute;
    if (
      !publication ||
      !route ||
      route.nativeEvent !== nativeEvent ||
      route.invalid
    ) {
      return;
    }
    const nativeSnapshot = readAgentTabNativeEvent(
      nativeEvent,
      publication.intrinsics,
    );
    const capture = nativeEvent instanceof publication.ownerWindow.KeyboardEvent
      ? readAgentTabReactEvent(
          event as ReactKeyboardEvent<HTMLElement>,
          nativeEvent,
          publication.intrinsics,
        )
      : null;
    if (
      !nativeSnapshot ||
      !capture ||
      route.captureSnapshot ||
      route.captureNativeSnapshot ||
      route.publication !== publication ||
      route.generation !== generation ||
      publication.generation !== generation ||
      capture.type !== "keydown" ||
      capture.currentTarget !== publication.list ||
      capture.target !== route.source ||
      capture.eventPhase !== publication.intrinsics.capturingPhase ||
      capture.bubbles !== nativeSnapshot.bubbles ||
      capture.cancelable !== nativeSnapshot.cancelable ||
      capture.defaultPrevented ||
      capture.isTrusted !== nativeSnapshot.isTrusted ||
      capture.key !== nativeSnapshot.key ||
      capture.code !== nativeSnapshot.code ||
      capture.location !== nativeSnapshot.location ||
      capture.altKey !== nativeSnapshot.altKey ||
      capture.ctrlKey !== nativeSnapshot.ctrlKey ||
      capture.metaKey !== nativeSnapshot.metaKey ||
      capture.shiftKey !== nativeSnapshot.shiftKey ||
      capture.repeat !== nativeSnapshot.repeat ||
      capture.view !== nativeSnapshot.view ||
      nativeSnapshot.currentTarget === null ||
      nativeSnapshot.eventPhase !== publication.intrinsics.capturingPhase ||
      !nativeSnapshot.path.includes(nativeSnapshot.currentTarget) ||
      !agentTabNativeSnapshotsMatch(
        route.windowSnapshot,
        nativeSnapshot,
        false,
      ) ||
      !this.#windowProofIsCurrent(publication, route) ||
      !this.#actionIsCurrent(publication, route.action) ||
      !this.#publicationIsCurrent(publication)
    ) {
      route.invalid = true;
      return;
    }
    route.captureSnapshot = capture;
    route.captureNativeSnapshot = nativeSnapshot;
  }

  #recordWindowEvent(
    publication: AgentTabPublication,
    listener: AgentTabWindowListener,
    receiver: EventTarget,
    nativeEvent: Event,
  ) {
    const previous = publication.pendingRoute;
    if (previous) {
      previous.invalid = true;
      publication.pendingRoute = null;
    }
    const snapshot = readAgentTabNativeEvent(
      nativeEvent,
      publication.intrinsics,
    );
    if (
      !snapshot ||
      !(nativeEvent instanceof publication.ownerWindow.KeyboardEvent) ||
      !listener.active ||
      listener !== publication.windowListener ||
      snapshot.type !== "keydown" ||
      snapshot.target === null ||
      snapshot.currentTarget !== receiver ||
      snapshot.eventPhase !== publication.intrinsics.capturingPhase ||
      !snapshot.bubbles ||
      !snapshot.cancelable ||
      snapshot.defaultPrevented ||
      snapshot.cancelBubble ||
      !snapshot.isTrusted ||
      snapshot.altKey ||
      snapshot.ctrlKey ||
      snapshot.metaKey ||
      snapshot.shiftKey ||
      snapshot.repeat ||
      snapshot.isComposing ||
      (snapshot.view !== null &&
        snapshot.view !== publication.ownerWindow &&
        snapshot.view !== receiver) ||
      snapshot.path.at(-1) !== receiver ||
      !this.#windowListenerIsCurrent(publication) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return;
    }
    const sourceId = CONNECT_TARGET_IDS.find(
      (id) => publication.tabs[id] === snapshot.target,
    );
    const action = sourceId ? publication.actions[sourceId] : undefined;
    const destinationIndex = action
      ? agentTabDestination(snapshot.key, action.sourceIndex)
      : -1;
    const destinationId = destinationIndex >= 0
      ? publication.render.order[destinationIndex]
      : undefined;
    const destination = destinationId
      ? publication.tabs[destinationId]
      : undefined;
    if (
      !sourceId ||
      !action ||
      !destinationId ||
      !destination ||
      destinationId === sourceId ||
      publication.render.selected !== sourceId ||
      publication.render.selectedRef.current !== sourceId ||
      !agentTabPathMatches(
        snapshot.path,
        action.source,
        publication.ownerDocument,
        receiver,
      ) ||
      Reflect.apply(
        publication.intrinsics.activeElement,
        publication.ownerDocument,
        [],
      ) !== action.source ||
      !this.#actionIsCurrent(publication, action)
    ) {
      return;
    }
    const windowProof: AgentTabWindowProof = Object.freeze({
      identity: Symbol("agent-tab-window-proof"),
      listener,
      receiver,
      currentTarget: snapshot.currentTarget,
      pathTerminal: snapshot.path.at(-1)!,
    });
    publication.pendingRoute = {
      identity: Symbol("agent-tab-event-route"),
      publication,
      generation: publication.generation,
      action,
      sourceId,
      source: action.source,
      destinationId,
      destination,
      nativeEvent,
      windowSnapshot: snapshot,
      windowProof,
      captureSnapshot: null,
      captureNativeSnapshot: null,
      invalid: false,
    };
  }

  #windowListenerIsCurrent(publication: AgentTabPublication): boolean {
    const listener = publication.windowListener;
    try {
      return listener.active &&
        listener.target === publication.ownerWindow &&
        publication.ownerWindow.addEventListener === listener.add &&
        publication.ownerWindow.removeEventListener === listener.remove;
    } catch {
      return false;
    }
  }

  #windowProofIsCurrent(
    publication: AgentTabPublication,
    route: AgentTabEventRoute,
  ): boolean {
    const { windowProof } = route;
    return route.publication === publication &&
      windowProof.listener === publication.windowListener &&
      windowProof.receiver === windowProof.currentTarget &&
      windowProof.receiver === windowProof.pathTerminal &&
      route.windowSnapshot.currentTarget === windowProof.currentTarget &&
      route.windowSnapshot.path.at(-1) === windowProof.pathTerminal &&
      this.#windowListenerIsCurrent(publication);
  }

  #bind(
    generation: AgentTabGeneration,
    role: AgentTabRole,
    element: HTMLElement | null,
  ): (() => void) | undefined {
    const previous = generation.bindings[role];
    if (element === null) {
      if (previous) this.#release(previous, "null");
      return;
    }
    if (previous?.active && previous.element === element) return;
    if (
      previous?.active &&
      (
        !element.isConnected ||
        element.ownerDocument !== previous.element.ownerDocument
      )
    ) {
      return;
    }
    if (previous) this.#release(previous, "replace");
    if (this.#replay && this.#replay.generation !== generation) {
      this.#invalidateReplay(this.#replay);
    }
    if (!this.#canBind(generation)) return;

    const replay = this.#replay;
    if (replay?.generation === generation) {
      const expected = replay.expected[role];
      if (
        replay.invalid ||
        !replay.released.has(role) ||
        replay.rebound.has(role) ||
        expected.element !== element
      ) {
        this.#invalidateReplay(replay);
        return;
      }
    }

    const displaced = this.#elementOwners.get(element);
    if (displaced) {
      if (
        displaced.generation !== generation &&
        this.#current?.generation === displaced.generation &&
        generation.authority?.retired
      ) {
        return;
      }
      this.#release(displaced, "replace");
      if (!this.#canBind(generation)) return;
    }

    const binding: AgentTabBinding = {
      identity: Symbol(`agent-tab-${role}-binding`),
      generation,
      role,
      element,
      active: true,
    };
    generation.bindings[role] = binding;
    setAgentTabElement(generation.elements, role, element);
    this.#elementOwners.set(element, binding);
    if (replay?.generation === generation) replay.rebound.set(role, binding);
    return () => this.#release(binding, "cleanup");
  }

  #scheduleDisposal() {
    if (this.#disposed || this.#pendingDisposal) return;
    const token: AgentTabDisposalToken = {
      identity: Symbol("agent-tab-disposal"),
      coordinator: this,
      active: true,
    };
    this.#pendingDisposal = token;
    queueAgentTabCoordinatorDisposal(() => {
      if (
        !token.active ||
        token.coordinator !== this ||
        this.#pendingDisposal !== token ||
        this.#pendingDisposal.identity !== token.identity
      ) {
        return;
      }
      token.active = false;
      this.#pendingDisposal = null;
      this.dispose();
    });
  }

  #release(
    binding: AgentTabBinding,
    source: "cleanup" | "null" | "replace",
  ) {
    if (!binding.active) return;
    const publication = this.#current;
    const startsReplay =
      publication?.generation === binding.generation &&
      publication.bindings[binding.role] === binding
        ? this.#beginReplay(publication)
        : null;
    const replay = this.#replay;
    binding.active = false;
    const { generation, role, element } = binding;
    if (generation.bindings[role] === binding) {
      generation.bindings[role] = null;
      setAgentTabElement(generation.elements, role, null);
    }
    if (this.#elementOwners.get(element) === binding) {
      this.#elementOwners.delete(element);
    }

    if (replay?.generation === generation) {
      if (
        source !== "cleanup" ||
        replay.expected[role] !== binding ||
        replay.released.has(role) ||
        replay.rebound.has(role)
      ) {
        replay.invalid = true;
      } else {
        replay.released.add(role);
      }
    }

    if (publication?.generation === generation) {
      this.#retirePublication(
        publication,
        Boolean(startsReplay && !startsReplay.invalid),
      );
    } else if (!replay && generation.authority && !generation.authority.retired) {
      this.#retireDraft(generation.authority);
    }
    if (replay?.invalid) this.#invalidateReplay(replay);
  }

  #canBind(generation: AgentTabGeneration): boolean {
    const authority = generation.authority;
    return Boolean(
      authority &&
      (
        !authority.retired ||
        this.#current?.generation === generation ||
        (this.#replay?.generation === generation && !this.#replay.invalid)
      ),
    );
  }

  #beginReplay(publication: AgentTabPublication): AgentTabReplay | null {
    if (this.#replay?.publication === publication) return this.#replay;
    if (
      this.#replay ||
      publication.retired ||
      this.#claimedPublications.has(publication) ||
      this.#current !== publication ||
      this.#replayedGenerations.has(publication.generation) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return null;
    }
    const replay: AgentTabReplay = {
      identity: Symbol("agent-tab-replay"),
      publication,
      generation: publication.generation,
      expected: publication.bindings,
      released: new Set(),
      rebound: new Map(),
      expiry: {
        identity: Symbol("agent-tab-replay-expiry"),
        active: true,
        handle: null,
        cancel: null,
      },
      layoutRetired: false,
      invalid: false,
    };
    this.#replay = replay;
    const { expiry, identity } = replay;
    const expiryIdentity = expiry.identity;
    expiry.cancel = (handle) => {
      Reflect.apply(
        publication.intrinsics.clearTimeout,
        publication.ownerWindow,
        [handle],
      );
    };
    expiry.handle = Reflect.apply(
      publication.intrinsics.setTimeout,
      publication.ownerWindow,
      [
        () => {
          if (!expiry.active) return;
          const current = this.#replay;
          if (
            !current ||
            current.identity !== identity ||
            current.expiry !== expiry ||
            current.expiry.identity !== expiryIdentity
          ) {
            return;
          }
          expiry.handle = null;
          expiry.cancel = null;
          this.#invalidateReplay(current);
        },
        0,
      ],
    );
    return replay;
  }

  #replaySuccessor(initialDraft: AgentTabDraft): AgentTabPublication | null {
    const replay = this.#replay;
    const { generation } = initialDraft;
    if (
      !replay ||
      replay.publication.draft !== initialDraft ||
      replay.generation !== generation ||
      generation.authority !== initialDraft ||
      !initialDraft.committed ||
      !initialDraft.retired ||
      !replay.publication.retired ||
      replay.invalid ||
      !replay.layoutRetired ||
      this.#current ||
      this.#replayedGenerations.has(generation) ||
      replay.released.size !== AGENT_TAB_ROLES.length ||
      replay.rebound.size !== AGENT_TAB_ROLES.length ||
      AGENT_TAB_ROLES.some((role) => {
        const expected = replay.expected[role];
        const rebound = replay.rebound.get(role);
        return (
          !rebound ||
          rebound.element !== expected.element ||
          generation.bindings[role] !== rebound ||
          !this.#ownsBinding(rebound)
        );
      }) ||
      !this.#renderIsCurrent(initialDraft.render) ||
      !this.#mutationFree(replay.publication) ||
      !this.#hierarchyIsCurrent(
        generation,
        initialDraft.render,
        replay.publication.dom,
        replay.publication.placement,
      )
    ) {
      if (replay) this.#invalidateReplay(replay);
      return null;
    }

    const successor: AgentTabDraft = {
      identity: Symbol("agent-tab-successor-draft"),
      render: initialDraft.render,
      generation,
      committed: false,
      retired: false,
    };
    this.#replayedGenerations.add(generation);
    generation.authority = successor;
    const publication = this.#createPublication(
      successor,
      replay.publication.dom,
      replay.publication.placement,
      replay.publication.intrinsics,
    );
    this.#finishReplay(replay);
    this.#disconnect(replay.publication);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(successor);
      return null;
    }
    return publication;
  }

  #createPublication(
    draft: AgentTabDraft,
    expectedDom?: AgentTabDomSnapshot,
    expectedPlacement?: readonly AgentTabPlacement[],
    expectedIntrinsics?: AgentTabEventIntrinsics,
  ): AgentTabPublication | null {
    const { generation, render } = draft;
    if (!this.#hierarchyIsCurrent(
      generation,
      render,
      expectedDom,
      expectedPlacement,
    )) {
      return null;
    }
    const list = generation.elements.list!;
    const tabs = Object.freeze({
      "copilot-cli": generation.elements.tabs["copilot-cli"]!,
      "mcp-clients": generation.elements.tabs["mcp-clients"]!,
      "other-clients": generation.elements.tabs["other-clients"]!,
      "copilot-app": generation.elements.tabs["copilot-app"]!,
    });
    const bindings = Object.freeze({
      list: generation.bindings.list!,
      "copilot-cli": generation.bindings["copilot-cli"]!,
      "mcp-clients": generation.bindings["mcp-clients"]!,
      "other-clients": generation.bindings["other-clients"]!,
      "copilot-app": generation.bindings["copilot-app"]!,
    });
    const ownerDocument = list.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placement = expectedPlacement ??
      snapshotAgentTabPlacement(list, ownerDocument);
    const intrinsics = expectedIntrinsics ??
      (ownerWindow ? captureAgentTabIntrinsics(ownerWindow) : null);
    if (!ownerWindow || !placement || !intrinsics) return null;
    const add = ownerWindow.addEventListener;
    const remove = ownerWindow.removeEventListener;
    if (typeof add !== "function" || typeof remove !== "function") return null;
    const actions = Object.freeze(Object.fromEntries(
      CONNECT_TARGETS.map(({ id }, sourceIndex) => [
        id,
        Object.freeze({
          identity: Symbol(`agent-tab-${id}-action`),
          generation,
          render,
          sourceId: id,
          sourceIndex,
          source: tabs[id],
          ownerDocument,
          order: render.order,
        } satisfies AgentTabAction),
      ]),
    ) as Record<ConnectTarget, AgentTabAction>);
    let publication!: AgentTabPublication;
    const coordinator = this;
    const callback: EventListener = function (this: EventTarget, event: Event) {
      coordinator.#recordWindowEvent(publication, windowListener, this, event);
    };
    const windowListener: AgentTabWindowListener = {
      identity: Symbol("agent-tab-window-listener"),
      target: ownerWindow,
      add,
      remove,
      callback,
      active: false,
    };
    publication = {
      identity: Symbol("agent-tab-publication"),
      draft,
      generation,
      render,
      list,
      tabs,
      bindings,
      ownerDocument,
      ownerWindow,
      placement,
      dom: expectedDom ?? snapshotAgentTabDom(list),
      intrinsics,
      actions,
      windowListener,
      pendingRoute: null,
      retired: false,
      mutated: false,
      observer: null,
    };
    return publication;
  }

  #publish(publication: AgentTabPublication): boolean {
    if (
      this.#current ||
      publication.retired ||
      publication.draft.retired ||
      publication.generation.authority !== publication.draft
    ) {
      return false;
    }
    const MutationObserverConstructor =
      publication.ownerWindow.MutationObserver;
    if (!MutationObserverConstructor) return false;
    Reflect.apply(
      publication.windowListener.add,
      publication.windowListener.target,
      ["keydown", publication.windowListener.callback, true],
    );
    publication.windowListener.active = true;
    const observer = new MutationObserverConstructor((records) => {
      this.#recordMutations(publication, records);
    });
    observer.observe(publication.list, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    const observedParents = new Set<Node>();
    for (const { parent } of publication.placement) {
      if (parent && !observedParents.has(parent)) {
        observedParents.add(parent);
        observer.observe(parent, { childList: true });
      }
    }
    publication.observer = observer;
    publication.draft.committed = true;
    this.#current = publication;
    return true;
  }

  #retirePublication(
    publication: AgentTabPublication,
    preserveObserver: boolean,
  ) {
    if (!publication.retired) {
      publication.retired = true;
      publication.draft.retired = true;
    }
    if (this.#current === publication) this.#current = null;
    if (!preserveObserver) this.#disconnect(publication);
  }

  #retireDraft(draft: AgentTabDraft) {
    draft.retired = true;
    if (this.#current?.draft === draft) {
      this.#retirePublication(this.#current, false);
    }
  }

  #invalidateReplay(replay: AgentTabReplay) {
    if (this.#replay === replay) this.#replay = null;
    replay.invalid = true;
    this.#deactivateReplayExpiry(replay);
    this.#disconnect(replay.publication);
    if (this.#current === replay.publication) this.#current = null;
    replay.publication.retired = true;
    replay.publication.draft.retired = true;
    const bindings = new Set<AgentTabBinding>([
      ...Object.values(replay.expected),
      ...replay.rebound.values(),
      ...Object.values(replay.generation.bindings).filter(
        (binding): binding is AgentTabBinding => binding !== null,
      ),
    ]);
    for (const binding of bindings) {
      binding.active = false;
      if (this.#elementOwners.get(binding.element) === binding) {
        this.#elementOwners.delete(binding.element);
      }
    }
    this.#retireGeneration(replay.generation);
    replay.released.clear();
    replay.rebound.clear();
  }

  #finishReplay(replay: AgentTabReplay) {
    if (this.#replay === replay) this.#replay = null;
    this.#deactivateReplayExpiry(replay);
    replay.released.clear();
    replay.rebound.clear();
  }

  #deactivateReplayExpiry(replay: AgentTabReplay) {
    const { expiry } = replay;
    if (!expiry.active) return;
    expiry.active = false;
    const { handle, cancel } = expiry;
    expiry.handle = null;
    expiry.cancel = null;
    if (handle !== null && cancel) cancel(handle);
  }

  #retireGeneration(generation: AgentTabGeneration) {
    generation.authority = null;
    for (const role of AGENT_TAB_ROLES) {
      const binding = generation.bindings[role];
      if (binding) {
        binding.active = false;
        if (this.#elementOwners.get(binding.element) === binding) {
          this.#elementOwners.delete(binding.element);
        }
      }
      generation.bindings[role] = null;
      setAgentTabElement(generation.elements, role, null);
    }
  }

  #disconnect(publication: AgentTabPublication) {
    publication.pendingRoute = null;
    const listener = publication.windowListener;
    if (listener.active) {
      listener.active = false;
      Reflect.apply(listener.remove, listener.target, [
        "keydown",
        listener.callback,
        true,
      ]);
    }
    publication.observer?.disconnect();
    publication.observer = null;
  }

  #recordMutations(
    publication: AgentTabPublication,
    records: readonly MutationRecord[],
  ) {
    if (publication.mutated) return;
    publication.mutated = records.some((record) =>
      publication.list.contains(record.target) ||
      agentTabMutationTouchesPlacement(publication.placement, record));
    if (publication.mutated && this.#replay?.publication === publication) {
      this.#invalidateReplay(this.#replay);
    }
  }

  #mutationFree(publication: AgentTabPublication): boolean {
    const records = publication.observer?.takeRecords();
    if (records?.length) this.#recordMutations(publication, records);
    return !publication.mutated;
  }

  #ownsBinding(binding: AgentTabBinding): boolean {
    return binding.active &&
      binding.generation.bindings[binding.role] === binding &&
      this.#elementOwners.get(binding.element) === binding;
  }

  #renderIsCurrent(render: AgentTabRender): boolean {
    const authority = render.authority;
    return render.mount === this.#mount &&
      Object.isFrozen(render) &&
      Object.isFrozen(authority) &&
      render.authorityRef.current === authority &&
      authority.mount === this.#mount &&
      render.selectedRef.current === render.selected &&
      render.order === CONNECT_TARGET_IDS &&
      render.order.length === 4 &&
      render.order.every((target, index) =>
        target === CONNECT_TARGETS[index]?.id) &&
      typeof render.tabsId === "string" &&
      render.tabsId.length > 0 &&
      typeof render.setTarget === "function";
  }

  #hierarchyIsCurrent(
    generation: AgentTabGeneration,
    render: AgentTabRender,
    expectedDom?: AgentTabDomSnapshot,
    expectedPlacement?: readonly AgentTabPlacement[],
  ): boolean {
    const list = generation.elements.list;
    const listBinding = generation.bindings.list;
    if (
      !list ||
      !listBinding ||
      listBinding.element !== list ||
      !this.#ownsBinding(listBinding) ||
      generation.render !== render ||
      !this.#renderIsCurrent(render)
    ) {
      return false;
    }
    const ownerDocument = list.ownerDocument;
    if (
      !list.isConnected ||
      list.getRootNode() !== ownerDocument ||
      list.tagName.toLowerCase() !== "div" ||
      list.className !== AGENT_TABLIST_CLASS ||
      list.getAttribute("role") !== "tablist" ||
      list.getAttribute("aria-label") !== "Agent client" ||
      list.children.length !== CONNECT_TARGETS.length ||
      (expectedDom && expectedDom.node !== list) ||
      (expectedDom && !agentTabDomMatches(expectedDom)) ||
      (expectedPlacement && expectedPlacement[0]?.node !== list) ||
      (expectedPlacement &&
        !agentTabPlacementMatches(list, ownerDocument, expectedPlacement))
    ) {
      return false;
    }

    const elements = new Set<HTMLElement>([list]);
    for (let index = 0; index < CONNECT_TARGETS.length; index++) {
      const definition = CONNECT_TARGETS[index]!;
      const tab = generation.elements.tabs[definition.id];
      const binding = generation.bindings[definition.id];
      const selected = definition.id === render.selected;
      if (
        !tab ||
        !binding ||
        binding.element !== tab ||
        !this.#ownsBinding(binding) ||
        elements.has(tab) ||
        !tab.isConnected ||
        tab.ownerDocument !== ownerDocument ||
        tab.getRootNode() !== ownerDocument ||
        tab.parentElement !== list ||
        list.children.item(index) !== tab ||
        tab.tagName.toLowerCase() !== "button" ||
        tab.getAttribute("type") !== "button" ||
        tab.type !== "button" ||
        tab.disabled ||
        tab.matches(":disabled") ||
        tab.getAttribute("role") !== "tab" ||
        tab.id !== `${render.tabsId}-${definition.id}` ||
        tab.getAttribute("aria-selected") !== String(selected) ||
        tab.getAttribute("aria-controls") !== `${render.tabsId}-panel` ||
        tab.tabIndex !== (selected ? 0 : -1) ||
        tab.className !== cn(
          AGENT_TAB_CLASS,
          selected
            ? "bg-surface text-ink shadow-sm"
            : "text-ink-3 hover:text-ink",
        ) ||
        tab.getAttribute("data-testid") !==
          `agent-connect-tab-${definition.id}` ||
        tab.children.length !== 0 ||
        tab.textContent !== definition.label
      ) {
        return false;
      }
      elements.add(tab);
    }
    return true;
  }

  #actionIsCurrent(
    publication: AgentTabPublication,
    action: AgentTabAction,
  ): boolean {
    return Object.isFrozen(publication.actions) &&
      Object.isFrozen(action) &&
      publication.actions[action.sourceId] === action &&
      action.generation === publication.generation &&
      action.render === publication.render &&
      action.source === publication.tabs[action.sourceId] &&
      action.ownerDocument === publication.ownerDocument &&
      action.order === publication.render.order &&
      action.sourceIndex === publication.render.order.indexOf(action.sourceId) &&
      !this.#claimedActions.has(action);
  }

  #publicationIsCurrent(publication: AgentTabPublication): boolean {
    return this.#current === publication &&
      !publication.retired &&
      !publication.draft.retired &&
      publication.generation.authority === publication.draft &&
      publication.render === publication.generation.render &&
      this.#windowListenerIsCurrent(publication) &&
      publication.bindings.list === publication.generation.bindings.list &&
      CONNECT_TARGET_IDS.every((id) =>
        publication.bindings[id] === publication.generation.bindings[id] &&
        publication.tabs[id] === publication.generation.elements.tabs[id]) &&
      publication.dom.node === publication.list &&
      publication.placement[0]?.node === publication.list &&
      agentTabPlacementMatches(
        publication.list,
        publication.ownerDocument,
        publication.placement,
      ) &&
      this.#mutationFree(publication) &&
      agentTabDomMatches(publication.dom) &&
      this.#hierarchyIsCurrent(
        publication.generation,
        publication.render,
        publication.dom,
        publication.placement,
      );
  }
}

export interface AgentConnectCardProps {
  /** Server origin to put in the config (window.location.origin in the browser). */
  origin: string;
  /** That token's scope, printed next to the allow-tool line (and narrowing it). */
  scope?: TokenScopeName | null;
  /** Shown for step 1; when omitted a link to /settings#tokens is rendered. */
  onCreateToken?: () => void;
  /** Renders a close button; the caller remembers the dismissal. */
  onDismiss?: () => void;
  /** Hide step 1 when the host already provides token management. */
  hideTokenStep?: boolean;
  className?: string;
}

/**
 * "Connect an agent" in three steps: a token, the MCP config for this host, and the sentence to say to
 * Copilot. Used by the Keep-an-agent-here dialog (first run) and token management.
 */
export function AgentConnectCard({ origin, scope, onCreateToken, onDismiss, hideTokenStep, className }: AgentConnectCardProps) {
  const base = origin;
  const [target, setTarget] = useState<ConnectTarget>("copilot-cli");
  const [mount] = useState(() => Symbol("agent-connect-card"));
  const authority = useMemo<AgentConnectAuthority>(
    () => Object.freeze({ mount, origin, scope, onCreateToken, onDismiss, hideTokenStep, className }),
    [className, hideTokenStep, mount, onCreateToken, onDismiss, origin, scope],
  );
  const authorityRef = useRef<AgentConnectAuthority | null>(null);
  const tabOwnersRef = useRef(new Map<ConnectTarget, TabOwner>());
  const createTokenOwnerRef = useRef<ControlOwner | null>(null);
  const dismissOwnerRef = useRef<ControlOwner | null>(null);
  const selectedTargetRef = useRef<ConnectTarget>("copilot-cli");
  const [tabCoordinator] = useState(() => new AgentTabCoordinator(mount));
  const stdioConfig = mcpConfigFor(base, TOKEN_PLACEHOLDER, target === "mcp-clients" ? "servers" : "mcpServers");
  const tabsId = useId();
  // eslint-disable-next-line react-hooks/refs -- authorityRef/selectedTargetRef pass by identity; only committed coordinator layout/event paths dereference them.
  const tabRender: AgentTabRender = Object.freeze({
    identity: Symbol("agent-tab-render"),
    mount,
    authority,
    authorityRef,
    selectedRef: selectedTargetRef,
    selected: target,
    tabsId,
    order: CONNECT_TARGET_IDS,
    setTarget,
  });
  const tabDraft = tabCoordinator.createDraft(tabRender);
  const config = target === "mcp-clients" ? mcpVsCodeConfigFor(base) : mcpHttpConfigFor(base);
  const ownsAuthority = (candidate: AgentConnectAuthority) =>
    authorityRef.current === candidate &&
    candidate.mount === mount &&
    candidate.origin === origin &&
    Object.is(candidate.scope, scope) &&
    candidate.onCreateToken === onCreateToken &&
    candidate.onDismiss === onDismiss &&
    Object.is(candidate.hideTokenStep, hideTokenStep) &&
    candidate.className === className;
  const ownsTab = (candidate: AgentConnectAuthority, tab: ConnectTarget, element: HTMLButtonElement) => {
    const owner = tabOwnersRef.current.get(tab);
    return ownsAuthority(candidate) && owner?.authority === candidate && owner.element === element && element.isConnected;
  };
  const setTabElement = useCallback((candidate: AgentConnectAuthority, tab: ConnectTarget, element: HTMLButtonElement | null) => {
    if (element) {
      tabOwnersRef.current.set(tab, { authority: candidate, element });
    } else if (tabOwnersRef.current.get(tab)?.authority === candidate) {
      tabOwnersRef.current.delete(tab);
    }
  }, []);
  const setControlElement = useCallback((
    ownerRef: React.RefObject<ControlOwner | null>,
    candidate: AgentConnectAuthority,
    element: HTMLButtonElement | null,
  ) => {
    if (element) {
      ownerRef.current = { authority: candidate, element };
    } else if (ownerRef.current?.authority === candidate) {
      ownerRef.current = null;
    }
  }, []);
  const selectTarget = (candidate: AgentConnectAuthority, next: ConnectTarget, element: HTMLButtonElement) => {
    if (!ownsTab(candidate, next, element) || selectedTargetRef.current === next) return;
    selectedTargetRef.current = next;
    setTarget(next);
  };

  useLayoutEffect(() => {
    authorityRef.current = authority;
    selectedTargetRef.current = target;
  }, [authority, target]);

  useLayoutEffect(
    () => tabCoordinator.establish(tabDraft),
    [tabCoordinator, tabDraft],
  );

  useEffect(
    () => tabCoordinator.establishLifetime(),
    [tabCoordinator],
  );

  useLayoutEffect(() => {
    const tabOwners = tabOwnersRef.current;
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      for (const target of CONNECT_TARGETS) {
        if (tabOwners.get(target.id)?.authority === authority) tabOwners.delete(target.id);
      }
      if (createTokenOwnerRef.current?.authority === authority) createTokenOwnerRef.current = null;
      if (dismissOwnerRef.current?.authority === authority) dismissOwnerRef.current = null;
    };
  }, [authority]);

  return (
    <section className={cn("relative min-w-0 rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/30", className)} data-testid="agent-connect-card" aria-label="Connect an MCP client">
      {onDismiss && (
        <button
          ref={(element) => setControlElement(dismissOwnerRef, authority, element)}
          type="button"
          className="icon-btn absolute right-2 top-2 h-7 w-7"
          onClick={(event) => {
            if (
              !ownsAuthority(authority) ||
              dismissOwnerRef.current?.authority !== authority ||
              dismissOwnerRef.current.element !== event.currentTarget ||
              authority.onDismiss !== onDismiss
            ) return;
            authority.onDismiss();
          }}
          aria-label="Dismiss setup steps"
          data-testid="agent-connect-dismiss"
        >
          <X size={14} />
        </button>
      )}
      <div className={cn("flex flex-wrap items-center justify-between gap-3", onDismiss && "pr-7")}>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Plug size={16} className="shrink-0 text-violet-600" /> Client setup
        </h3>
        <a className="inline-flex min-h-6 shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline" href={AGENT_DOCS_URL} target="_blank" rel="noreferrer" data-testid="agent-docs-link">
          Agent docs <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
      <p className="mt-1 text-xs leading-5 text-ink-3">
        Requests you send from the editor are picked up by your own agent — GitHub Copilot CLI by default — through the Markdoc MCP server. Nothing runs on
        the Markdoc side; your agent does the work and proposes it back as suggestions.
      </p>
      <div
        ref={(element) => tabCoordinator.bindList(tabDraft, element)}
        className={AGENT_TABLIST_CLASS}
        role="tablist"
        aria-label="Agent client"
        onKeyDownCapture={(event) =>
          tabCoordinator.capture(tabDraft.generation, event)}
      >
        {CONNECT_TARGETS.map((item) => (
          <button
            key={item.id}
            ref={(element) => {
              const cleanup = tabCoordinator.bindTab(tabDraft, item.id, element);
              setTabElement(authority, item.id, element);
              return () => {
                cleanup?.();
                setTabElement(authority, item.id, null);
              };
            }}
            id={`${tabsId}-${item.id}`}
            type="button"
            role="tab"
            aria-selected={target === item.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={target === item.id ? 0 : -1}
            className={cn(AGENT_TAB_CLASS, target === item.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
            onClick={(event) => selectTarget(authority, item.id, event.currentTarget)}
            onKeyDown={(event) => tabCoordinator.activate(tabDraft.generation, item.id, event)}
            data-testid={`agent-connect-tab-${item.id}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <ol className="mt-3 flex flex-col gap-3 text-sm text-ink-2">
        {!hideTokenStep && (
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">1</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <span>Create an API token for the agent.</span>
              {onCreateToken ? (
                <button
                  ref={(element) => setControlElement(createTokenOwnerRef, authority, element)}
                  type="button"
                  className="btn btn-outline btn-sm gap-1.5"
                  onClick={(event) => {
                    if (
                      !ownsAuthority(authority) ||
                      authority.hideTokenStep ||
                      createTokenOwnerRef.current?.authority !== authority ||
                      createTokenOwnerRef.current.element !== event.currentTarget ||
                      authority.onCreateToken !== onCreateToken
                    ) return;
                    authority.onCreateToken();
                  }}
                  data-testid="agent-connect-create-token"
                >
                  <KeyRound size={14} /> Create token
                </button>
              ) : (
                <a className="btn btn-outline btn-sm gap-1.5" href="/settings#tokens" data-testid="agent-connect-create-token">
                  <KeyRound size={14} /> Create token
                </a>
              )}
            </div>
          </li>
        )}
        {base ? <li className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{hideTokenStep ? 1 : 2}</span>
          <div className="min-w-0 flex-1">
            {target === "copilot-app" ? (
              <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${target}`} data-testid="agent-connect-copilot-app">
                <p className="mb-1.5">
                  Copy the canvas extension from this checkout into Copilot&apos;s personal extensions directory, then start a new app session. Copilot asks for{" "}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">MARKDOC_URL</code> and{" "}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">MARKDOC_TOKEN</code>; use <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{base}</code> for the URL.
                </p>
                <CopyBlock value={COPILOT_APP_INSTALL} label="Copilot app install command" testId="agent-connect-app-install" />
                <a className="mt-2 inline-flex min-h-6 items-center text-xs font-medium text-accent hover:underline" href={COPILOT_APP_DOCS} target="_blank" rel="noreferrer">
                  Inside the Copilot app setup and limits
                </a>
              </div>
            ) : (
              <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${target}`}>
                <div className="mb-1.5">
                  {target === "copilot-cli" ? (
                    <>
                      Add Markdoc to Copilot CLI: run <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">/mcp add</code> and paste this, or merge it into{" "}
                      <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">~/.copilot/mcp-config.json</code>.
                    </>
                  ) : target === "mcp-clients" ? (
                    <>
                      Add this Streamable HTTP server under <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">servers</code> in{" "}
                      <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">.vscode/mcp.json</code>.
                    </>
                  ) : <>Add this Streamable HTTP server to your client&apos;s MCP configuration.</>}{" "}
                  It connects to this server over HTTP — no checkout needed.
                  {" "}Replace <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">{TOKEN_PLACEHOLDER}</code> in the Authorization header with your saved token.
                </div>
                <CopyBlock value={config} label="MCP configuration" testId="agent-connect-config" />
                <details className="mt-2 text-xs text-ink-3">
                  <summary className="cursor-pointer select-none" data-testid="agent-connect-stdio-toggle">
                    Client without HTTP support? Run the server from a checkout (stdio)
                  </summary>
                  <div className="mt-2">
                    <div className="mb-1.5">
                      Point <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">args</code> at your Markdoc checkout.
                    </div>
                    <CopyBlock value={stdioConfig} label="stdio MCP configuration" testId="agent-connect-config-stdio" />
                  </div>
                </details>
                {target === "copilot-cli" && <details className="mt-2 text-xs text-ink-3">
                  <summary className="cursor-pointer">Optional Copilot CLI permissions</summary>
                  <CopilotPermissionsHint testIdPrefix="agent-connect" className="mt-2" scope={scope} />
                </details>}
              </div>
            )}
          </div>
        </li> : <li className="text-sm text-ink-3">Determining this server&apos;s address...</li>}
        <li className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{hideTokenStep ? 2 : 3}</span>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <TerminalSquare size={14} className="text-ink-3" />
            {target === "copilot-app" ? (
              <span>
                In a new Copilot app session, ask <q className="font-medium text-ink">Open my document in Markdoc</q> or run{" "}
                <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs">/markdoc open &lt;id&gt;</code>. Requests, mentions, comments, and reviews made in the panel are pushed into that session.
              </span>
            ) : (
              <span>
                Ask Copilot: <q className="font-medium text-ink">Check Markdoc for requests</q>. It lists what you asked for, claims it and replies with suggestions you accept or reject here.
              </span>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}
