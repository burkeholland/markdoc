"use client";

import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";

type Format = "md" | "html" | "pdf";

const ROWS: { format: Format; label: string; Icon: typeof Download }[] = [
  { format: "md", label: "Markdown", Icon: Download },
  { format: "html", label: "HTML", Icon: FileCode2 },
  { format: "pdf", label: "PDF", Icon: FileText },
];
const FORMATS = ROWS.map(({ format }) => format);
const LIST_ID = "reader-download-list";
const PREVENT_SCROLL = Object.freeze({ preventScroll: true });

function exportHref(docId: string, format: Format) {
  return `/api/documents/${docId}/export?format=${format}&download=1`;
}

type PendingFocus = { format: Format; options?: FocusOptions };

function hasModifier(event: ReactKeyboardEvent) {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * "Download" split button: Markdown, HTML or PDF through the existing export route.
 * The "Download as…" half is a WAI-ARIA disclosure (a button that shows a list of links), not a Radix
 * menu: this was the public reader's only Radix consumer and its first load matters most. The list
 * stays in the DOM with `hidden` while closed, so `aria-controls` always resolves.
 */
export function DownloadMenu({ docId }: { docId: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const linkRefs = useRef<Partial<Record<Format, HTMLAnchorElement | null>>>({});
  const pendingFocus = useRef<PendingFocus | null>(null);

  const openWithFocus = (focus: PendingFocus) => {
    pendingFocus.current = focus;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (pending) {
      const link = linkRefs.current[pending.format];
      if (pending.options) link?.focus(pending.options);
      else link?.focus();
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const focusLink = (event: ReactKeyboardEvent, format: Format) => {
    event.preventDefault();
    linkRefs.current[format]?.focus(PREVENT_SCROLL);
  };

  const onToggleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (hasModifier(event)) return;
    const format = event.key === "ArrowDown" ? "md" : event.key === "ArrowUp" ? "pdf" : null;
    if (!format) return;
    if (open) {
      focusLink(event, format);
    } else {
      event.preventDefault();
      openWithFocus({ format, options: PREVENT_SCROLL });
    }
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || hasModifier(event)) return;
    const current = FORMATS.findIndex((format) => linkRefs.current[format] === event.target);
    if (current < 0) return;
    let next: number;
    if (event.key === "ArrowDown") next = (current + 1) % FORMATS.length;
    else if (event.key === "ArrowUp") next = (current - 1 + FORMATS.length) % FORMATS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FORMATS.length - 1;
    else return;
    focusLink(event, FORMATS[next]!);
  };

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || event.key !== "Escape" || hasModifier(event)) return;
    event.preventDefault();
    setOpen(false);
    toggleRef.current?.focus(PREVENT_SCROLL);
  };

  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (open && next && !rootRef.current?.contains(next as Node)) setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="relative flex items-stretch"
      onKeyDown={onRootKeyDown}
      onBlur={onRootBlur}
    >
      <a href={exportHref(docId, "md")} className="btn btn-sm btn-outline reader-split-main gap-1.5" aria-label="Download Markdown" data-testid="reader-download">
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
          if (open) setOpen(false);
          else openWithFocus({ format: "md" });
        }}
        onKeyDown={onToggleKeyDown}
        data-testid="reader-download-menu"
      >
        <ChevronDown size={14} className="shrink-0" />
      </button>
      <div
        id={LIST_ID}
        className="menu animate-fade-in absolute right-0 top-full mt-1.5 w-48"
        hidden={!open}
        onKeyDown={onListKeyDown}
        data-testid="reader-download-list"
      >
        {ROWS.map(({ format, label, Icon }) => (
          <a
            ref={(element) => {
              linkRefs.current[format] = element;
            }}
            key={format}
            href={exportHref(docId, format)}
            className="menu-item"
            onClick={() => {
              setOpen(false);
              toggleRef.current?.focus();
            }}
            data-testid={`reader-download-${format}`}
          >
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
