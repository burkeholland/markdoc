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
  readonly copySetup: ReturnType<typeof useCopy>;
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

interface CopyBlockDraft {
  readonly render: CopyBlockRender;
  readonly elements: CopyBlockElements;
  readonly lastElements: CopyBlockElements;
  committed: boolean;
  retired: boolean;
}

interface CopyBlockPublication {
  readonly render: CopyBlockRender;
  readonly draft: CopyBlockDraft;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly wrapper: HTMLDivElement;
  readonly pre: HTMLPreElement;
  readonly button: HTMLButtonElement;
  readonly nodes: readonly Node[];
  readonly buttonTargets: readonly Node[];
}

interface CopyBlockElementOwner {
  readonly draft: CopyBlockDraft;
  readonly role: CopyBlockElementRole;
  readonly element: HTMLElement;
}

interface CopyBlockPreOwner {
  readonly draft: CopyBlockDraft;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly element: HTMLPreElement;
}

function copyBlockDescendants(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const collect = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) collect(child);
  };
  collect(element);
  return Object.freeze(nodes);
}

function sameCopyBlockNodes(expected: readonly Node[], element: HTMLElement): boolean {
  const current = copyBlockDescendants(element);
  return current.length === expected.length && current.every((node, index) => node === expected[index]);
}

