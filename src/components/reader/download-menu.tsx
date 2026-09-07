"use client";

import {
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
} from "react";
import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";

type Format = "md" | "html" | "pdf";
type ExportHrefs = Readonly<Record<Format, string>>;

interface DocumentVisit {
  readonly mount: symbol;
  readonly docId: string;
  readonly hrefs: ExportHrefs;
}

interface DisclosureVisit {
  readonly document: DocumentVisit;
}

interface DownloadState {
  readonly document: DocumentVisit;
  readonly disclosure: DisclosureVisit | null;
}

interface PresentationAuthority {
  readonly document: DocumentVisit;
  readonly sourceState: DownloadState;
  readonly state: DownloadState | null;
  readonly disclosure: DisclosureVisit | null;
  readonly open: boolean;
}

interface LinkPublication {
  readonly format: Format;
  readonly href: string;
  readonly capture: (element: HTMLAnchorElement | null) => void;
  readonly element: () => HTMLAnchorElement | null;
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}

interface DownloadPublication {
  readonly authority: PresentationAuthority;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly capturePrimary: (element: HTMLAnchorElement | null) => void;
  readonly captureToggle: (element: HTMLButtonElement | null) => void;
  readonly captureList: (element: HTMLDivElement | null) => void;
  readonly links: Readonly<Record<Format, LinkPublication>>;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onToggleClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onToggleKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onListKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onRootKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onRootBlur: (event: FocusEvent<HTMLDivElement>) => void;
}

class CurrentCell<T> {
  constructor(public current: T) {}
}

class ElementOwner<T extends HTMLElement> {
  private current: T | null = null;
  private last: T | null = null;

  constructor(private readonly onReplacement: () => void) {}

  readonly element = () => this.current;
  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const replaced = element !== null && this.last !== null && this.last !== element;
    this.current = element;
    if (element) this.last = element;
    if (replaced || element === null) this.onReplacement();
  };
}

interface PublicationCells {
  readonly active: CurrentCell<DownloadPublication | null>;
  readonly focused: WeakSet<DisclosureVisit>;
  readonly claimedEvents: WeakSet<object>;
}

const ROWS: { format: Format; label: string; Icon: typeof Download }[] = [
  { format: "md", label: "Markdown", Icon: Download },
  { format: "html", label: "HTML", Icon: FileCode2 },
  { format: "pdf", label: "PDF", Icon: FileText },
];
const FORMATS = ROWS.map(({ format }) => format);
const LIST_ID = "reader-download-list";

