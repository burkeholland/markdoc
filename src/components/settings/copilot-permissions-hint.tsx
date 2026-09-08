"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { COPY_FALLBACK_HINT } from "@/lib/clipboard";
import { useCopy, type CopyStatus } from "@/lib/hooks";
import { COPILOT_ALLOWING_TOOLS_URL, copilotAllowToolLine, TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { cn } from "@/lib/utils";

const ROOT_CLASS = "rounded-lg border border-line bg-surface p-2.5 text-xs leading-5 text-ink-3";
const LINE_CLASS = "w-full min-w-0 select-text whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] leading-4 text-ink-2";
const COPY_CLASS = "btn btn-outline btn-sm h-auto max-w-full gap-1.5 whitespace-normal text-left";
const COPY_LABEL = "Copy the Copilot CLI allow-tool line";

interface PermissionHintRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly testIdPrefix: string;
  readonly className: string | undefined;
  readonly scope: TokenScopeName | null | undefined;
  readonly line: string;
  readonly copySetup: Readonly<{
    copy: () => void;
    status: CopyStatus;
    label: string;
    copied: boolean;
  }>;
  readonly copy: () => void;
  readonly status: CopyStatus;
  readonly label: string;
  readonly copied: boolean;
  readonly rootClassName: string;
  readonly rootTestId: string;
  readonly lineTestId: string;
  readonly copyTestId: string;
}

interface PermissionHintElements {
  root: HTMLDivElement | null;
  pre: HTMLPreElement | null;
  button: HTMLButtonElement | null;
}

type PermissionHintElementRole = keyof PermissionHintElements;

interface PermissionHintGeneration {
  readonly identity: symbol;
  readonly render: PermissionHintRender;
  readonly elements: PermissionHintElements;
  readonly bindings: Record<PermissionHintElementRole, PermissionHintBinding | null>;
  authority: PermissionHintDraft | null;
  target: RefObject<HTMLPreElement | null> | null;
}

interface PermissionHintDraft {
  readonly identity: symbol;
  readonly render: PermissionHintRender;
  readonly generation: PermissionHintGeneration;
  committed: boolean;
  retired: boolean;
}

interface PermissionHintBinding {
  readonly identity: symbol;
  readonly generation: PermissionHintGeneration;
  readonly role: PermissionHintElementRole;
  readonly element: HTMLElement;
  active: boolean;
}

interface PermissionHintDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PermissionHintDomSnapshot[];
}

interface PermissionHintPublication {
  readonly identity: symbol;
  readonly render: PermissionHintRender;
  readonly draft: PermissionHintDraft;
  readonly generation: PermissionHintGeneration;
  readonly root: HTMLDivElement;
  readonly pre: HTMLPreElement;
  readonly button: HTMLButtonElement;
  readonly bindings: Readonly<Record<PermissionHintElementRole, PermissionHintBinding>>;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly rootParent: Node | null;
  readonly dom: PermissionHintDomSnapshot;
  readonly buttonTargets: readonly Node[];
  retired: boolean;
  claimed: boolean;
  mutated: boolean;
  observer: MutationObserver | null;
}

interface PermissionHintPreOwner {
  readonly binding: PermissionHintBinding;
  readonly target: RefObject<HTMLPreElement | null>;
}

interface PermissionHintReplay {
  readonly publication: PermissionHintPublication;
  readonly generation: PermissionHintGeneration;
  readonly expected: Readonly<Record<PermissionHintElementRole, PermissionHintBinding>>;
  readonly released: Set<PermissionHintElementRole>;
  readonly rebound: Map<PermissionHintElementRole, PermissionHintBinding>;
  layoutRetired: boolean;
  invalid: boolean;
}

const PERMISSION_HINT_ROLES = ["root", "pre", "button"] as const;
const PermissionHintMutationObserver =
  typeof MutationObserver === "function" ? MutationObserver : null;

function permissionHintAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotPermissionHintDom(node: Node): PermissionHintDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: permissionHintAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotPermissionHintDom)),
  });
}

function permissionHintDomMatches(snapshot: PermissionHintDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = permissionHintAttributes(node);
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
      node.childNodes.item(index) === child.node && permissionHintDomMatches(child));
}

function permissionHintNodes(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return Object.freeze(nodes);
}

