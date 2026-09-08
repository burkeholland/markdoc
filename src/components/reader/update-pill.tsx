"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { RefreshCw } from "lucide-react";

const PILL_CLASS_NAME = "reader-pill pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center";
const BUTTON_CLASS_NAME =
  "pointer-events-auto inline-flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3.5 py-1.5 text-sm font-medium text-ink shadow-md hover:bg-surface-2";
const UPDATED_CLASS_NAME = "text-ink-3";
const SEPARATOR_CLASS_NAME = "text-ink-4";
const ICON_CLASS_NAME = "text-accent";
const CONTROL_TEXT = "Updated—Refresh";

type DocumentAuthority = Readonly<{
  mount: symbol;
  docId: string;
  initialHash: string;
}>;

type RefreshPublication = Readonly<{
  document: DocumentAuthority;
}>;

type PollingAuthority = Readonly<{
  document: DocumentAuthority;
  pollMs: number;
}>;

type PollingOwner = {
  authority: PollingAuthority;
  retire: () => void;
};

type RequestOwner = {
  authority: PollingAuthority;
  controller: AbortController;
};

type RefreshControlRender = Readonly<{
  identity: symbol;
  mount: symbol;
  document: DocumentAuthority;
  polling: PollingAuthority;
  refresh: RefreshPublication;
}>;

type ElementOwner<T extends Element> = Readonly<{
  render: RefreshControlRender;
  element: T;
}>;

type RefreshControlPublication = Readonly<{
  render: RefreshControlRender;
  pill: HTMLDivElement;
  button: HTMLButtonElement;
  markup: string;
  reload: () => void;
}>;

function retireControlPublication(
  render: RefreshControlRender,
  publicationRef: RefObject<RefreshControlPublication | null>,
) {
  if (publicationRef.current?.render === render) publicationRef.current = null;
}

function controlHasExpectedPresentation(pill: HTMLDivElement, button: HTMLButtonElement): boolean {
  const updated = button.children.item(0);
  const separator = button.children.item(1);
  const icon = button.children.item(2);
  return (
    pill.isConnected &&
    button.isConnected &&
    pill.tagName === "DIV" &&
    button.tagName === "BUTTON" &&
    pill.getAttribute("class") === PILL_CLASS_NAME &&
    pill.getAttribute("role") === "status" &&
    pill.dataset.testid === "reader-updated" &&
    pill.children.length === 1 &&
    pill.firstElementChild === button &&
    button.parentElement === pill &&
    button.getAttribute("type") === "button" &&
    button.type === "button" &&
    !button.disabled &&
    button.getAttribute("class") === BUTTON_CLASS_NAME &&
    button.children.length === 3 &&
    button.childNodes.length === 4 &&
    updated?.tagName === "SPAN" &&
    updated.getAttribute("class") === UPDATED_CLASS_NAME &&
    updated.textContent === "Updated" &&
    separator?.tagName === "SPAN" &&
    separator.getAttribute("class") === SEPARATOR_CLASS_NAME &&
    separator.getAttribute("aria-hidden") === "true" &&
    separator.textContent === "—" &&
    icon?.tagName.toLowerCase() === "svg" &&
    icon.classList.contains("lucide-refresh-cw") &&
    icon.getAttribute("class")?.split(/\s+/).includes(ICON_CLASS_NAME) === true &&
    icon.getAttribute("width") === "14" &&
    icon.getAttribute("height") === "14" &&
    button.childNodes.item(3)?.nodeType === Node.TEXT_NODE &&
    button.childNodes.item(3)?.nodeValue === "Refresh" &&
    button.textContent === CONTROL_TEXT
  );
}

