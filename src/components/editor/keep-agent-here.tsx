"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Radio } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { api, apiErrorText } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { AgentConnectCard, useOrigin } from "@/components/settings/agent-connect-card";

/**
 * The sentence a person pastes into Copilot CLI (or any MCP client connected to Markdoc) to put their
 * agent into the watch loop for one document: `markdoc_presence` → `markdoc_watch { wait: 55 }` → act on
 * comments, mentions and requests (docs/agents.md "Sit in a document").
 */
export function keepAgentPrompt(doc: { id: string; title: string }): string {
  const title = (doc.title || "Untitled").replace(/"/g, "'");
  return `Sit in the Markdoc document "${title}" (id ${doc.id}): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.`;
}

/** Lead-in above the paste box: what to do with the sentence (Burke's "give them the exact command"). */
export const KEEP_AGENT_HINT = "Paste this into Copilot CLI (or any MCP client connected to Markdoc):";

export const KEEP_AGENT_AFTER = "While it runs, your requests and @mentions reach the agent within a minute.";

function readDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(AGENT_CONNECT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface TokenSetupCheck {
  hasTokens: boolean | null;
  pending: boolean;
  error: string | null;
  retry: () => void;
}

interface TokenCheckVisit {
  waitingFor: TokenListRequest | null;
}

interface TokenListRequest {
  visit: TokenCheckVisit | null;
  requiresFreshVisit: boolean;
}

/** The user's last confirmed token state, plus the exact active panel visit's request state. */
function useHasTokens(active: boolean): TokenSetupCheck {
  const [hasTokens, setHasTokens] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visitRef = useRef<TokenCheckVisit | null>(null);
  const requestRef = useRef<TokenListRequest | null>(null);

  const check = useCallback((visit: TokenCheckVisit) => {
    function run(currentVisit: TokenCheckVisit): void {
      if (visitRef.current !== currentVisit) return;
      const running = requestRef.current;
      if (running) {
        if (running.visit !== currentVisit) {
          if (running.requiresFreshVisit) currentVisit.waitingFor = running;
          else running.visit = currentVisit;
        }
        setPending(true);
        return;
      }

      currentVisit.waitingFor = null;
      const request: TokenListRequest = { visit: currentVisit, requiresFreshVisit: false };
      requestRef.current = request;
      setPending(true);

      void (async () => {
        try {
          const res = await api.tokens.list();
          if (requestRef.current !== request || !request.visit || request.visit !== visitRef.current) return;
          setHasTokens(res.tokens.length > 0);
          setError(null);
        } catch (reason) {
          if (requestRef.current !== request || !request.visit || request.visit !== visitRef.current) return;
          setError(apiErrorText(reason, "Could not check token setup"));
        } finally {
          if (requestRef.current !== request) return;
          requestRef.current = null;
          const requestVisit = request.visit;
          request.visit = null;
          if (requestVisit && visitRef.current === requestVisit) {
            setPending(false);
            return;
          }

          const waitingVisit = visitRef.current;
          if (!waitingVisit || waitingVisit.waitingFor !== request) return;
          waitingVisit.waitingFor = null;
          run(waitingVisit);
        }
      })();
    }

    run(visit);
  }, []);

  const retire = useCallback((visit: TokenCheckVisit) => {
    visit.waitingFor = null;
    if (requestRef.current?.visit === visit) requestRef.current.visit = null;
    if (visitRef.current === visit) visitRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!active) {
      if (requestRef.current) requestRef.current.requiresFreshVisit = true;
      setPending(false);
      setError(null);
      return;
    }

    const visit: TokenCheckVisit = { waitingFor: null };
    visitRef.current = visit;
    setError(null);
    check(visit);
    return () => retire(visit);
  }, [active, check, retire]);

  const retry = useCallback(() => {
    const visit = visitRef.current;
    if (visit) check(visit);
  }, [check]);
  return { hasTokens, pending, error, retry };
}

export interface KeepAgentHerePanelProps {
  doc: { id: string; title: string };
  /** Where to go to create a token; defaults to /settings#tokens and back. */
  onCreateToken?: () => void;
  /** Renders a back arrow in the heading (a host that switches views). */
  onBack?: () => void;
  /** The panel is showing; the token check runs when it becomes true. */
  active?: boolean;
  /** Drop the panel's own heading (the dialog already has the title). */
  hideHeading?: boolean;
}

const PANEL_CLASS = "flex flex-col gap-3";
const HEADING_ROW_CLASS = "flex items-center gap-1.5";
const HEADING_CLASS = "flex items-center gap-2 text-sm font-semibold text-ink";
const BACK_CLASS = "icon-btn -ml-1 h-7 w-7";
const CHECKING_CLASS = "text-xs text-ink-3";
const ERROR_CLASS = "flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40";
const RETRY_CLASS = "btn btn-outline btn-sm shrink-0";
const NAV_CLASS = "flex flex-wrap gap-2";
const LINK_CLASS = "btn btn-outline btn-sm";
const CONNECT_LINK_CLASS = "btn btn-outline btn-sm whitespace-normal";
const BODY_CLASS = "text-xs leading-5 text-ink-3";
const HINT_CLASS = "text-sm font-medium leading-5 text-ink-2";
const PROMPT_WRAPPER_CLASS = "relative";
const PROMPT_CLASS = "select-text whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 pb-10 font-sans text-[13px] leading-5 text-ink";
const COPY_CLASS = "btn btn-primary btn-sm absolute bottom-2 right-2 gap-1.5";
const DOCS_LINK_CLASS = "inline-flex min-h-6 w-fit items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline";
const PANEL_BODY = "Your agent sits in this document and reacts to what people write — requests, @mentions and comments reach it without a trip to the terminal.";
const CLIENTS = "Works with any MCP client: Copilot CLI, VS Code, Claude, Cursor.";
const COPY_LABEL = "Copy instruction";

type CopySetup = ReturnType<typeof useCopy>;
type PanelActionKind = "back" | "retry" | "copy";

interface KeepAgentPanelRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly doc: KeepAgentHerePanelProps["doc"];
  readonly docId: string;
  readonly docTitle: string;
  readonly prompt: string;
  readonly onCreateToken: (() => void) | undefined;
  readonly onBack: (() => void) | undefined;
  readonly active: boolean;
  readonly hideHeading: boolean;
  readonly tokenSetup: TokenSetupCheck;
  readonly hasTokens: boolean | null;
  readonly tokenCheckPending: boolean;
  readonly tokenCheckError: string | null;
  readonly retryTokenCheck: () => void;
  readonly copySetup: CopySetup;
  readonly copy: () => void;
  readonly copyStatus: CopySetup["status"];
  readonly copyLabel: string;
  readonly copied: boolean;
  readonly origin: string;
  readonly dismissed: boolean;
  readonly dismiss: () => void;
  readonly showSetup: boolean;
  readonly tokensHref: string;
  readonly connectHref: string;
  readonly docsHref: string;
}

