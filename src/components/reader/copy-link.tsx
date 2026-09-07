"use client";

import {
  useEffect,
  useLayoutEffect,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import { Check, Link2 } from "lucide-react";
import { useCopy } from "@/lib/hooks";

interface CopyAuthority {
  readonly mount: symbol;
  readonly docId: string;
  readonly origin: string;
  readonly readerUrl: string;
  readonly status: ReturnType<typeof useCopy>["status"];
  readonly label: string;
  readonly copied: boolean;
  readonly copy: () => void;
}

interface PublicationCells {
  readonly active: { current: CopyPublication | null };
  readonly claimedEvents: WeakSet<object>;
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

interface CopyPublication {
  readonly authority: CopyAuthority;
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureButton: (element: HTMLButtonElement | null) => void;
  readonly captureFallback: (element: HTMLInputElement | null) => void;
  readonly establish: () => void;
  readonly retire: () => boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly onFallbackFocus: (event: FocusEvent<HTMLInputElement>) => void;
}

function createCopyPublication(
  authority: CopyAuthority,
  cells: PublicationCells,
): CopyPublication {
  const mount = authority.mount;
  const docId = authority.docId;
  const origin = authority.origin;
  const readerUrl = authority.readerUrl;
  const status = authority.status;
  const label = authority.label;
  const copied = authority.copied;
  const copy = authority.copy;
  const retireForReplacement = () => publication.retire();
  const rootOwner = new ElementOwner<HTMLDivElement>(retireForReplacement);
  const buttonOwner = new ElementOwner<HTMLButtonElement>(retireForReplacement);
  const fallbackOwner = new ElementOwner<HTMLInputElement>(retireForReplacement);
  let activationClaimed = false;
  let selectionClaimed = false;
  let focusingFallback = false;
  let fallbackSelected = false;

  const factsAreCurrent = () =>
    authority.mount === mount &&
    authority.docId === docId &&
    authority.origin === origin &&
    authority.readerUrl === readerUrl &&
    authority.status === status &&
    authority.label === label &&
    authority.copied === copied &&
    authority.copy === copy &&
    readerUrl === (origin ? `${origin}/p/${docId}` : "");
  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const fallback = fallbackOwner.element();
    const fallbackExpected = status === "fallback";
    if (
      !origin ||
      !root ||
      !root.isConnected ||
      root.tagName !== "DIV" ||
      !button ||
      !button.isConnected ||
      button.tagName !== "BUTTON" ||
      buttonOwner.element() !== button ||
      button.parentElement !== root ||
      root.children.item(0) !== button ||
      button.type !== "button" ||
      button.disabled ||
      button.dataset.testid !== "reader-copy-link" ||
      button.getAttribute("aria-label") !== label ||
      button.textContent?.trim() !== (copied ? "Copied" : "Copy link") ||
      root.children.length !== (fallbackExpected ? 2 : 1)
    ) {
      return false;
    }
    if (!fallbackExpected) return fallback === null;
    return (
      !!fallback &&
      fallback.isConnected &&
      fallback.tagName === "INPUT" &&
      fallback.parentElement === root &&
      root.children.item(1) === fallback &&
      fallback.dataset.testid === "reader-copy-link-fallback" &&
      fallback.getAttribute("aria-label") === "Reader link" &&
      fallback.readOnly &&
      fallback.value === readerUrl
    );
  };
  const ownsIdentity = () =>
    cells.active.current === publication &&
    publication.authority === authority &&
    factsAreCurrent();
  const ownsAuthority = () => ownsIdentity() && exactDomIsCurrent();
  const ownsButton = (button: HTMLButtonElement) =>
    ownsAuthority() &&
    buttonOwner.element() === button &&
    button.isConnected &&
    !button.disabled &&
    button.getAttribute("aria-label") === label;
  const ownsFallback = (fallback: HTMLInputElement) =>
    status === "fallback" &&
    ownsAuthority() &&
    fallbackOwner.element() === fallback &&
    fallback.isConnected &&
    fallback.value === readerUrl;
  const claimEvent = (event: object) => {
    if (cells.claimedEvents.has(event)) return false;
    cells.claimedEvents.add(event);
    return true;
  };
  const claimSelection = () => {
    if (selectionClaimed) return false;
    selectionClaimed = true;
    return true;
  };
  const retire = () => {
    if (cells.active.current !== publication) return false;
    cells.active.current = null;
    return true;
  };
  const selectFallback = () => {
    const fallback = fallbackOwner.element();
    if (!fallback || !ownsFallback(fallback) || !claimSelection()) return;
    focusingFallback = true;
    try {
      fallback.focus({ preventScroll: true });
    } finally {
      focusingFallback = false;
    }
    if (ownsFallback(fallback) && !fallbackSelected) {
      fallbackSelected = true;
      fallback.select();
    }
  };
  const establish = () => {
    const previous = cells.active.current;
    if (previous && previous !== publication) previous.retire();
    if (!factsAreCurrent() || !exactDomIsCurrent()) return;
    cells.active.current = publication;
    if (status === "fallback") selectFallback();
  };
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (
      activationClaimed ||
      !ownsButton(event.currentTarget) ||
      !claimEvent(event)
    ) {
      return;
    }
    activationClaimed = true;
    copy();
  };
  const onFallbackFocus = (event: FocusEvent<HTMLInputElement>) => {
    if (!ownsFallback(event.currentTarget)) return;
    if (focusingFallback) {
      if (!selectionClaimed || fallbackSelected) return;
    } else {
      if (selectionClaimed || !claimEvent(event)) return;
      selectionClaimed = true;
    }
    fallbackSelected = true;
    event.currentTarget.select();
  };

  const publication: CopyPublication = Object.freeze({
    authority,
    captureRoot: rootOwner.capture,
    captureButton: buttonOwner.capture,
    captureFallback: fallbackOwner.capture,
    establish,
    retire,
    onClick,
    onFallbackFocus,
  });
  return publication;
}

