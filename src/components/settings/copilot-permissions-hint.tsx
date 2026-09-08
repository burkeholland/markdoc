"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
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
  readonly copy: () => void;
  readonly status: CopyStatus;
  readonly label: string;
  readonly copied: boolean;
  readonly rootClassName: string;
  readonly rootTestId: string;
  readonly lineTestId: string;
  readonly copyTestId: string;
}

interface PermissionHintDraft {
  readonly render: PermissionHintRender;
  root: HTMLDivElement | null;
  pre: HTMLPreElement | null;
  button: HTMLButtonElement | null;
  committed: boolean;
  retired: boolean;
}

interface PermissionHintPublication extends PermissionHintRender {
  readonly render: PermissionHintRender;
  readonly root: HTMLDivElement;
  readonly pre: HTMLPreElement;
  readonly button: HTMLButtonElement;
  readonly target: RefObject<HTMLPreElement | null>;
}

interface PreOwner {
  readonly draft: PermissionHintDraft;
  readonly target: RefObject<HTMLPreElement | null>;
  readonly element: HTMLPreElement;
}

function exactHierarchy(publication: PermissionHintPublication): boolean {
  const { root, pre, button, render } = publication;
  const controls = pre.parentElement;
  return (
    publication.identity === render.identity &&
    publication.mount === render.mount &&
    publication.testIdPrefix === render.testIdPrefix &&
    publication.className === render.className &&
    Object.is(publication.scope, render.scope) &&
    publication.line === render.line &&
    publication.copy === render.copy &&
    publication.status === render.status &&
    publication.label === render.label &&
    publication.copied === render.copied &&
    root.isConnected &&
    pre.isConnected &&
    button.isConnected &&
    !button.disabled &&
    root.ownerDocument === pre.ownerDocument &&
    root.ownerDocument === button.ownerDocument &&
    root.className === render.rootClassName &&
    root.dataset.testid === render.rootTestId &&
    pre.className === LINE_CLASS &&
    pre.dataset.testid === render.lineTestId &&
    pre.children.length === 0 &&
    pre.textContent === render.line &&
    button.className === COPY_CLASS &&
    button.dataset.testid === render.copyTestId &&
    button.type === "button" &&
    button.getAttribute("aria-label") === COPY_LABEL &&
    button.textContent === render.label &&
    controls !== null &&
    controls.parentElement === root &&
    root.children.item(2) === controls &&
    controls.children.length === 2 &&
    controls.firstElementChild === pre &&
    controls.lastElementChild === button &&
    pre.nextElementSibling === button &&
    publication.target.current === pre
  );
}

class PermissionHintCoordinator {
  #active: PermissionHintPublication | null = null;
  #preOwner: PreOwner | null = null;
  #claimedEvents = new WeakSet<object>();

  createDraft(render: PermissionHintRender): PermissionHintDraft {
    return { render, root: null, pre: null, button: null, committed: false, retired: false };
  }

  retire(draft: PermissionHintDraft) {
    if (draft.retired) return;
    draft.retired = true;
    if (this.#active?.render === draft.render) this.#active = null;
    if (this.#preOwner?.draft === draft) {
      const { target, element } = this.#preOwner;
      this.#preOwner = null;
      if (target.current === element) target.current = null;
    }
  }

  bindRoot(draft: PermissionHintDraft, element: HTMLDivElement | null) {
    if (element === null) {
      const wasBound = draft.root !== null;
      draft.root = null;
      if (wasBound && draft.committed) this.retire(draft);
      return;
    }
    if (draft.retired) return;
    if (draft.root && draft.root !== element) {
      this.retire(draft);
      return;
    }
    draft.root = element;
  }

  bindPre(draft: PermissionHintDraft, target: RefObject<HTMLPreElement | null>, element: HTMLPreElement | null) {
    if (element === null) {
      const previous = draft.pre;
      draft.pre = null;
      if (previous && this.#preOwner?.draft === draft && this.#preOwner.element === previous) {
        this.#preOwner = null;
        if (target.current === previous) target.current = null;
      }
      if (previous && draft.committed) this.retire(draft);
      return;
    }
    if (draft.retired) return;
    if (draft.pre && draft.pre !== element) {
      this.retire(draft);
      return;
    }
    draft.pre = element;
    this.#preOwner = { draft, target, element };
    target.current = element;
  }

  bindButton(draft: PermissionHintDraft, element: HTMLButtonElement | null) {
    if (element === null) {
      const wasBound = draft.button !== null;
      draft.button = null;
      if (wasBound && draft.committed) this.retire(draft);
      return;
    }
    if (draft.retired) return;
    if (draft.button && draft.button !== element) {
      this.retire(draft);
      return;
    }
    draft.button = element;
  }

  establish(draft: PermissionHintDraft, target: RefObject<HTMLPreElement | null>) {
    const { render, root, pre, button } = draft;
    if (draft.retired || !root || !pre || !button) {
      this.retire(draft);
      return;
    }
    const publication: PermissionHintPublication = Object.freeze({
      ...render,
      render,
      root,
      pre,
      button,
      target,
    });
    if (!exactHierarchy(publication)) {
      this.retire(draft);
      return;
    }
    draft.committed = true;
    this.#active = publication;
    return () => this.retire(draft);
  }

  activate(render: PermissionHintRender, event: ReactMouseEvent<HTMLButtonElement>) {
    const publication = this.#active;
    if (
      !publication ||
      publication.render !== render ||
      event.currentTarget !== publication.button ||
      this.#claimedEvents.has(event) ||
      !exactHierarchy(publication)
    ) {
      return;
    }
    this.#claimedEvents.add(event);
    publication.copy();
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
  const { copy, status, label, copied } = useCopy(line, target);
  const [mount] = useState(() => Symbol("copilot-permissions-hint"));
  const [coordinator] = useState(() => new PermissionHintCoordinator());
  const render: PermissionHintRender = {
    identity: Symbol("copilot-permissions-render"),
    mount,
    testIdPrefix,
    className,
    scope,
    line,
    copy,
    status,
    label,
    copied,
    rootClassName: cn(ROOT_CLASS, className),
    rootTestId: `${testIdPrefix}-permissions`,
    lineTestId: `${testIdPrefix}-allow-line`,
    copyTestId: `${testIdPrefix}-allow-copy`,
  };
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
          onClick={(event) => coordinator.activate(render, event)}
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