class CopyBlockCoordinator {
  readonly #mount: symbol;
  #current: CopyBlockPublication | null = null;
  #elementOwners = new WeakMap<HTMLElement, CopyBlockElementOwner>();
  #preOwner: CopyBlockPreOwner | null = null;
  #claimedPublications = new WeakSet<CopyBlockPublication>();
  #claimedEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: CopyBlockRender): CopyBlockDraft {
    return {
      render,
      elements: { wrapper: null, pre: null, button: null },
      lastElements: { wrapper: null, pre: null, button: null },
      committed: false,
      retired: false,
    };
  }

  deactivate(draft: CopyBlockDraft) {
    if (this.#current?.draft === draft) this.#current = null;
  }

  retire(draft: CopyBlockDraft) {
    draft.retired = true;
    this.deactivate(draft);
    for (const role of ["wrapper", "pre", "button"] as const) {
      const element = draft.elements[role];
      if (!element) continue;
      const owner = this.#elementOwners.get(element);
      if (owner?.draft === draft && owner.role === role && owner.element === element) {
        this.#elementOwners.delete(element);
      }
    }
    const preOwner = this.#preOwner;
    if (preOwner?.draft === draft) {
      this.#preOwner = null;
      if (preOwner.target.current === preOwner.element) preOwner.target.current = null;
    }
  }

  bindElement<Role extends "wrapper" | "button">(
    draft: CopyBlockDraft,
    role: Role,
    element: CopyBlockElements[Role],
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
      const owner = this.#elementOwners.get(element);
      if (
        !draft.committed ||
        draft.lastElements[role] !== element ||
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

  bindPre(
    draft: CopyBlockDraft,
    target: RefObject<HTMLPreElement | null>,
    element: HTMLPreElement | null,
  ) {
    const previous = draft.elements.pre;
    if (element === null) {
      if (previous) {
        const owner = this.#elementOwners.get(previous);
        if (owner?.draft === draft && owner.role === "pre" && owner.element === previous) {
          this.#elementOwners.delete(previous);
        }
      }
      draft.elements.pre = null;
      const preOwner = this.#preOwner;
      if (previous && preOwner?.draft === draft && preOwner.element === previous) {
        this.#preOwner = null;
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
        draft.lastElements.pre !== element ||
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
    if (displaced && (displaced.draft !== draft || displaced.role !== "pre")) {
      this.retire(displaced.draft);
    }
    draft.elements.pre = element;
    draft.lastElements.pre = element;
    this.#elementOwners.set(element, { draft, role: "pre", element });
    this.#preOwner = { draft, target, element };
    target.current = element;
  }

  #ownsElement(
    publication: CopyBlockPublication,
    role: CopyBlockElementRole,
    element: HTMLElement,
  ): boolean {
    const owner = this.#elementOwners.get(element);
    return owner?.draft === publication.draft && owner.role === role && owner.element === element;
  }

  #renderIsCurrent(render: CopyBlockRender): boolean {
    const setup = render.copySetup;
    return (
      render.mount === this.#mount &&
      setup.copy === render.copy &&
      setup.status === render.status &&
      setup.label === render.buttonLabel &&
      setup.copied === render.copied &&
      render.ariaLabel === `Copy ${render.label}`
    );
  }

  #hierarchyIsCurrent(publication: CopyBlockPublication): boolean {
    const { render, draft, target, wrapper, pre, button } = publication;
    const document = wrapper.ownerDocument;
    const icon = button.firstElementChild;
    if (
      new Set([wrapper, pre, button]).size !== 3 ||
      !wrapper.isConnected ||
      !pre.isConnected ||
      !button.isConnected ||
      pre.ownerDocument !== document ||
      button.ownerDocument !== document ||
      !this.#ownsElement(publication, "wrapper", wrapper) ||
      !this.#ownsElement(publication, "pre", pre) ||
      !this.#ownsElement(publication, "button", button) ||
      this.#preOwner?.draft !== draft ||
      this.#preOwner.target !== target ||
      this.#preOwner.element !== pre ||
      target.current !== pre ||
      wrapper.className !== COPY_BLOCK_CLASS ||
      wrapper.children.length !== 2 ||
      wrapper.firstElementChild !== pre ||
      wrapper.lastElementChild !== button ||
      pre.parentElement !== wrapper ||
      pre.nextElementSibling !== button ||
      pre.className !== COPY_BLOCK_PRE_CLASS ||
      pre.dataset.testid !== render.testId ||
      pre.children.length !== 0 ||
      pre.textContent !== render.value ||
      button.parentElement !== wrapper ||
      button.className !== COPY_BLOCK_BUTTON_CLASS ||
      button.dataset.testid !== render.copyTestId ||
      button.type !== "button" ||
      button.disabled ||
      button.getAttribute("aria-label") !== render.ariaLabel ||
      button.textContent !== render.buttonLabel ||
      button.children.length !== 1 ||
      !icon ||
      icon.tagName.toLowerCase() !== "svg" ||
      !icon.classList.contains(render.copied ? "lucide-check" : "lucide-copy") ||
      icon.getAttribute("width") !== "14" ||
      icon.getAttribute("height") !== "14" ||
      icon.getAttribute("aria-hidden") !== "true" ||
      !sameCopyBlockNodes(publication.nodes, wrapper) ||
      !sameCopyBlockNodes(publication.buttonTargets, button)
    ) {
      return false;
    }
    return true;
  }

  establish(draft: CopyBlockDraft, target: RefObject<HTMLPreElement | null>) {
    const previous = this.#current;
    if (previous && previous.draft !== draft) this.retire(previous.draft);
    const { wrapper, pre, button } = draft.elements;
    if (draft.retired || !wrapper || !pre || !button) {
      this.retire(draft);
      return;
    }
    const publication: CopyBlockPublication = Object.freeze({
      render: draft.render,
      draft,
      target,
      wrapper,
      pre,
      button,
      nodes: copyBlockDescendants(wrapper),
      buttonTargets: copyBlockDescendants(button),
    });
    if (!this.#renderIsCurrent(draft.render) || !this.#hierarchyIsCurrent(publication)) {
      this.retire(draft);
      return;
    }
    draft.committed = true;
    draft.retired = false;
    this.#current = publication;
  }

  activate(render: CopyBlockRender, event: ReactMouseEvent<HTMLButtonElement>) {
    const publication = this.#current;
    const button = publication?.button;
    const document = button?.ownerDocument;
    const view = document?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !publication ||
      publication.render !== render ||
      !button ||
      !document ||
      !view ||
      event.type !== "click" ||
      !(nativeEvent instanceof view.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      event.currentTarget !== button ||
      nativeEvent.target !== target ||
      !(target instanceof view.Node) ||
      target.ownerDocument !== document ||
      !button.contains(target) ||
      !publication.buttonTargets.includes(target) ||
      !button.isConnected ||
      button.disabled ||
      this.#claimedPublications.has(publication) ||
      this.#claimedEvents.has(nativeEvent) ||
      !this.#hierarchyIsCurrent(publication) ||
      !this.#renderIsCurrent(render)
    ) {
      return;
    }

    this.#claimedPublications.add(publication);
    this.#claimedEvents.add(nativeEvent);
    publication.render.copy();
  }
}

export function CopyBlock({ value, label, testId, copyTestId }: { value: string; label: string; testId?: string; copyTestId?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const copySetup = useCopy(value, pre);
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

  useLayoutEffect(() => {
    coordinator.establish(draft, pre);
    return () => coordinator.deactivate(draft);
  }, [coordinator, draft, pre]);

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
        onClick={(event) => coordinator.activate(render, event)}
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