/** Copies this document's canonical public URL without pulling the reader shell into the client graph. */
export function ReaderCopyLink({ docId }: { docId: string }) {
  const [mount] = useState(() => Symbol("reader copy link"));
  const [origin, setOrigin] = useState("");
  const [cells] = useState<PublicationCells>(() => ({
    active: { current: null },
    claimedEvents: new WeakSet<object>(),
  }));

  // The browser's origin is canonical for this visit and keeps proxy headers out of the server render.
  useEffect(() => setOrigin(window.location.origin), []);
  const readerUrl = origin ? `${origin}/p/${docId}` : "";
  const link = useCopy(readerUrl, undefined, "Copy link");
  const publication = createCopyPublication(
    Object.freeze({
      mount,
      docId,
      origin,
      readerUrl,
      status: link.status,
      label: link.label,
      copied: link.copied,
      copy: link.copy,
    }),
    cells,
  );

  useLayoutEffect(() => {
    publication.establish();
    return () => {
      publication.retire();
    };
  }, [publication]);

  const {
    captureRoot,
    captureButton,
    captureFallback,
    onClick,
    onFallbackFocus,
  } = publication;
  const visibleLabel = link.copied ? "Copied" : "Copy link";
  return (
    <div
      ref={captureRoot}
      className="relative flex shrink-0"
    >
      <button
        ref={captureButton}
        type="button"
        className="btn btn-sm btn-outline h-11 w-11 shrink-0 gap-1.5 p-0 sm:h-8 sm:w-auto sm:px-3"
        aria-label={link.label}
        disabled={!origin}
        onClick={onClick}
        data-testid="reader-copy-link"
      >
        {link.copied ? <Check size={14} className="text-success" /> : <Link2 size={14} />}
        <span className="hidden sm:inline" aria-hidden="true">
          {visibleLabel}
        </span>
      </button>
      {link.status === "fallback" && (
        <input
          ref={captureFallback}
          className="input absolute right-0 top-full z-20 mt-2 w-[min(24rem,calc(100vw-2rem))] font-mono text-xs shadow-md"
          value={readerUrl}
          readOnly
          aria-label="Reader link"
          onFocus={onFallbackFocus}
          data-testid="reader-copy-link-fallback"
        />
      )}
    </div>
  );
}
