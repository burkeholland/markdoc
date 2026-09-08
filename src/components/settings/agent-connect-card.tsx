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

const CONNECT_TARGETS: ConnectTargetDefinition[] = [
  { id: "copilot-cli", label: "Copilot CLI" },
  { id: "mcp-clients", label: "VS Code" },
  { id: "other-clients", label: "Other MCP clients" },
  { id: "copilot-app", label: "Copilot app" },
];

interface AgentConnectAuthority {
  mount: symbol;
  origin: string;
  scope: TokenScopeName | null | undefined;
  onCreateToken: (() => void) | undefined;
  onDismiss: (() => void) | undefined;
  hideTokenStep: boolean | undefined;
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
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

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
  readonly placement: CopyBlockPlacement;
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
    expectedPlacement?: CopyBlockPlacement,
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
    const placement = expectedPlacement ?? Object.freeze({
      parent: wrapper.parentNode,
      previousSibling: wrapper.previousSibling,
      nextSibling: wrapper.nextSibling,
    });
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
      const observer = new MutationObserverConstructor(() => {
        publication.mutated = true;
      });
      observer.observe(facts.wrapper, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      if (facts.placement.parent) {
        observer.observe(facts.placement.parent, { childList: true });
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
    return !publication.mutated &&
      (publication.observer?.takeRecords().length ?? 0) === 0;
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
    expectedPlacement?: CopyBlockPlacement,
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
      (expectedPlacement && wrapper.parentNode !== expectedPlacement.parent) ||
      (expectedPlacement && wrapper.previousSibling !== expectedPlacement.previousSibling) ||
      (expectedPlacement && wrapper.nextSibling !== expectedPlacement.nextSibling)
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
      facts.wrapper.parentNode === facts.placement.parent &&
      facts.wrapper.previousSibling === facts.placement.previousSibling &&
      facts.wrapper.nextSibling === facts.placement.nextSibling &&
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
    () => ({ mount, origin, scope, onCreateToken, onDismiss, hideTokenStep }),
    [hideTokenStep, mount, onCreateToken, onDismiss, origin, scope],
  );
  const authorityRef = useRef<AgentConnectAuthority | null>(null);
  const tabOwnersRef = useRef(new Map<ConnectTarget, TabOwner>());
  const createTokenOwnerRef = useRef<ControlOwner | null>(null);
  const dismissOwnerRef = useRef<ControlOwner | null>(null);
  const selectedTargetRef = useRef<ConnectTarget>("copilot-cli");
  const stdioConfig = mcpConfigFor(base, TOKEN_PLACEHOLDER, target === "mcp-clients" ? "servers" : "mcpServers");
  const tabsId = useId();
  const config = target === "mcp-clients" ? mcpVsCodeConfigFor(base) : mcpHttpConfigFor(base);
  const ownsAuthority = (candidate: AgentConnectAuthority) =>
    authorityRef.current === candidate &&
    candidate.mount === mount &&
    candidate.origin === origin &&
    Object.is(candidate.scope, scope) &&
    candidate.onCreateToken === onCreateToken &&
    candidate.onDismiss === onDismiss &&
    Object.is(candidate.hideTokenStep, hideTokenStep);
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
  const moveTarget = (candidate: AgentConnectAuthority, current: ConnectTarget, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!ownsTab(candidate, current, event.currentTarget)) return;
    const index = CONNECT_TARGETS.findIndex(({ id }) => id === current);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % CONNECT_TARGETS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + CONNECT_TARGETS.length) % CONNECT_TARGETS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CONNECT_TARGETS.length - 1;
    else return;
    const nextTarget = CONNECT_TARGETS[next]?.id;
    const destination = nextTarget ? tabOwnersRef.current.get(nextTarget) : undefined;
    if (
      !nextTarget ||
      nextTarget === selectedTargetRef.current ||
      destination?.authority !== candidate ||
      !destination.element.isConnected ||
      !ownsAuthority(candidate)
    ) return;
    event.preventDefault();
    selectedTargetRef.current = nextTarget;
    setTarget(nextTarget);
    destination.element.focus();
  };

  useLayoutEffect(() => {
    const tabOwners = tabOwnersRef.current;
    authorityRef.current = authority;
    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      for (const target of CONNECT_TARGETS) {
        if (tabOwners.get(target.id)?.authority === authority) tabOwners.delete(target.id);
      }
      if (createTokenOwnerRef.current?.authority === authority) createTokenOwnerRef.current = null;
      if (dismissOwnerRef.current?.authority === authority) dismissOwnerRef.current = null;
    };
  }, [authority]);

  useLayoutEffect(() => {
    if (authorityRef.current === authority) selectedTargetRef.current = target;
  }, [authority, target]);

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
      <div className="mt-3 flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1" role="tablist" aria-label="Agent client">
        {CONNECT_TARGETS.map((item) => (
          <button
            key={item.id}
            ref={(element) => setTabElement(authority, item.id, element)}
            id={`${tabsId}-${item.id}`}
            type="button"
            role="tab"
            aria-selected={target === item.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={target === item.id ? 0 : -1}
            className={cn("rounded-md px-2.5 py-1.5 text-xs font-medium", target === item.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
            onClick={(event) => selectTarget(authority, item.id, event.currentTarget)}
            onKeyDown={(event) => moveTarget(authority, item.id, event)}
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