interface KeepAgentPanelElements {
  panel: HTMLDivElement | null;
  headingRow: HTMLDivElement | null;
  heading: HTMLHeadingElement | null;
  back: HTMLButtonElement | null;
  checking: HTMLParagraphElement | null;
  error: HTMLDivElement | null;
  retry: HTMLButtonElement | null;
  nav: HTMLElement | null;
  tokensLink: HTMLAnchorElement | null;
  connectLink: HTMLAnchorElement | null;
  body: HTMLParagraphElement | null;
  hint: HTMLParagraphElement | null;
  promptWrapper: HTMLDivElement | null;
  prompt: HTMLPreElement | null;
  copy: HTMLButtonElement | null;
  after: HTMLParagraphElement | null;
  clients: HTMLParagraphElement | null;
  docsLink: HTMLAnchorElement | null;
}

type PanelElementRole = keyof KeepAgentPanelElements;

const PANEL_ELEMENT_ROLES: readonly PanelElementRole[] = [
  "panel",
  "headingRow",
  "heading",
  "back",
  "checking",
  "error",
  "retry",
  "nav",
  "tokensLink",
  "connectLink",
  "body",
  "hint",
  "promptWrapper",
  "prompt",
  "copy",
  "after",
  "clients",
  "docsLink",
];

function emptyPanelElements(): KeepAgentPanelElements {
  return {
    panel: null,
    headingRow: null,
    heading: null,
    back: null,
    checking: null,
    error: null,
    retry: null,
    nav: null,
    tokensLink: null,
    connectLink: null,
    body: null,
    hint: null,
    promptWrapper: null,
    prompt: null,
    copy: null,
    after: null,
    clients: null,
    docsLink: null,
  };
}

interface KeepAgentPanelDraft {
  readonly render: KeepAgentPanelRender;
  readonly elements: KeepAgentPanelElements;
  readonly lastElements: KeepAgentPanelElements;
  committed: boolean;
  retired: boolean;
}

interface KeepAgentPanelAction {
  readonly kind: PanelActionKind;
  readonly element: HTMLButtonElement;
  readonly targets: readonly Node[];
}

