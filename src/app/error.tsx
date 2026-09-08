"use client";

import { useLayoutEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

// Next wraps every route segment below the root layout in this boundary, so an uncaught render or
// lifecycle error in a client component shows this screen inside the root layout (fonts, theme)
// instead of Next's blank "Application error" page; `reset()` re-renders the failed segment. Nothing is
// imported from the app (`@/lib`, `@/components`, `next/link`, `next/navigation`): the boundary has to
// render while the rest of the app is broken. React and Next already log the error once — no logging here.

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

export default function AppError({ error, reset }: { error: BoundaryError; reset: () => void }) {
  const [mount] = useState(() => Symbol("app-error"));
  const [coordinator] = useState(() => new ErrorRetryCoordinator(mount));
  const render: ErrorRender = Object.freeze({
    identity: Symbol("app-error-render"),
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
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-2 px-4 py-4 text-center" data-testid="app-error">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Error</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-3">Markdoc couldn&apos;t show this page. Try again, or go back to your documents.</p>
      <div
        ref={(element) => coordinator.bind(draft, "actions", element)}
        className="mt-6 flex flex-wrap items-center justify-center gap-3"
      >
        {/* `.btn` is h-9 (36 px); on a phone the two actions grow to a 40 px finger-sized target. */}
        <button
          ref={(element) => coordinator.bind(draft, "retry", element)}
          type="button"
          className="btn btn-primary max-sm:h-10"
          onClick={(event) => coordinator.activate(render, event)}
        >
          Try again
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- keeps next/link out of every route's shared chunk (#1485) */}
        <a href="/" className="btn btn-ghost max-sm:h-10">Back to your documents</a>
      </div>
      <details className="mt-6 max-w-sm text-left text-xs text-ink-3">
        <summary>Details</summary>
        {/* A production server error arrives with its message redacted and only a digest: that is what support asks for. */}
        {error.digest ? <p data-testid="app-error-digest">Reference: {error.digest}</p> : null}
        {error.message ? <pre className="mt-1 whitespace-pre-wrap break-words">{error.message}</pre> : null}
      </details>
    </main>
  );
}
