"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { useCopy } from "@/lib/hooks";

/** Copies this document's canonical public URL without pulling the reader shell into the client graph. */
export function ReaderCopyLink({ docId }: { docId: string }) {
  const [origin, setOrigin] = useState("");
  const fallbackRef = useRef<HTMLInputElement>(null);

  // The browser's origin is canonical for this visit and keeps proxy headers out of the server render.
  useEffect(() => setOrigin(window.location.origin), []);
  const readerUrl = origin ? `${origin}/p/${docId}` : "";
  const link = useCopy(readerUrl, fallbackRef, "Copy link");

  useLayoutEffect(() => {
    if (link.status !== "fallback") return;
    fallbackRef.current?.focus({ preventScroll: true });
    fallbackRef.current?.select();
  }, [link.status, readerUrl]);

  const visibleLabel = link.copied ? "Copied" : "Copy link";
  return (
    <div className="relative flex shrink-0">
      <button
        type="button"
        className="btn btn-sm btn-outline h-11 w-11 shrink-0 gap-1.5 p-0 sm:h-8 sm:w-auto sm:px-3"
        aria-label={link.label}
        disabled={!origin}
        onClick={link.copy}
        data-testid="reader-copy-link"
      >
        {link.copied ? <Check size={14} className="text-success" /> : <Link2 size={14} />}
        <span className="hidden sm:inline" aria-hidden="true">
          {visibleLabel}
        </span>
      </button>
      {link.status === "fallback" && (
        <input
          ref={fallbackRef}
          className="input absolute right-0 top-full z-20 mt-2 w-[min(24rem,calc(100vw-2rem))] font-mono text-xs shadow-md"
          value={readerUrl}
          readOnly
          aria-label="Reader link"
          onFocus={(event) => event.currentTarget.select()}
          data-testid="reader-copy-link-fallback"
        />
      )}
    </div>
  );
}