function createDownloadPublication({
  authority,
  cells,
  setState,
}: {
  authority: PresentationAuthority;
  cells: PublicationCells;
  setState: Dispatch<SetStateAction<DownloadState>>;
}): DownloadPublication {
  const mount = authority.document.mount;
  const docId = authority.document.docId;
  const hrefs = authority.document.hrefs;
  const sourceState = authority.sourceState;
  const retireForReplacement = () => publication?.retire();
  const rootOwner = new ElementOwner<HTMLDivElement>(retireForReplacement);
  const primaryOwner = new ElementOwner<HTMLAnchorElement>(retireForReplacement);
  const toggleOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
  const listOwner = new ElementOwner<HTMLDivElement>(retireForReplacement);
  const linkOwners = new Map<Format, ElementOwner<HTMLAnchorElement>>();
  let transitionClaimed = false;
  let pointerListening = false;

  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const primary = primaryOwner.element();
    const toggle = toggleOwner.element();
    const list = listOwner.element();
    if (
      !root ||
      !root.isConnected ||
      !primary ||
      !primary.isConnected ||
      primary.parentElement !== root ||
      root.children.item(0) !== primary ||
      root.children.length !== 3 ||
      primary.getAttribute("href") !== authority.document.hrefs.md ||
      !toggle ||
      !toggle.isConnected ||
      toggle.parentElement !== root ||
      root.children.item(1) !== toggle ||
      toggle.getAttribute("aria-expanded") !== String(authority.open) ||
      toggle.getAttribute("aria-controls") !== LIST_ID ||
      !list ||
      !list.isConnected ||
      list.parentElement !== root ||
      root.children.item(2) !== list ||
      list.id !== LIST_ID ||
      list.hidden === authority.open ||
      list.children.length !== FORMATS.length
    ) {
      return false;
    }

    return FORMATS.every((format, index) => {
      const link = publication.links[format];
      const element = linkOwners.get(format)?.element();
      return (
        link.format === format &&
        link.href === authority.document.hrefs[format] &&
        !!element &&
        element.isConnected &&
        element.parentElement === list &&
        list.children.item(index) === element &&
        element.getAttribute("href") === link.href
      );
    });
  };

  const factsAreCurrent = () =>
    authority.document.mount === mount &&
    authority.document.docId === docId &&
    authority.document.hrefs === hrefs &&
    authority.open === (authority.disclosure !== null) &&
    authority.sourceState === sourceState &&
    authority.state ===
      (sourceState.document === authority.document ? sourceState : null) &&
    (!authority.state ||
      (authority.state.document === authority.document &&
        authority.state.disclosure === authority.disclosure));
  const ownsIdentity = () =>
    cells.active.current === publication &&
    publication.authority === authority &&
    factsAreCurrent();
  const ownsAuthority = () => ownsIdentity() && exactDomIsCurrent();
  const ownsRoot = (element: HTMLDivElement) =>
    ownsAuthority() && rootOwner.element() === element && element.isConnected;
  const ownsToggle = (element: HTMLButtonElement) => {
    const root = rootOwner.element();
    return (
      ownsAuthority() &&
      toggleOwner.element() === element &&
      element.isConnected &&
      !!root &&
      element.parentElement === root
    );
  };
  const ownsList = (element: HTMLDivElement) => {
    const root = rootOwner.element();
    return (
      authority.open &&
      ownsAuthority() &&
      listOwner.element() === element &&
      element.isConnected &&
      !!root &&
      element.parentElement === root
    );
  };
  const ownsLink = (link: LinkPublication, element: HTMLAnchorElement) => {
    const list = listOwner.element();
    const index = FORMATS.indexOf(link.format);
    return (
      authority.open &&
      ownsAuthority() &&
      publication.links[link.format] === link &&
      linkOwners.get(link.format)?.element() === element &&
      element.isConnected &&
      !!list &&
      element.parentElement === list &&
      list.children.item(index) === element &&
      element.getAttribute("href") === link.href
    );
  };
  const ownsEventTarget = (target: EventTarget | null) => {
    if (!(target instanceof Node) || !target.isConnected) return false;
    const root = rootOwner.element();
    const primary = primaryOwner.element();
    const toggle = toggleOwner.element();
    const list = listOwner.element();
    if (target === root || target === list) return true;
    const elements = [
      primary,
      toggle,
      ...FORMATS.map((format) => linkOwners.get(format)?.element() ?? null),
    ];
    return elements.some((element) => !!element && (target === element || element.contains(target)));
  };
  const claimEvent = (event: object) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };
  const commitState = (next: DownloadState) => {
    setState((current) => current === authority.sourceState ? next : current);
  };
  const uninstallPointer = () => {
    if (!pointerListening) return;
    pointerListening = false;
    document.removeEventListener("pointerdown", onPointerDown);
  };
  const retire = () => {
    if (cells.active.current !== publication) return false;
    cells.active.current = null;
    uninstallPointer();
    return true;
  };
  const claimTransition = (event: object) => {
    if (transitionClaimed || !claimEvent(event)) return false;
    transitionClaimed = true;
    retire();
    return true;
  };
  const transition = (event: object, disclosure: DisclosureVisit | null, refocus: boolean) => {
    const root = rootOwner.element();
    const toggle = toggleOwner.element();
    if (!claimTransition(event)) return false;
    if (
      refocus &&
      root &&
      root === rootOwner.element() &&
      root.isConnected &&
      toggle &&
      toggle === toggleOwner.element() &&
      toggle.isConnected &&
      toggle.parentElement === root &&
      exactDomIsCurrent()
    ) {
      toggle.focus();
    }
    commitState(Object.freeze({ document: authority.document, disclosure }));
    return true;
  };
  const close = (event: object, refocus: boolean) =>
    authority.open && ownsAuthority() && transition(event, null, refocus);
  const open = (event: object) =>
    !authority.open &&
    ownsAuthority() &&
    transition(
      event,
      Object.freeze({ document: authority.document }),
      false,
    );

  const onPointerDown = (event: PointerEvent) => {
    if (!pointerListening || !authority.open || !ownsAuthority()) return;
    const target = event.target;
    if (!(target instanceof Node) || !target.isConnected) return;
    const root = rootOwner.element();
    if (!root || root.contains(target)) return;
    close(event, false);
  };
  const installPointer = () => {
    if (pointerListening || !authority.open || !ownsAuthority()) return;
    pointerListening = true;
    document.addEventListener("pointerdown", onPointerDown);
    if (!ownsAuthority()) uninstallPointer();
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    if (!exactDomIsCurrent()) return;
    cells.active.current = publication;
    const disclosure = authority.disclosure;
    if (authority.open && disclosure && !cells.focused.has(disclosure)) {
      const first = publication.links.md;
      const firstElement = linkOwners.get("md")?.element();
      if (firstElement && ownsLink(first, firstElement)) {
        cells.focused.add(disclosure);
        firstElement.focus();
      }
    }
    installPointer();
  };

  const links = Object.fromEntries(
    FORMATS.map((format) => {
      const owner = new ElementOwner<HTMLAnchorElement>(retireForReplacement);
      linkOwners.set(format, owner);
      const link: LinkPublication = Object.freeze({
        format,
        href: authority.document.hrefs[format],
        capture: owner.capture,
        element: owner.element,
        onClick: (event: MouseEvent<HTMLAnchorElement>) => {
          if (!ownsLink(link, event.currentTarget)) return;
          close(event, true);
        },
      });
      return [format, link];
    }),
  ) as Record<Format, LinkPublication>;

  const onToggleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (!ownsToggle(event.currentTarget)) return;
    if (authority.open) close(event, false);
    else open(event);
  };
  const onToggleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" || !ownsToggle(event.currentTarget)) return;
    if (authority.open) {
      const first = publication.links.md;
      const firstElement = linkOwners.get("md")?.element();
      if (!firstElement || !ownsLink(first, firstElement) || !claimEvent(event)) return;
      event.preventDefault();
      firstElement.focus();
      return;
    }
    if (!open(event)) return;
    event.preventDefault();
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !ownsList(event.currentTarget) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const current = FORMATS.findIndex((format) => linkOwners.get(format)?.element() === event.target);
    if (current < 0) return;
    let next: number;
    if (event.key === "ArrowDown") next = (current + 1) % FORMATS.length;
    else if (event.key === "ArrowUp") next = (current - 1 + FORMATS.length) % FORMATS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FORMATS.length - 1;
    else return;

    const destination = publication.links[FORMATS[next]!];
    const element = destination.element();
    if (!element || !ownsLink(destination, element) || !claimEvent(event)) return;
    event.preventDefault();
    element.focus();
  };
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "Escape" ||
      !authority.open ||
      !ownsRoot(event.currentTarget) ||
      !ownsEventTarget(event.target)
    ) {
      return;
    }
    if (!close(event, true)) return;
    event.preventDefault();
  };
  const onRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (
      !authority.open ||
      !ownsRoot(event.currentTarget) ||
      !ownsEventTarget(event.target)
    ) {
      return;
    }
    const related = event.relatedTarget;
    const root = rootOwner.element();
    if (!(related instanceof Node) || !related.isConnected || !root || root.contains(related)) return;
    close(event, false);
  };

  const publication: DownloadPublication = Object.freeze({
    authority,
    captureRoot: rootOwner.capture,
    capturePrimary: primaryOwner.capture,
    captureToggle: toggleOwner.capture,
    captureList: listOwner.capture,
    links: Object.freeze(links),
    establish,
    retire,
    onToggleClick,
    onToggleKeyDown,
    onListKeyDown,
    onRootKeyDown,
    onRootBlur,
  });
  return publication;
}