interface KeepAgentPanelPublication {
  readonly render: KeepAgentPanelRender;
  readonly draft: KeepAgentPanelDraft;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly elements: Readonly<KeepAgentPanelElements>;
  readonly setup: Element | null;
  readonly topLevelChildren: readonly Element[];
  readonly back: KeepAgentPanelAction | null;
  readonly retry: KeepAgentPanelAction | null;
  readonly copy: KeepAgentPanelAction;
}

interface PanelElementOwner {
  readonly draft: KeepAgentPanelDraft;
  readonly role: PanelElementRole;
  readonly element: HTMLElement;
}

interface PromptOwner {
  readonly draft: KeepAgentPanelDraft;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly element: HTMLPreElement;
}

function descendantsOf(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function sameNodes(expected: readonly Node[], element: HTMLElement): boolean {
  const current = descendantsOf(element);
  return current.length === expected.length && current.every((node, index) => node === expected[index]);
}

function isNodeFromDocument(value: EventTarget | null, document: Document): value is Node {
  const NodeConstructor = document.defaultView?.Node;
  return Boolean(NodeConstructor && value instanceof NodeConstructor);
}

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

class KeepAgentPanelCoordinator {
  readonly #mount: symbol;
  #current: KeepAgentPanelPublication | null = null;
  #elementOwners = new WeakMap<HTMLElement, PanelElementOwner>();
  #promptOwner: PromptOwner | null = null;
  #claimedActions = new WeakSet<KeepAgentPanelAction>();
  #claimedEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: KeepAgentPanelRender): KeepAgentPanelDraft {
    return {
      render,
      elements: emptyPanelElements(),
      lastElements: emptyPanelElements(),
      committed: false,
      retired: false,
    };
  }

  deactivate(draft: KeepAgentPanelDraft) {
    if (this.#current?.draft === draft) this.#current = null;
  }

  retire(draft: KeepAgentPanelDraft) {
    draft.retired = true;
    this.deactivate(draft);
    for (const role of PANEL_ELEMENT_ROLES) {
      const element = draft.elements[role];
      if (!element) continue;
      const owner = this.#elementOwners.get(element);
      if (owner?.draft === draft && owner.role === role && owner.element === element) {
        this.#elementOwners.delete(element);
      }
    }
    const promptOwner = this.#promptOwner;
    if (promptOwner?.draft === draft) {
      this.#promptOwner = null;
      if (promptOwner.target.current === promptOwner.element) promptOwner.target.current = null;
    }
  }

  bindElement<Role extends PanelElementRole>(
    draft: KeepAgentPanelDraft,
    role: Role,
    element: KeepAgentPanelElements[Role],
  ) {
    const previous = draft.elements[role];
    if (element === null) {
      if (previous) {
        const owner = this.#elementOwners.get(previous);
        if (owner?.draft === draft && owner.role === role && owner.element === previous) {
          this.#elementOwners.delete(previous);
        }
      }
      draft.elements[role] = null;
      if (previous) this.retire(draft);
      return;
    }

    if (draft.retired) {
      const current = this.#current;
      const last = draft.lastElements[role];
      const owner = this.#elementOwners.get(element);
      if (
        !draft.committed ||
        last !== element ||
        (current && current.draft !== draft) ||
        (owner && owner.draft !== draft)
      ) {
        return;
      }
    }
    if (previous && previous !== element) {
      this.retire(draft);
      return;
    }

    const displaced = this.#elementOwners.get(element);
    if (displaced && (displaced.draft !== draft || displaced.role !== role)) {
      this.retire(displaced.draft);
    }
    draft.elements[role] = element;
    draft.lastElements[role] = element;
    this.#elementOwners.set(element, { draft, role, element });
  }

  bindPrompt(
    draft: KeepAgentPanelDraft,
    target: RefObject<HTMLPreElement | null>,
    element: HTMLPreElement | null,
  ) {
    const previous = draft.elements.prompt;
    if (element === null) {
      if (previous) {
        const owner = this.#elementOwners.get(previous);
        if (owner?.draft === draft && owner.role === "prompt" && owner.element === previous) {
          this.#elementOwners.delete(previous);
        }
      }
      draft.elements.prompt = null;
      const promptOwner = this.#promptOwner;
      if (previous && promptOwner?.draft === draft && promptOwner.element === previous) {
        this.#promptOwner = null;
        if (target.current === previous) target.current = null;
      }
      if (previous) this.retire(draft);
      return;
    }

    if (draft.retired) {
      const current = this.#current;
      const owner = this.#elementOwners.get(element);
      if (
        !draft.committed ||
        draft.lastElements.prompt !== element ||
        (current && current.draft !== draft) ||
        (owner && owner.draft !== draft)
      ) {
        return;
      }
    }
    if (previous && previous !== element) {
      this.retire(draft);
      return;
    }

    const displaced = this.#elementOwners.get(element);
    if (displaced && (displaced.draft !== draft || displaced.role !== "prompt")) {
      this.retire(displaced.draft);
    }
    draft.elements.prompt = element;
    draft.lastElements.prompt = element;
    this.#elementOwners.set(element, { draft, role: "prompt", element });
    this.#promptOwner = { draft, target, element };
    target.current = element;
  }

  #ownsElement(publication: KeepAgentPanelPublication, role: PanelElementRole, element: HTMLElement) {
    const owner = this.#elementOwners.get(element);
    return owner?.draft === publication.draft && owner.role === role && owner.element === element;
  }

  #renderIsCurrent(render: KeepAgentPanelRender): boolean {
    const docId = render.doc.id;
    const docTitle = render.doc.title;
    const tokenSetup = render.tokenSetup;
    const hasTokens = tokenSetup.hasTokens;
    const tokenCheckPending = tokenSetup.pending;
    const tokenCheckError = tokenSetup.error;
    const retryTokenCheck = tokenSetup.retry;
    const copySetup = render.copySetup;
    const copy = copySetup.copy;
    const copyStatus = copySetup.status;
    const copyLabel = copySetup.label;
    const copied = copySetup.copied;
    const prompt = keepAgentPrompt({ id: docId, title: docTitle });
    const tokensHref = `/settings?next=${encodeURIComponent(`/d/${docId}`)}#tokens`;
    const connectHref = `/settings?next=${encodeURIComponent(`/d/${docId}`)}#connect`;
    return (
      render.mount === this.#mount &&
      docId === render.docId &&
      docTitle === render.docTitle &&
      prompt === render.prompt &&
      hasTokens === render.hasTokens &&
      tokenCheckPending === render.tokenCheckPending &&
      tokenCheckError === render.tokenCheckError &&
      retryTokenCheck === render.retryTokenCheck &&
      copy === render.copy &&
      copyStatus === render.copyStatus &&
      copyLabel === render.copyLabel &&
      copied === render.copied &&
      render.showSetup === (hasTokens === false && !render.dismissed) &&
      render.tokensHref === tokensHref &&
      render.connectHref === connectHref &&
      render.docsHref === `${AGENT_DOCS_URL}#sit-in-a-document`
    );
  }

  #hierarchyIsCurrent(publication: KeepAgentPanelPublication): boolean {
    const { render, elements, setup, topLevelChildren } = publication;
    const {
      panel,
      headingRow,
      heading,
      back,
      checking,
      error,
      retry,
      nav,
      tokensLink,
      connectLink,
      body,
      hint,
      promptWrapper,
      prompt,
      copy,
      after,
      clients,
      docsLink,
    } = elements;
    if (
      !panel ||
      !nav ||
      !tokensLink ||
      !connectLink ||
      !body ||
      !hint ||
      !promptWrapper ||
      !prompt ||
      !copy ||
      !after ||
      !clients ||
      !docsLink
    ) {
      return false;
    }

    const required = [
      panel,
      nav,
      tokensLink,
      connectLink,
      body,
      hint,
      promptWrapper,
      prompt,
      copy,
      after,
      clients,
      docsLink,
      ...(headingRow ? [headingRow] : []),
      ...(heading ? [heading] : []),
      ...(back ? [back] : []),
      ...(checking ? [checking] : []),
      ...(error ? [error] : []),
      ...(retry ? [retry] : []),
      ...(setup instanceof HTMLElement ? [setup] : []),
    ];
    const document = panel.ownerDocument;
    if (
      new Set(required).size !== required.length ||
      required.some((element) => !element.isConnected || element.ownerDocument !== document)
    ) {
      return false;
    }
    for (const role of PANEL_ELEMENT_ROLES) {
      const element = elements[role];
      if (element && !this.#ownsElement(publication, role, element)) return false;
    }

    const shouldShowHeading = !render.hideHeading;
    const shouldShowBack = shouldShowHeading && Boolean(render.onBack);
    const shouldShowChecking = render.tokenCheckPending && !render.tokenCheckError;
    const shouldShowError = Boolean(render.tokenCheckError);
    if (
      shouldShowHeading !== Boolean(headingRow && heading) ||
      shouldShowBack !== Boolean(back) ||
      shouldShowChecking !== Boolean(checking) ||
      shouldShowError !== Boolean(error && retry) ||
      render.showSetup !== Boolean(setup)
    ) {
      return false;
    }

    const expectedTopLevel: Element[] = [];
    if (headingRow) expectedTopLevel.push(headingRow);
    if (checking) expectedTopLevel.push(checking);
    if (error) expectedTopLevel.push(error);
    if (setup) expectedTopLevel.push(setup);
    expectedTopLevel.push(nav, body, hint, promptWrapper, after, clients, docsLink);
    if (
      panel.className !== PANEL_CLASS ||
      panel.dataset.testid !== "keep-agent-panel" ||
      panel.children.length !== expectedTopLevel.length ||
      topLevelChildren.length !== expectedTopLevel.length ||
      expectedTopLevel.some(
        (element, index) =>
          panel.children.item(index) !== element ||
          topLevelChildren[index] !== element,
      )
    ) {
      return false;
    }

    if (headingRow && heading) {
      const expectedHeadingChildren = back ? [back, heading] : [heading];
      if (
        headingRow.className !== HEADING_ROW_CLASS ||
        headingRow.parentElement !== panel ||
        headingRow.children.length !== expectedHeadingChildren.length ||
        expectedHeadingChildren.some((element, index) => headingRow.children.item(index) !== element) ||
        heading.className !== HEADING_CLASS ||
        heading.tagName !== "H3" ||
        normalizedText(heading) !== "Keep an agent here"
      ) {
        return false;
      }
    }
    if (
      back &&
      (back.parentElement !== headingRow ||
        back.className !== BACK_CLASS ||
        back.type !== "button" ||
        back.disabled ||
        back.getAttribute("aria-label") !== "Back" ||
        back.dataset.testid !== "keep-agent-back")
    ) {
      return false;
    }
    if (
      checking &&
      (checking.parentElement !== panel ||
        checking.className !== CHECKING_CLASS ||
        checking.getAttribute("role") !== "status" ||
        checking.getAttribute("aria-live") !== "polite" ||
        checking.getAttribute("aria-atomic") !== "true" ||
        checking.dataset.testid !== "keep-agent-token-checking" ||
        checking.textContent?.trim() !== "Checking token setup…")
    ) {
      return false;
    }
    if (error && retry) {
      const alert = error.firstElementChild;
      if (
        error.parentElement !== panel ||
        error.className !== ERROR_CLASS ||
        error.dataset.testid !== "keep-agent-token-error" ||
        error.children.length !== 2 ||
        alert?.tagName !== "SPAN" ||
        alert.getAttribute("role") !== "alert" ||
        alert.getAttribute("aria-atomic") !== "true" ||
        alert.textContent !== render.tokenCheckError ||
        error.lastElementChild !== retry ||
        retry.className !== RETRY_CLASS ||
        retry.type !== "button" ||
        retry.disabled !== render.tokenCheckPending ||
        retry.getAttribute("aria-busy") !== (render.tokenCheckPending ? "true" : null) ||
        retry.textContent?.trim() !== (render.tokenCheckPending ? "Retrying…" : "Retry")
      ) {
        return false;
      }
    }
    if (
      setup &&
      (setup.tagName !== "SECTION" ||
        setup.parentElement !== panel ||
        (setup as HTMLElement).dataset.testid !== "agent-connect-card" ||
        setup.getAttribute("aria-label") !== "Connect an MCP client")
    ) {
      return false;
    }
    if (
      nav.parentElement !== panel ||
      nav.tagName !== "NAV" ||
      nav.className !== NAV_CLASS ||
      nav.getAttribute("aria-label") !== "Agent setup" ||
      nav.children.length !== 2 ||
      nav.firstElementChild !== tokensLink ||
      nav.lastElementChild !== connectLink ||
      tokensLink.className !== LINK_CLASS ||
      tokensLink.getAttribute("href") !== render.tokensHref ||
      tokensLink.textContent !== "Tokens" ||
      connectLink.className !== CONNECT_LINK_CLASS ||
      connectLink.getAttribute("href") !== render.connectHref ||
      connectLink.textContent !== "Connect an MCP client"
    ) {
      return false;
    }
    if (
      body.parentElement !== panel ||
      body.className !== BODY_CLASS ||
      body.textContent !== PANEL_BODY ||
      hint.parentElement !== panel ||
      hint.className !== HINT_CLASS ||
      hint.dataset.testid !== "keep-agent-hint" ||
      hint.textContent?.trim() !== KEEP_AGENT_HINT
    ) {
      return false;
    }
    if (
      promptWrapper.parentElement !== panel ||
      promptWrapper.className !== PROMPT_WRAPPER_CLASS ||
      promptWrapper.children.length !== 2 ||
      promptWrapper.firstElementChild !== prompt ||
      promptWrapper.lastElementChild !== copy ||
      prompt.className !== PROMPT_CLASS ||
      prompt.dataset.testid !== "keep-agent-prompt" ||
      prompt.children.length !== 0 ||
      prompt.textContent?.trim() !== render.prompt ||
      publication.target.current !== prompt ||
      this.#promptOwner?.draft !== publication.draft ||
      this.#promptOwner.element !== prompt
    ) {
      return false;
    }
    if (
      copy.parentElement !== promptWrapper ||
      copy.className !== COPY_CLASS ||
      copy.type !== "button" ||
      copy.disabled ||
      copy.getAttribute("aria-label") !== COPY_LABEL ||
      copy.dataset.testid !== "keep-agent-copy" ||
      normalizedText(copy) !== render.copyLabel
    ) {
      return false;
    }
    if (
      after.parentElement !== panel ||
      after.className !== BODY_CLASS ||
      after.dataset.testid !== "keep-agent-after" ||
      after.textContent?.trim() !== KEEP_AGENT_AFTER ||
      clients.parentElement !== panel ||
      clients.className !== BODY_CLASS ||
      clients.dataset.testid !== "keep-agent-clients" ||
      clients.textContent?.trim() !== CLIENTS ||
      docsLink.parentElement !== panel ||
      docsLink.className !== DOCS_LINK_CLASS ||
      docsLink.dataset.testid !== "keep-agent-docs-link" ||
      docsLink.getAttribute("href") !== render.docsHref ||
      docsLink.getAttribute("target") !== "_blank" ||
      docsLink.getAttribute("rel") !== "noreferrer" ||
      normalizedText(docsLink) !== "Agent docs · Sit in a document"
    ) {
      return false;
    }
    return (
      (!publication.back || sameNodes(publication.back.targets, publication.back.element)) &&
      (!publication.retry || sameNodes(publication.retry.targets, publication.retry.element)) &&
      sameNodes(publication.copy.targets, publication.copy.element)
    );
  }

  establish(draft: KeepAgentPanelDraft, target: RefObject<HTMLPreElement | null>) {
    const previous = this.#current;
    if (previous && previous.draft !== draft) this.retire(previous.draft);
    const { render, elements } = draft;
    const {
      panel,
      headingRow,
      heading,
      back,
      checking,
      error,
      retry,
      nav,
      tokensLink,
      connectLink,
      body,
      hint,
      promptWrapper,
      prompt,
      copy,
      after,
      clients,
      docsLink,
    } = elements;
    if (
      !panel ||
      !nav ||
      !tokensLink ||
      !connectLink ||
      !body ||
      !hint ||
      !promptWrapper ||
      !prompt ||
      !copy ||
      !after ||
      !clients ||
      !docsLink ||
      (render.hideHeading ? headingRow || heading || back : !headingRow || !heading) ||
      (!render.hideHeading && render.onBack ? !back : Boolean(back)) ||
      (render.tokenCheckPending && !render.tokenCheckError ? !checking : Boolean(checking)) ||
      (render.tokenCheckError ? !error || !retry : Boolean(error || retry))
    ) {
      this.retire(draft);
      return;
    }

    const prefixLength = Number(Boolean(headingRow)) + Number(Boolean(checking)) + Number(Boolean(error));
    const setup = render.showSetup ? panel.children.item(prefixLength) : null;
    if (render.showSetup && !setup) {
      this.retire(draft);
      return;
    }
    const action = (kind: PanelActionKind, element: HTMLButtonElement): KeepAgentPanelAction =>
      Object.freeze({ kind, element, targets: descendantsOf(element) });
    const frozenElements = Object.freeze({ ...elements });
    const publication: KeepAgentPanelPublication = Object.freeze({
      render,
      draft,
      target,
      elements: frozenElements,
      setup,
      topLevelChildren: Object.freeze(Array.from(panel.children)),
      back: back ? action("back", back) : null,
      retry: retry ? action("retry", retry) : null,
      copy: action("copy", copy),
    });
    if (!this.#renderIsCurrent(render) || !this.#hierarchyIsCurrent(publication)) {
      this.retire(draft);
      return;
    }
    draft.committed = true;
    draft.retired = false;
    this.#current = publication;
  }

  activate(
    render: KeepAgentPanelRender,
    kind: PanelActionKind,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) {
    const publication = this.#current;
    const action = publication?.[kind];
    const element = action?.element;
    const document = element?.ownerDocument;
    const MouseEventConstructor = document?.defaultView?.MouseEvent;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication ||
      !action ||
      publication.render !== render ||
      !element ||
      !document ||
      !MouseEventConstructor ||
      event.type !== "click" ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      event.currentTarget !== element ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, document) ||
      !element.contains(target) ||
      !action.targets.includes(target) ||
      !element.isConnected ||
      element.disabled ||
      this.#claimedActions.has(action) ||
      this.#claimedEvents.has(nativeEvent) ||
      !this.#hierarchyIsCurrent(publication) ||
      !this.#renderIsCurrent(render) ||
      (kind === "back" && !render.onBack) ||
      (kind === "retry" && (!render.tokenCheckError || render.tokenCheckPending))
    ) {
      return;
    }

    this.#claimedActions.add(action);
    this.#claimedEvents.add(nativeEvent);
    if (kind === "back") render.onBack?.();
    else if (kind === "retry") render.retryTokenCheck();
    else render.copy();
  }
}

