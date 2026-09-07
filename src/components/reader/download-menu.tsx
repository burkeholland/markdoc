"use client";

import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";

type Format = "md" | "html" | "pdf";
type DocumentVisit = { docId: string };
type DisclosureVisit = { document: DocumentVisit };
const ROWS: { format: Format; label: string; Icon: typeof Download }[] = [
  { format: "md", label: "Markdown", Icon: Download },
  { format: "html", label: "HTML", Icon: FileCode2 },
  { format: "pdf", label: "PDF", Icon: FileText },
];
const LIST_ID = "reader-download-list";

/**
 * "Download" split button: Markdown, HTML or PDF through the existing export route.
 * The "Download as…" half is a WAI-ARIA disclosure (a button that shows a list of links), not a Radix
 * menu: this was the public reader's only Radix consumer and its first load matters most. The list
 * stays in the DOM with `hidden` while closed, so `aria-controls` always resolves.
 */
export function DownloadMenu({ docId }: { docId: string }) {
  const href = (format: Format) => `/api/documents/${docId}/export?format=${format}&download=1`;
  const [documentVisit, setDocumentVisit] = useState<DocumentVisit>(() => ({ docId }));
  const [disclosureVisit, setDisclosureVisit] = useState<DisclosureVisit | null>(null);
  if (documentVisit.docId !== docId) setDocumentVisit({ docId });

  const ownsDocument = documentVisit.docId === docId;
  const disclosure = ownsDocument && disclosureVisit?.document === documentVisit ? disclosureVisit : null;
  const open = disclosure !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeDocument = useRef<DocumentVisit | null>(null);
  const activeDisclosure = useRef<DisclosureVisit | null>(null);
  const focusedDisclosure = useRef<DisclosureVisit | null>(null);

  useLayoutEffect(() => {
    activeDocument.current = documentVisit;
    return () => {
      if (activeDocument.current === documentVisit) activeDocument.current = null;
      if (activeDisclosure.current?.document === documentVisit) activeDisclosure.current = null;
    };
  }, [documentVisit]);

  const links = (owner: DisclosureVisit | null) => {
    if (!owner || activeDocument.current !== owner.document || activeDisclosure.current !== owner) return [];
    return Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  };
  const close = (owner: DisclosureVisit | null, refocus: boolean) => {
    if (!owner || activeDocument.current !== owner.document || activeDisclosure.current !== owner) return;
    activeDisclosure.current = null;
    setDisclosureVisit((current) => (current === owner ? null : current));
    if (refocus && activeDocument.current === owner.document) toggleRef.current?.focus();
  };
  const show = (owner: DocumentVisit) => {
    if (activeDocument.current !== owner) return;
    const next = { document: owner };
    setDisclosureVisit((current) => (activeDocument.current === owner && current?.document !== owner ? next : current));
  };

  // Focus and outside-pointer ownership are installed and retired in the same layout-phase visit.
  useLayoutEffect(() => {
    const owner = disclosure;
    if (!owner || activeDocument.current !== owner.document) return;
    activeDisclosure.current = owner;
    if (focusedDisclosure.current !== owner) {
      focusedDisclosure.current = owner;
      listRef.current?.querySelector("a")?.focus();
    }
    const root = rootRef.current;
    let listening = true;
    const onPointerDown = (e: PointerEvent) => {
      if (!listening || activeDisclosure.current !== owner) return;
      if (!(e.target instanceof Node && root?.contains(e.target))) close(owner, false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      listening = false;
      document.removeEventListener("pointerdown", onPointerDown);
      if (activeDisclosure.current === owner) activeDisclosure.current = null;
    };
  }, [disclosure]);

  const onToggleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" || activeDocument.current !== documentVisit) return;
    e.preventDefault();
    if (disclosure) links(disclosure)[0]?.focus();
    else show(documentVisit);
  };

  // Arrow keys move between the links and wrap, Home/End jump; Tab is native.
  const onListKeyDown = (e: KeyboardEvent) => {
    const items = links(disclosure);
    if (!items.length) return;
    const current = items.indexOf(e.target as HTMLAnchorElement);
    const jump: Record<string, number | undefined> = { ArrowDown: current + 1, ArrowUp: current - 1 + items.length, Home: 0, End: items.length - 1 };
    const next = jump[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[next % items.length]?.focus();
  };

  const onRootKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !disclosure || activeDisclosure.current !== disclosure) return;
    e.preventDefault();
    close(disclosure, true);
  };

  // Focus moving to an element outside the component (Tab past the last link) closes the list. A null
  // relatedTarget (window blur, or Safari pressing a button it does not focus) is left to the pointer-down
  // listener, so a click on the toggle still closes instead of closing and reopening.
  const onRootBlur = (e: FocusEvent) => {
    if (disclosure && e.relatedTarget instanceof Node && !rootRef.current?.contains(e.relatedTarget)) close(disclosure, false);
  };

  return (
    <div ref={rootRef} className="relative flex items-stretch" onKeyDown={onRootKeyDown} onBlur={onRootBlur}>
      <a href={href("md")} className="btn btn-sm btn-outline reader-split-main gap-1.5" aria-label="Download Markdown" data-testid="reader-download">
        <Download size={14} />
        <span className="hidden sm:inline">Download</span>
      </a>
      <button
        ref={toggleRef}
        type="button"
        className="btn btn-sm btn-outline reader-split-more"
        aria-label="Download as…"
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={() => {
          if (disclosure) close(disclosure, false);
          else show(documentVisit);
        }}
        onKeyDown={onToggleKeyDown}
        data-testid="reader-download-menu"
      >
        <ChevronDown size={14} className="shrink-0" />
      </button>
      <div ref={listRef} id={LIST_ID} className="menu animate-fade-in absolute right-0 top-full mt-1.5 w-48" hidden={!open} onKeyDown={onListKeyDown} data-testid="reader-download-list">
        {ROWS.map(({ format, label, Icon }) => (
          <a key={format} href={href(format)} className="menu-item" onClick={() => close(disclosure, true)} data-testid={`reader-download-${format}`}>
            <span className="flex h-4 w-4 items-center justify-center text-ink-3">
              <Icon size={15} />
            </span>
            <span className="flex-1">{label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