function setPermissionHintElement(
  generation: PermissionHintGeneration,
  role: PermissionHintElementRole,
  element: HTMLElement | null,
) {
  if (role === "root") generation.elements.root = element as HTMLDivElement | null;
  else if (role === "pre") generation.elements.pre = element as HTMLPreElement | null;
  else generation.elements.button = element as HTMLButtonElement | null;
}

class PermissionHintCoordinator {
  readonly #mount: symbol;
  #current: PermissionHintPublication | null = null;
  #replay: PermissionHintReplay | null = null;
  #elementOwners = new WeakMap<HTMLElement, PermissionHintBinding>();
  #preOwner: PermissionHintPreOwner | null = null;
  #publishedGenerations = new WeakSet<PermissionHintGeneration>();
  #replayedGenerations = new WeakSet<PermissionHintGeneration>();
  #claimedEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: PermissionHintRender): PermissionHintDraft {
    const generation: PermissionHintGeneration = {
      identity: Symbol("copilot-permissions-generation"),
      render,
      elements: { root: null, pre: null, button: null },
      bindings: { root: null, pre: null, button: null },
      authority: null,
      target: null,
    };
    const draft: PermissionHintDraft = {
      identity: Symbol("copilot-permissions-draft"),
      render,
      generation,
      committed: false,
      retired: false,
    };
    generation.authority = draft;
    return draft;
  }

  bindRoot(draft: PermissionHintDraft, element: HTMLDivElement | null) {
    return this.#bind(draft.generation, "root", element);
  }

  bindPre(
    draft: PermissionHintDraft,
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

  bindButton(draft: PermissionHintDraft, element: HTMLButtonElement | null) {
    return this.#bind(draft.generation, "button", element);
  }

  establish(initialDraft: PermissionHintDraft, target: RefObject<HTMLPreElement | null>) {
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
    if (this.#current && this.#current.generation !== generation) {
      this.#retirePublication(this.#current, false);
    }
    const publication = this.#createPublication(initialDraft, target);
    if (!publication || !this.#publish(publication)) {
      this.#retireDraft(initialDraft);
      return;
    }
    return () => this.retire(publication);
  }

  retire(publication: PermissionHintPublication) {
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

  activate(generation: PermissionHintGeneration, event: ReactMouseEvent<HTMLButtonElement>) {
    const publication = this.#current;
    const button = publication?.button;
    const ownerDocument = button?.ownerDocument;
    const view = ownerDocument?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !publication ||
      publication.generation !== generation ||
      publication.draft !== generation.authority ||
      publication.retired ||
      publication.draft.retired ||
      publication.claimed ||
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
      !publication.buttonTargets.includes(target) ||
      this.#claimedEvents.has(nativeEvent) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return;
    }

    publication.claimed = true;
    this.#claimedEvents.add(nativeEvent);
    publication.render.copy();
  }

  #bind(
    generation: PermissionHintGeneration,
    role: PermissionHintElementRole,
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
        this.#current?.generation === displaced.generation &&
        generation.authority?.retired
      ) {
        return;
      }
      this.#release(displaced, "replace");
      if (!this.#canBind(generation)) return;
    }

    const binding: PermissionHintBinding = {
      identity: Symbol(`copilot-permissions-${role}-binding`),
      generation,
      role,
      element,
      active: true,
    };
    generation.bindings[role] = binding;
    setPermissionHintElement(generation, role, element);
    this.#elementOwners.set(element, binding);
    if (role === "pre" && target) {
      this.#preOwner = { binding, target };
      target.current = element as HTMLPreElement;
    }
    if (replay?.generation === generation) replay.rebound.set(role, binding);
    return () => this.#release(binding, "cleanup");
  }

  #release(
    binding: PermissionHintBinding,
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
      setPermissionHintElement(generation, role, null);
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

    if (publication?.generation === generation) {
      this.#retirePublication(publication, Boolean(startsReplay && !startsReplay.invalid));
    } else if (!replay && generation.authority && !generation.authority.retired) {
      this.#retireDraft(generation.authority);
    }
    if (replay?.invalid) this.#invalidateReplay(replay);
  }

  #canBind(generation: PermissionHintGeneration): boolean {
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

  #beginReplay(publication: PermissionHintPublication): PermissionHintReplay | null {
    if (this.#replay?.publication === publication) return this.#replay;
    if (
      this.#replay ||
      publication.retired ||
      publication.claimed ||
      this.#current !== publication ||
      this.#replayedGenerations.has(publication.generation) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return null;
    }
    const replay: PermissionHintReplay = {
      publication,
      generation: publication.generation,
      expected: publication.bindings,
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
    initialDraft: PermissionHintDraft,
    target: RefObject<HTMLPreElement | null>,
  ): PermissionHintPublication | null {
    const replay = this.#replay;
    const { generation } = initialDraft;
    if (
      !replay ||
      replay.publication.draft !== initialDraft ||
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
      replay.released.size !== PERMISSION_HINT_ROLES.length ||
      replay.rebound.size !== PERMISSION_HINT_ROLES.length ||
      PERMISSION_HINT_ROLES.some((role) => {
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
        replay.publication.dom,
        replay.publication.rootParent,
      )
    ) {
      if (replay) this.#invalidateReplay(replay);
      return null;
    }

    const successor: PermissionHintDraft = {
      identity: Symbol("copilot-permissions-successor-draft"),
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
      replay.publication.dom,
      replay.publication.rootParent,
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
    draft: PermissionHintDraft,
    target: RefObject<HTMLPreElement | null>,
    expectedDom?: PermissionHintDomSnapshot,
    expectedRootParent?: Node | null,
  ): PermissionHintPublication | null {
    const { generation, render } = draft;
    const { root, pre, button } = generation.elements;
    const rootBinding = generation.bindings.root;
    const preBinding = generation.bindings.pre;
    const buttonBinding = generation.bindings.button;
    if (
      !root ||
      !pre ||
      !button ||
      !rootBinding ||
      !preBinding ||
      !buttonBinding ||
      !this.#hierarchyIsCurrent(
        generation,
        render,
        target,
        expectedDom,
        expectedRootParent,
      )
    ) {
      return null;
    }
    const dom = expectedDom ?? snapshotPermissionHintDom(root);
    const rootParent = expectedDom ? expectedRootParent ?? null : root.parentNode;
    return {
      identity: Symbol("copilot-permissions-publication"),
      render,
      draft,
      generation,
      root,
      pre,
      button,
      bindings: Object.freeze({
        root: rootBinding,
        pre: preBinding,
        button: buttonBinding,
      }),
      target,
      rootParent,
      dom,
      buttonTargets: permissionHintNodes(button),
      retired: false,
      claimed: false,
      mutated: false,
      observer: null,
    };
  }

  #publish(publication: PermissionHintPublication): boolean {
    if (
      this.#current ||
      publication.retired ||
      publication.draft.retired ||
      publication.generation.authority !== publication.draft
    ) {
      return false;
    }
    publication.draft.committed = true;
    this.#current = publication;
    if (PermissionHintMutationObserver) {
      const observer = new PermissionHintMutationObserver(() => {
        publication.mutated = true;
      });
      observer.observe(publication.root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      if (publication.rootParent) {
        observer.observe(publication.rootParent, { childList: true });
      }
      publication.observer = observer;
    }
    return true;
  }

  #retirePublication(publication: PermissionHintPublication, preserveObserver: boolean) {
    if (!publication.retired) {
      publication.retired = true;
      publication.draft.retired = true;
    }
    if (this.#current === publication) this.#current = null;
    if (!preserveObserver) this.#disconnect(publication);
  }

  #retireDraft(draft: PermissionHintDraft) {
    draft.retired = true;
    if (this.#current?.draft === draft) this.#retirePublication(this.#current, false);
  }

  #retireAuthority(generation: PermissionHintGeneration) {
    const authority = generation.authority;
    if (authority) this.#retireDraft(authority);
    if (this.#replay?.generation === generation) this.#invalidateReplay(this.#replay);
  }

  #invalidateReplay(replay: PermissionHintReplay) {
    if (this.#replay === replay) this.#replay = null;
    replay.invalid = true;
    this.#disconnect(replay.publication);
  }

  #disconnect(publication: PermissionHintPublication) {
    publication.observer?.disconnect();
    publication.observer = null;
  }

  #mutationFree(publication: PermissionHintPublication): boolean {
    return !publication.mutated &&
      (publication.observer?.takeRecords().length ?? 0) === 0;
  }

  #ownsBinding(binding: PermissionHintBinding): boolean {
    return binding.active &&
      binding.generation.bindings[binding.role] === binding &&
      this.#elementOwners.get(binding.element) === binding;
  }

  #renderIsCurrent(render: PermissionHintRender): boolean {
    const setup = render.copySetup;
    return (
      render.mount === this.#mount &&
      render.line === copilotAllowToolLine(undefined, render.scope ?? "full") &&
      setup.copy === render.copy &&
      setup.status === render.status &&
      setup.label === render.label &&
      setup.copied === render.copied &&
      render.copied === (render.status === "copied") &&
      render.label === (
        render.status === "copied"
          ? "Copied"
          : render.status === "fallback"
            ? COPY_FALLBACK_HINT
            : "Copy"
      ) &&
      render.rootClassName === cn(ROOT_CLASS, render.className) &&
      render.rootTestId === `${render.testIdPrefix}-permissions` &&
      render.lineTestId === `${render.testIdPrefix}-allow-line` &&
      render.copyTestId === `${render.testIdPrefix}-allow-copy`
    );
  }

  #hierarchyIsCurrent(
    generation: PermissionHintGeneration,
    render: PermissionHintRender,
    target: RefObject<HTMLPreElement | null>,
    expectedDom?: PermissionHintDomSnapshot,
    expectedRootParent?: Node | null,
  ): boolean {
    const { root, pre, button } = generation.elements;
    const rootBinding = generation.bindings.root;
    const preBinding = generation.bindings.pre;
    const buttonBinding = generation.bindings.button;
    if (
      !root ||
      !pre ||
      !button ||
      !rootBinding ||
      !preBinding ||
      !buttonBinding ||
      new Set([root, pre, button]).size !== 3 ||
      rootBinding.element !== root ||
      preBinding.element !== pre ||
      buttonBinding.element !== button ||
      !this.#ownsBinding(rootBinding) ||
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

    const ownerDocument = root.ownerDocument;
    const controls = pre.parentElement;
    const icon = button.firstElementChild;
    const expectedRootChildren = render.scope ? 5 : 4;
    if (
      !root.isConnected ||
      !pre.isConnected ||
      !button.isConnected ||
      pre.ownerDocument !== ownerDocument ||
      button.ownerDocument !== ownerDocument ||
      root.className !== render.rootClassName ||
      root.dataset.testid !== render.rootTestId ||
      root.children.length !== expectedRootChildren ||
      root.children.item(2) !== controls ||
      pre.className !== LINE_CLASS ||
      pre.dataset.testid !== render.lineTestId ||
      pre.children.length !== 0 ||
      pre.textContent !== render.line ||
      button.className !== COPY_CLASS ||
      button.dataset.testid !== render.copyTestId ||
      button.getAttribute("type") !== "button" ||
      button.type !== "button" ||
      button.disabled ||
      button.matches(":disabled") ||
      button.getAttribute("aria-label") !== COPY_LABEL ||
      button.textContent !== render.label ||
      button.children.length !== 1 ||
      !icon ||
      icon.tagName.toLowerCase() !== "svg" ||
      !icon.classList.contains(render.copied ? "lucide-check" : "lucide-copy") ||
      icon.getAttribute("width") !== "14" ||
      icon.getAttribute("height") !== "14" ||
      icon.getAttribute("aria-hidden") !== "true" ||
      controls === null ||
      controls.parentElement !== root ||
      controls.className !== "mt-1.5 flex min-w-0 flex-col items-start gap-2" ||
      controls.children.length !== 2 ||
      controls.firstElementChild !== pre ||
      controls.lastElementChild !== button ||
      pre.nextElementSibling !== button ||
      button.parentElement !== controls ||
      (expectedDom && !permissionHintDomMatches(expectedDom)) ||
      (expectedDom && root !== expectedDom.node) ||
      (expectedDom && root.parentNode !== expectedRootParent)
    ) {
      return false;
    }
    return true;
  }

  #publicationIsCurrent(publication: PermissionHintPublication): boolean {
    return (
      this.#current === publication &&
      !publication.retired &&
      !publication.draft.retired &&
      publication.generation.authority === publication.draft &&
      publication.bindings.root === publication.generation.bindings.root &&
      publication.bindings.pre === publication.generation.bindings.pre &&
      publication.bindings.button === publication.generation.bindings.button &&
      publication.root.parentNode === publication.rootParent &&
      this.#mutationFree(publication) &&
      this.#hierarchyIsCurrent(
        publication.generation,
        publication.render,
        publication.target,
        publication.dom,
        publication.rootParent,
      )
    );
  }
}