function currentControlPublication(
  render: RefreshControlRender,
  source: HTMLButtonElement,
  publicationRef: RefObject<RefreshControlPublication | null>,
  claimedRef: RefObject<RefreshControlPublication | null>,
  documentAuthorityRef: RefObject<DocumentAuthority | null>,
  pollingAuthorityRef: RefObject<PollingAuthority | null>,
  refreshPublicationRef: RefObject<RefreshPublication | null>,
  pillOwnerRef: RefObject<ElementOwner<HTMLDivElement> | null>,
  buttonOwnerRef: RefObject<ElementOwner<HTMLButtonElement> | null>,
): RefreshControlPublication | null {
  const publication = publicationRef.current;
  if (
    !publication ||
    publication.render !== render ||
    claimedRef.current === publication ||
    render.mount !== render.document.mount ||
    render.document !== render.polling.document ||
    render.document !== render.refresh.document ||
    documentAuthorityRef.current !== render.document ||
    pollingAuthorityRef.current !== render.polling ||
    refreshPublicationRef.current !== render.refresh ||
    pillOwnerRef.current?.render !== render ||
    pillOwnerRef.current.element !== publication.pill ||
    buttonOwnerRef.current?.render !== render ||
    buttonOwnerRef.current.element !== publication.button ||
    source !== publication.button ||
    !controlHasExpectedPresentation(publication.pill, publication.button) ||
    publication.pill.outerHTML !== publication.markup
  ) {
    return null;
  }
  return publication;
}

/**
 * Polls the document's content hash while the tab is visible and offers a refresh when it
 * changed. No WebSocket: a reader does not need live cursors, only to know it is stale.
 */