/** The "Keep an agent here" contents: the Connect-an-agent card for first-timers, then the sentence and a Copy button. */
function KeepAgentHerePanelContent({
  doc,
  onCreateToken,
  onBack,
  active,
  hideHeading,
  tokenSetup,
}: KeepAgentHerePanelProps & { active: boolean; hideHeading: boolean; tokenSetup: TokenSetupCheck }) {
  const docId = doc.id;
  const docTitle = doc.title;
  const prompt = keepAgentPrompt({ id: docId, title: docTitle });
  const pre = useRef<HTMLPreElement>(null);
  const copySetup = useCopy(prompt, pre);
  const origin = useOrigin();
  const { hasTokens, pending: tokenCheckPending, error: tokenCheckError, retry: retryTokenCheck } = tokenSetup;
  const [mount] = useState(() => Symbol("keep-agent-panel"));
  const [coordinator] = useState(() => new KeepAgentPanelCoordinator(mount));
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    if (active) setDismissed(readDismissed());
  }, [active]);
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    } catch {
      /* private mode */
    }
  };
  const showSetup = hasTokens === false && !dismissed;
  const render: KeepAgentPanelRender = Object.freeze({
    identity: Symbol("keep-agent-panel-render"),
    mount,
    doc,
    docId,
    docTitle,
    prompt,
    onCreateToken,
    onBack,
    active,
    hideHeading,
    tokenSetup,
    hasTokens,
    tokenCheckPending,
    tokenCheckError,
    retryTokenCheck,
    copySetup,
    copy: copySetup.copy,
    copyStatus: copySetup.status,
    copyLabel: copySetup.label,
    copied: copySetup.copied,
    origin,
    dismissed,
    dismiss,
    showSetup,
    tokensHref: `/settings?next=${encodeURIComponent(`/d/${docId}`)}#tokens`,
    connectHref: `/settings?next=${encodeURIComponent(`/d/${docId}`)}#connect`,
    docsHref: `${AGENT_DOCS_URL}#sit-in-a-document`,
  });
  const draft = coordinator.createDraft(render);

  useLayoutEffect(() => {
    coordinator.establish(draft, pre);
    return () => coordinator.deactivate(draft);
  }, [coordinator, draft, pre]);

  return (
    <div ref={(element) => coordinator.bindElement(draft, "panel", element)} className={PANEL_CLASS} data-testid="keep-agent-panel">
      {!render.hideHeading && (
        <div ref={(element) => coordinator.bindElement(draft, "headingRow", element)} className={HEADING_ROW_CLASS}>
          {render.onBack && (
            <button
              ref={(element) => coordinator.bindElement(draft, "back", element)}
              type="button"
              className={BACK_CLASS}
              onClick={(event) => coordinator.activate(render, "back", event)}
              aria-label="Back"
              data-testid="keep-agent-back"
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <h3 ref={(element) => coordinator.bindElement(draft, "heading", element)} className={HEADING_CLASS}>
            <Radio size={15} className="text-violet-600" /> Keep an agent here
          </h3>
        </div>
      )}
      {render.tokenCheckPending && !render.tokenCheckError && (
        <p
          ref={(element) => coordinator.bindElement(draft, "checking", element)}
          className={CHECKING_CLASS}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="keep-agent-token-checking"
        >
          Checking token setup…
        </p>
      )}
      {render.tokenCheckError && (
        <div
          ref={(element) => coordinator.bindElement(draft, "error", element)}
          className={ERROR_CLASS}
          data-testid="keep-agent-token-error"
        >
          <span className="min-w-0 flex-1" role="alert" aria-atomic="true">{render.tokenCheckError}</span>
          <button
            ref={(element) => coordinator.bindElement(draft, "retry", element)}
            type="button"
            className={RETRY_CLASS}
            onClick={(event) => coordinator.activate(render, "retry", event)}
            disabled={render.tokenCheckPending}
            aria-busy={render.tokenCheckPending || undefined}
          >
            {render.tokenCheckPending ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {render.showSetup && <AgentConnectCard origin={render.origin} onDismiss={render.dismiss} onCreateToken={render.onCreateToken} className="p-3" />}
      <nav ref={(element) => coordinator.bindElement(draft, "nav", element)} className={NAV_CLASS} aria-label="Agent setup">
        <a ref={(element) => coordinator.bindElement(draft, "tokensLink", element)} className={LINK_CLASS} href={render.tokensHref}>Tokens</a>
        <a ref={(element) => coordinator.bindElement(draft, "connectLink", element)} className={CONNECT_LINK_CLASS} href={render.connectHref}>Connect an MCP client</a>
      </nav>
      <p ref={(element) => coordinator.bindElement(draft, "body", element)} className={BODY_CLASS}>{PANEL_BODY}</p>
      <p ref={(element) => coordinator.bindElement(draft, "hint", element)} className={HINT_CLASS} data-testid="keep-agent-hint">
        {KEEP_AGENT_HINT}
      </p>
      <div ref={(element) => coordinator.bindElement(draft, "promptWrapper", element)} className={PROMPT_WRAPPER_CLASS}>
        <pre
          ref={(element) => coordinator.bindPrompt(draft, pre, element)}
          className={PROMPT_CLASS}
          data-testid="keep-agent-prompt"
        >
          {render.prompt}
        </pre>
        <button
          ref={(element) => coordinator.bindElement(draft, "copy", element)}
          type="button"
          className={COPY_CLASS}
          onClick={(event) => coordinator.activate(render, "copy", event)}
          aria-label={COPY_LABEL}
          data-testid="keep-agent-copy"
        >
          {render.copied ? <Check size={14} /> : <Copy size={14} />}
          {render.copyLabel}
        </button>
      </div>
      <p ref={(element) => coordinator.bindElement(draft, "after", element)} className={BODY_CLASS} data-testid="keep-agent-after">
        {KEEP_AGENT_AFTER}
      </p>
      <p ref={(element) => coordinator.bindElement(draft, "clients", element)} className={BODY_CLASS} data-testid="keep-agent-clients">
        {CLIENTS}
      </p>
      <a
        ref={(element) => coordinator.bindElement(draft, "docsLink", element)}
        className={DOCS_LINK_CLASS}
        href={render.docsHref}
        target="_blank"
        rel="noreferrer"
        data-testid="keep-agent-docs-link"
      >
        Agent docs <span aria-hidden="true">·</span> Sit in a document <ExternalLink size={13} aria-hidden="true" />
      </a>
    </div>
  );
}

export function KeepAgentHerePanel({ doc, onCreateToken, onBack, active = true, hideHeading = false }: KeepAgentHerePanelProps) {
  const tokenSetup = useHasTokens(active);
  return (
    <KeepAgentHerePanelContent
      doc={doc}
      onCreateToken={onCreateToken}
      onBack={onBack}
      active={active}
      hideHeading={hideHeading}
      tokenSetup={tokenSetup}
    />
  );
}

export interface KeepAgentHereDialogProps {
  doc: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateToken?: () => void;
}

/**
 * "Keep an agent here" as a dialog: the {@link KeepAgentHerePanel} with the ready-to-paste sentence. Opened from
 * the presence popover, the command palette (`doc:keep-agent`) and the editor's `/agent` slash item.
 */
export function KeepAgentHereDialog({ doc, open, onOpenChange, onCreateToken }: KeepAgentHereDialogProps) {
  const tokenSetup = useHasTokens(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keep an agent here" className="max-h-[calc(100dvh-2rem)] w-[min(94vw,520px)] overflow-y-auto">
        <div data-testid="keep-agent-dialog">
          <KeepAgentHerePanelContent doc={doc} onCreateToken={onCreateToken} active={open} hideHeading tokenSetup={tokenSetup} />
        </div>
      </DialogContent>
    </Dialog>
  );
}