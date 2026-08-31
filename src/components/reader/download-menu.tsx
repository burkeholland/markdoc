"use client";

import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";
import { navigateTo } from "@/lib/nav";

type Format = "md" | "html" | "pdf";
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const links = () => Array.from(listRef.current?.querySelectorAll("a") ?? []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) toggleRef.current?.focus();
  };

  // Opening moves focus to the first link (what the Radix menu did).
  useEffect(() => {
    if (open) listRef.current?.querySelector("a")?.focus();
  }, [open]);

  // A pointer down outside the component closes it; listened to only while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node && rootRef.current?.contains(e.target))) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onToggleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (open) links()[0]?.focus();
    else setOpen(true);
  };

  // Arrow keys move between the links and wrap, Home/End jump; Tab is native.
  const onListKeyDown = (e: KeyboardEvent) => {
    const items = links();
    const current = items.indexOf(e.target as HTMLAnchorElement);
    const jump: Record<string, number | undefined> = { ArrowDown: current + 1, ArrowUp: current - 1 + items.length, Home: 0, End: items.length - 1 };
    const next = jump[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[next % items.length]?.focus();
  };

  const onRootKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    close(true);
  };

  // Focus moving to an element outside the component (Tab past the last link) closes the list. A null
  // relatedTarget (window blur, or Safari pressing a button it does not focus) is left to the pointer-down
  // listener, so a click on the toggle still closes instead of closing and reopening.
  const onRootBlur = (e: FocusEvent) => {
    if (open && e.relatedTarget instanceof Node && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative flex items-stretch" onKeyDown={onRootKeyDown} onBlur={onRootBlur}>
      <button type="button" className="btn btn-sm btn-outline reader-split-main gap-1.5" aria-label="Download Markdown" onClick={() => navigateTo(href("md"))} data-testid="reader-download">
        <Download size={14} />
        <span className="hidden sm:inline">Download</span>
      </button>
      <button
        ref={toggleRef}
        type="button"
        className="btn btn-sm btn-outline reader-split-more"
        aria-label="Download as…"
        aria-expanded={open}
        aria-controls={LIST_ID}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onToggleKeyDown}
        data-testid="reader-download-menu"
      >
        <ChevronDown size={14} className="shrink-0" />
      </button>
      <div ref={listRef} id={LIST_ID} className="menu animate-fade-in absolute right-0 top-full mt-1.5 w-48" hidden={!open} onKeyDown={onListKeyDown} data-testid="reader-download-list">
        {ROWS.map(({ format, label, Icon }) => (
          <a key={format} href={href(format)} className="menu-item" onClick={() => close(true)} data-testid={`reader-download-${format}`}>
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