/**
 * "Stop the permission prompts": under the MCP config in the Share card and the Connect card, the
 * `copilot --allow-tool …` line that pre-allows Markdoc's safe tools for a session, plus the two
 * alternatives (the CLI's own "don't ask again" answer, and /allow-all). The pattern uses the same
 * server key as the config block above it, so it matches what the user pasted. When the token's
 * `scope` is known the line only lists tools that scope can run, and the scope is printed next to it.
 */
export function CopilotPermissionsHint({ testIdPrefix, className, scope }: { testIdPrefix: string; className?: string; scope?: TokenScopeName | null }) {
  const line = copilotAllowToolLine(undefined, scope ?? "full");
  const target = useRef<HTMLPreElement>(null);
  const copyResult = useCopy(line, target);
  const copySetup = Object.freeze({
    copy: copyResult.copy,
    status: copyResult.status,
    label: copyResult.label,
    copied: copyResult.copied,
  });
  const { copy, status, label, copied } = copySetup;
  const [mount] = useState(() => Symbol("copilot-permissions-hint"));
  const [coordinator] = useState(() => new PermissionHintCoordinator(mount));
  const render: PermissionHintRender = Object.freeze({
    identity: Symbol("copilot-permissions-render"),
    mount,
    testIdPrefix,
    className,
    scope,
    line,
    copySetup,
    copy,
    status,
    label,
    copied,
    rootClassName: cn(ROOT_CLASS, className),
    rootTestId: `${testIdPrefix}-permissions`,
    lineTestId: `${testIdPrefix}-allow-line`,
    copyTestId: `${testIdPrefix}-allow-copy`,
  });
  const draft = coordinator.createDraft(render);

  useLayoutEffect(() => coordinator.establish(draft, target), [coordinator, draft, target]);

  return (
    <div ref={(element) => coordinator.bindRoot(draft, element)} className={render.rootClassName} data-testid={render.rootTestId}>
      <div className="flex items-center gap-1.5 font-semibold text-ink-2">
        <ShieldCheck size={13} className="text-violet-600" /> Stop the permission prompts
      </div>
      <p className="mt-0.5">Copilot CLI asks before each change. To pre-allow Markdoc&rsquo;s safe tools for a session:</p>
      <div className="mt-1.5 flex min-w-0 flex-col items-start gap-2">
        <pre
          ref={(element) => coordinator.bindPre(draft, target, element)}
          className={LINE_CLASS}
          data-testid={render.lineTestId}
        >
          {render.line}
        </pre>
        <button
          type="button"
          className={COPY_CLASS}
          onClick={(event) => coordinator.activate(draft.generation, event)}
          ref={(element) => coordinator.bindButton(draft, element)}
          aria-label={COPY_LABEL}
          data-testid={render.copyTestId}
        >
          {render.copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {render.label}
        </button>
      </div>
      {render.scope && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid={`${render.testIdPrefix}-scope`}>
          <span className="font-semibold text-ink-2">Token scope:</span>
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2" data-testid={`${render.testIdPrefix}-scope-chip`}>
            {render.scope}
          </span>
          <span>
            {TOKEN_SCOPE_LABEL[render.scope]} — {TOKEN_SCOPE_SUMMARY[render.scope]}.
          </span>
        </p>
      )}
      <p className="mt-1.5">
        or answer <em>don&rsquo;t ask again in this directory</em> once per tool; <code className="rounded bg-surface-2 px-1 py-0.5 font-mono">/allow-all</code> allows everything (not
        recommended). Reading and watching never prompt.{" "}
        {/* Always underlined: inside grey body text the accent colour alone fails axe `link-in-text-block`. */}
        <a className="text-accent underline underline-offset-2" href={COPILOT_ALLOWING_TOOLS_URL} target="_blank" rel="noreferrer">
          How Copilot CLI permissions work
        </a>
      </p>
    </div>
  );
}