/**
 * "Download" split button: Markdown, HTML or PDF through the existing export route.
 * The "Download as…" half is a WAI-ARIA disclosure (a button that shows a list of links), not a Radix
 * menu: this was the public reader's only Radix consumer and its first load matters most. The list
 * stays in the DOM with `hidden` while closed, so `aria-controls` always resolves.
 */
export function DownloadMenu({ docId }: { docId: string }) {
  const [mount] = useState(() => Symbol("reader download menu"));
  const documentVisit = useMemo<DocumentVisit>(() => {
    const exportHref = (format: Format) => `/api/documents/${docId}/export?format=${format}&download=1`;
    return Object.freeze({
      mount,
      docId,
      hrefs: Object.freeze({
        md: exportHref("md"),
        html: exportHref("html"),
        pdf: exportHref("pdf"),
      }),
    });
  }, [docId, mount]);
  const [state, setState] = useState<DownloadState>(() =>
    Object.freeze({ document: documentVisit, disclosure: null }),
  );
  const [cells] = useState<PublicationCells>(() => ({
    active: new CurrentCell<DownloadPublication | null>(null),
    focused: new WeakSet<DisclosureVisit>(),
    claimedEvents: new WeakSet<object>(),
  }));
  const currentState = state.document === documentVisit ? state : null;
  const disclosure = currentState?.disclosure ?? null;
  const open = disclosure !== null;
  const publication = createDownloadPublication({
    authority: Object.freeze({
      document: documentVisit,
      sourceState: state,
      state: currentState,
      disclosure,
      open,
    }),
    cells,
    setState,
  });

  useLayoutEffect(() => {
    publication.establish();
    return () => {
      publication.retire();
    };
  }, [publication]);

  const {
    captureRoot,
    capturePrimary,
    captureToggle,
    captureList,
    links,
    onToggleClick,
    onToggleKeyDown,
    onListKeyDown,
    onRootKeyDown,
    onRootBlur,
  } = publication;

  return (
    <div ref={captureRoot} className="relative flex items-stretch" onKeyDown={onRootKeyDown} onBlur={onRootBlur}>
      <a ref={capturePrimary} href={documentVisit.hrefs.md} className="btn btn-sm btn-outline reader-split-main gap-1.5" aria-label="Download Markdown" data-testid="reader-download">
        <Download size={14} />
        <span className="hidden sm:inline">Download</span>
      </a>
      <button
        ref={captureToggle}
        type="button"
        className="btn btn-sm btn-outline reader-split-more"
        aria-label="Download as…"
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={onToggleClick}
        onKeyDown={onToggleKeyDown}
        data-testid="reader-download-menu"
      >
        <ChevronDown size={14} className="shrink-0" />
      </button>
      <div ref={captureList} id={LIST_ID} className="menu animate-fade-in absolute right-0 top-full mt-1.5 w-48" hidden={!open} onKeyDown={onListKeyDown} data-testid="reader-download-list">
        {ROWS.map(({ format, label, Icon }) => {
          const link = links[format];
          return (
            <a ref={link.capture} key={format} href={link.href} className="menu-item" onClick={link.onClick} data-testid={`reader-download-${format}`}>
              <span className="flex h-4 w-4 items-center justify-center text-ink-3">
                <Icon size={15} />
              </span>
              <span className="flex-1">{label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
