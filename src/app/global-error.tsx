"use client";

import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

// Last resort for an error thrown by the root layout itself (Next uses it in production builds only). The
// layout — and with it globals.css, Tailwind and the fonts — is gone when this shows, so it renders its own
// <html>/<body> with inline styles. Colours go through custom properties so the one <style> block can switch
// them on the OS preference (no theme boot script has run); the values are globals.css's light/dark palette.
// Same copy, actions and test ids as error.tsx; React and Next already log the error once — no logging here.

const PALETTE = `:root { --bg: #f7f5f0; --ink: #1c1917; --ink-2: #44403c; --ink-3: #57534e; --accent: #0f766e; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1f24; --ink: #e7e5e4; --ink-2: #d6d3d1; --ink-3: #a8a29e; --accent: #2dd4bf; --on-accent: #14161a; }
}`;

const body: CSSProperties = {
  margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  padding: "1rem", background: "var(--bg)", color: "var(--ink)", textAlign: "center",
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const column: CSSProperties = { width: "100%", maxWidth: "28rem" };
const eyebrow: CSSProperties = { margin: 0, fontSize: "0.75rem", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-3)" };
const heading: CSSProperties = { margin: "0.5rem 0 0", fontSize: "1.5rem", fontWeight: 600 };
const text: CSSProperties = { margin: "0.5rem auto 0", fontSize: "0.875rem", color: "var(--ink-3)" };
const actions: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.75rem", marginTop: "1.5rem" };
const action: CSSProperties = {
  display: "inline-flex", alignItems: "center", minHeight: "2.5rem", padding: "0 0.875rem", border: 0, borderRadius: "0.375rem",
  font: "inherit", fontSize: "0.875rem", fontWeight: 500, textDecoration: "none", cursor: "pointer",
};
const primary: CSSProperties = { ...action, background: "var(--accent)", color: "var(--on-accent)" };
const ghost: CSSProperties = { ...action, background: "transparent", color: "var(--ink-2)" };
const details: CSSProperties = { width: "100%", overflowWrap: "anywhere", marginTop: "1.5rem", fontSize: "0.75rem", textAlign: "left", color: "var(--ink-3)" };
const pre: CSSProperties = { margin: "0.25rem 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

type BoundaryError = Error & { digest?: string };

interface ErrorRender {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly error: BoundaryError;
  readonly message: string;
  readonly digest: string | undefined;
  readonly reset: () => void;
}

interface ErrorElements {
  actions: HTMLDivElement | null;
  retry: HTMLButtonElement | null;
}

type ErrorElementRole = keyof ErrorElements;

interface ErrorDraft {
  readonly render: ErrorRender;
  readonly elements: ErrorElements;
  readonly lastElements: ErrorElements;
  committed: boolean;
  retired: boolean;
}

interface RetryPublication {
  readonly render: ErrorRender;
  readonly draft: ErrorDraft;
  readonly actions: HTMLDivElement;
  readonly retry: HTMLButtonElement;
  readonly ownerDocument: Document;
  readonly actionsParent: HTMLElement;
  readonly actionNodes: readonly Node[];
  readonly retryTargets: readonly Node[];
  readonly actionsMarkup: string;
  readonly retryMarkup: string;
}

interface ErrorElementOwner {
  readonly draft: ErrorDraft;
  readonly role: ErrorElementRole;
  readonly element: HTMLElement;
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

function sameNodes(expected: readonly Node[], actual: readonly Node[]): boolean {
  return expected.length === actual.length && actual.every((node, index) => node === expected[index]);
}

function isNodeFromDocument(value: EventTarget | null, ownerDocument: Document): value is Node {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  return Boolean(
    NodeConstructor &&
      value instanceof NodeConstructor &&
      value.ownerDocument === ownerDocument,
  );
}

function isEffectivelyEnabled(button: HTMLButtonElement): boolean {
  if (
    button.disabled ||
    button.matches(":disabled") ||
    button.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let element: HTMLElement | null = button; element; element = element.parentElement) {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

class ErrorRetryCoordinator {
  readonly #mount: symbol;
  #current: RetryPublication | null = null;
  #elementOwners = new WeakMap<HTMLElement, ErrorElementOwner>();
  #claimedPublications = new WeakSet<RetryPublication>();
  #claimedEvents = new WeakSet<Event>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  createDraft(render: ErrorRender): ErrorDraft {
    return {
      render,
      elements: { actions: null, retry: null },
      lastElements: { actions: null, retry: null },
      committed: false,
      retired: false,
    };
  }

  deactivate(draft: ErrorDraft) {
    if (this.#current?.draft === draft) this.#current = null;
  }

  retire(draft: ErrorDraft) {
    draft.retired = true;
    this.deactivate(draft);
    for (const role of ["actions", "retry"] as const) {
      const element = draft.elements[role];
      if (!element) continue;
      const owner = this.#elementOwners.get(element);
      if (owner?.draft === draft && owner.role === role && owner.element === element) {
        this.#elementOwners.delete(element);
      }
    }
  }

  bind<Role extends ErrorElementRole>(
    draft: ErrorDraft,
    role: Role,
    element: ErrorElements[Role],
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

  #ownsElement(
    publication: RetryPublication,
    role: ErrorElementRole,
    element: HTMLElement,
  ) {
    const owner = this.#elementOwners.get(element);
    return owner?.draft === publication.draft && owner.role === role && owner.element === element;
  }

  #renderIsCurrent(render: ErrorRender): boolean {
    return (
      render.mount === this.#mount &&
      render.error.message === render.message &&
      render.error.digest === render.digest
    );
  }

  #publicationIsCurrent(publication: RetryPublication): boolean {
    const { actions, retry, ownerDocument, actionsParent } = publication;
    return (
      this.#current === publication &&
      publication.draft.committed &&
      !publication.draft.retired &&
      this.#renderIsCurrent(publication.render) &&
      actions.isConnected &&
      retry.isConnected &&
      actions.ownerDocument === ownerDocument &&
      retry.ownerDocument === ownerDocument &&
      actions.parentElement === actionsParent &&
      retry.parentElement === actions &&
      this.#ownsElement(publication, "actions", actions) &&
      this.#ownsElement(publication, "retry", retry) &&
      sameNodes(publication.actionNodes, Array.from(actions.childNodes)) &&
      actions.outerHTML === publication.actionsMarkup &&
      retry.outerHTML === publication.retryMarkup &&
      isEffectivelyEnabled(retry)
    );
  }

  establish(draft: ErrorDraft) {
    const previous = this.#current;
    if (previous && previous.draft !== draft) this.retire(previous.draft);
    const { actions, retry } = draft.elements;
    const actionsParent = actions?.parentElement;
    if (
      !actions ||
      !retry ||
      !actionsParent ||
      !actions.isConnected ||
      !retry.isConnected ||
      retry.parentElement !== actions ||
      actions.firstElementChild !== retry ||
      actions.children.length !== 2 ||
      !this.#ownsDraftElement(draft, "actions", actions) ||
      !this.#ownsDraftElement(draft, "retry", retry) ||
      !isEffectivelyEnabled(retry)
    ) {
      this.retire(draft);
      return;
    }

    const publication: RetryPublication = Object.freeze({
      render: draft.render,
      draft,
      actions,
      retry,
      ownerDocument: actions.ownerDocument,
      actionsParent,
      actionNodes: Object.freeze(Array.from(actions.childNodes)),
      retryTargets: descendantsOf(retry),
      actionsMarkup: actions.outerHTML,
      retryMarkup: retry.outerHTML,
    });
    if (!this.#renderIsCurrent(draft.render)) {
      this.retire(draft);
      return;
    }
    draft.committed = true;
    draft.retired = false;
    this.#current = publication;
  }

  #ownsDraftElement(
    draft: ErrorDraft,
    role: ErrorElementRole,
    element: HTMLElement,
  ) {
    const owner = this.#elementOwners.get(element);
    return owner?.draft === draft && owner.role === role && owner.element === element;
  }

  activate(render: ErrorRender, event: ReactMouseEvent<HTMLButtonElement>) {
    const publication = this.#current;
    const retry = publication?.retry;
    const ownerDocument = publication?.ownerDocument;
    const MouseEventConstructor = ownerDocument?.defaultView?.MouseEvent;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication ||
      publication.render !== render ||
      !retry ||
      !ownerDocument ||
      !MouseEventConstructor ||
      event.type !== "click" ||
      !(nativeEvent instanceof MouseEventConstructor) ||
      nativeEvent.type !== "click" ||
      event.currentTarget !== retry ||
      nativeEvent.target !== target ||
      !isNodeFromDocument(target, ownerDocument) ||
      !retry.contains(target) ||
      !publication.retryTargets.includes(target) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedEvents.has(nativeEvent) ||
      !this.#publicationIsCurrent(publication)
    ) {
      return;
    }

    this.#claimedPublications.add(publication);
    this.#claimedEvents.add(nativeEvent);
    publication.render.reset();
  }
}

export default function GlobalError({ error, reset }: { error: BoundaryError; reset: () => void }) {
  const [mount] = useState(() => Symbol("global-error"));
  const [coordinator] = useState(() => new ErrorRetryCoordinator(mount));
  const render: ErrorRender = Object.freeze({
    identity: Symbol("global-error-render"),
    mount,
    error,
    message: error.message,
    digest: error.digest,
    reset,
  });
  const draft = coordinator.createDraft(render);

  useLayoutEffect(() => {
    coordinator.establish(draft);
    return () => coordinator.deactivate(draft);
  }, [coordinator, draft]);

  return (
    <html lang="en">
      <body style={body}>
        <style>{PALETTE}</style>
        <main style={column} data-testid="app-error">
          <p style={eyebrow}>Error</p>
          <h1 style={heading}>Something went wrong</h1>
          <p style={text}>Markdoc couldn&apos;t show this page. Try again, or go back to your documents.</p>
          <div
            ref={(element) => coordinator.bind(draft, "actions", element)}
            style={actions}
          >
            <button
              ref={(element) => coordinator.bind(draft, "retry", element)}
              type="button"
              style={primary}
              onClick={(event) => coordinator.activate(render, event)}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- keeps next/link out of every route's shared chunk (#1485) */}
            <a href="/" style={ghost}>Back to your documents</a>
          </div>
          <details style={details}>
            <summary>Details</summary>
            {error.digest ? <p data-testid="app-error-digest">Reference: {error.digest}</p> : null}
            {error.message ? <pre style={pre}>{error.message}</pre> : null}
          </details>
        </main>
      </body>
    </html>
  );
}