export function UpdatePill({ docId, initialHash, pollMs }: { docId: string; initialHash: string; pollMs: number }) {
  const [mount] = useState(() => Symbol("reader-update-pill"));
  const documentAuthority = useMemo<DocumentAuthority>(
    () => Object.freeze({ mount, docId, initialHash }),
    [mount, docId, initialHash],
  );
  const authority = useMemo<PollingAuthority>(
    () => Object.freeze({ document: documentAuthority, pollMs }),
    [documentAuthority, pollMs],
  );
  const documentAuthorityRef = useRef<DocumentAuthority | null>(null);
  const authorityRef = useRef<PollingAuthority | null>(null);
  const pollingOwnerRef = useRef<PollingOwner | null>(null);
  const requestOwnerRef = useRef<RequestOwner | null>(null);
  const refreshPublicationRef = useRef<RefreshPublication | null>(null);
  const controlPublicationRef = useRef<RefreshControlPublication | null>(null);
  const claimedControlPublicationRef = useRef<RefreshControlPublication | null>(null);
  const pillOwnerRef = useRef<ElementOwner<HTMLDivElement> | null>(null);
  const buttonOwnerRef = useRef<ElementOwner<HTMLButtonElement> | null>(null);
  const [refreshPublication, setRefreshPublication] = useState<RefreshPublication | null>(null);

  useLayoutEffect(() => {
    documentAuthorityRef.current = documentAuthority;

    return () => {
      if (documentAuthorityRef.current === documentAuthority) documentAuthorityRef.current = null;
      if (refreshPublicationRef.current?.document === documentAuthority) refreshPublicationRef.current = null;
    };
  }, [documentAuthority]);

  useLayoutEffect(() => {
    authorityRef.current = authority;

    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;

      const request = requestOwnerRef.current;
      if (request?.authority === authority) {
        requestOwnerRef.current = null;
        request.controller.abort();
      }
      const polling = pollingOwnerRef.current;
      if (polling?.authority === authority) polling.retire();
    };
  }, [authority]);

  useEffect(() => {
    const hasAuthority = () => authorityRef.current === authority;
    if (!hasAuthority() || refreshPublication?.document === authority.document) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let retired = false;
    let changed = false;
    const stopTimer = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const stopRequest = () => {
      const request = requestOwnerRef.current;
      if (request?.authority !== authority) return;
      requestOwnerRef.current = null;
      request.controller.abort();
    };
    const stop = () => {
      stopTimer();
      stopRequest();
    };
    const check = async () => {
      if (retired || changed || !hasAuthority() || requestOwnerRef.current !== null || document.visibilityState !== "visible") return;
      const request: RequestOwner = { authority, controller: new AbortController() };
      requestOwnerRef.current = request;
      const ownsRequest = () =>
        !retired &&
        hasAuthority() &&
        requestOwnerRef.current === request &&
        !request.controller.signal.aborted;

      try {
        const res = await fetch(`/api/documents/${authority.document.docId}/content`, {
          cache: "no-store",
          signal: request.controller.signal,
        });
        if (!ownsRequest() || !res.ok) return;
        const data = (await res.json()) as { contentHash?: string };
        if (!ownsRequest() || document.visibilityState !== "visible") return;
        if (data.contentHash && data.contentHash !== authority.document.initialHash) {
          changed = true;
          stopTimer();
          const publication = Object.freeze<RefreshPublication>({ document: authority.document });
          refreshPublicationRef.current = publication;
          setRefreshPublication(publication);
        }
      } catch {
        // Offline or transient error: try again on the next tick.
      } finally {
        if (!retired && hasAuthority() && requestOwnerRef.current === request) requestOwnerRef.current = null;
      }
    };
    const start = () => {
      if (retired || changed || !hasAuthority() || document.visibilityState !== "visible") return;
      void check();
      if (timer !== null) return;
      timer = setInterval(() => void check(), authority.pollMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        start();
      } else stop();
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      if (pollingOwnerRef.current === polling) pollingOwnerRef.current = null;
    };
    const polling: PollingOwner = { authority, retire };

    pollingOwnerRef.current = polling;
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return retire;
  }, [authority, refreshPublication]);

  const currentPublication = refreshPublication?.document === documentAuthority ? refreshPublication : null;
  const controlRender = currentPublication
    ? Object.freeze<RefreshControlRender>({
        identity: Symbol("reader-update-control-render"),
        mount,
        document: documentAuthority,
        polling: authority,
        refresh: currentPublication,
      })
    : null;

  useLayoutEffect(() => {
    if (!controlRender) return;
    const pillOwner = pillOwnerRef.current;
    const buttonOwner = buttonOwnerRef.current;
    if (
      pillOwner?.render !== controlRender ||
      buttonOwner?.render !== controlRender ||
      documentAuthorityRef.current !== controlRender.document ||
      authorityRef.current !== controlRender.polling ||
      refreshPublicationRef.current !== controlRender.refresh ||
      !controlHasExpectedPresentation(pillOwner.element, buttonOwner.element)
    ) {
      return;
    }
    const location = window.location;
    const publication = Object.freeze<RefreshControlPublication>({
      render: controlRender,
      pill: pillOwner.element,
      button: buttonOwner.element,
      markup: pillOwner.element.outerHTML,
      reload: location.reload.bind(location),
    });
    controlPublicationRef.current = publication;
    return () => retireControlPublication(controlRender, controlPublicationRef);
  }, [controlRender]);

  if (!controlRender) return null;
  return (
    <div
      ref={(node) => {
        const owner = pillOwnerRef.current;
        if (node) {
          if (!owner || owner.render === controlRender) {
            if (owner?.element !== node) retireControlPublication(controlRender, controlPublicationRef);
            pillOwnerRef.current = Object.freeze({ render: controlRender, element: node });
          }
        } else {
          if (owner?.render === controlRender) pillOwnerRef.current = null;
          retireControlPublication(controlRender, controlPublicationRef);
        }
      }}
      className={PILL_CLASS_NAME}
      role="status"
      data-testid="reader-updated"
    >
      <button
        ref={(node) => {
          const owner = buttonOwnerRef.current;
          if (node) {
            if (!owner || owner.render === controlRender) {
              if (owner?.element !== node) retireControlPublication(controlRender, controlPublicationRef);
              buttonOwnerRef.current = Object.freeze({ render: controlRender, element: node });
            }
          } else {
            if (owner?.render === controlRender) buttonOwnerRef.current = null;
            retireControlPublication(controlRender, controlPublicationRef);
          }
        }}
        type="button"
        className={BUTTON_CLASS_NAME}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          const publication = currentControlPublication(
            controlRender,
            event.currentTarget,
            controlPublicationRef,
            claimedControlPublicationRef,
            documentAuthorityRef,
            authorityRef,
            refreshPublicationRef,
            pillOwnerRef,
            buttonOwnerRef,
          );
          if (!publication) return;
          claimedControlPublicationRef.current = publication;
          controlPublicationRef.current = null;
          refreshPublicationRef.current = null;
          publication.reload();
        }}
      >
        <span className={UPDATED_CLASS_NAME}>Updated</span>
        <span aria-hidden className={SEPARATOR_CLASS_NAME}>
          —
        </span>
        <RefreshCw size={14} className={ICON_CLASS_NAME} />
        Refresh
      </button>
    </div>
  );
}
