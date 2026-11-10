"use client";

import { useLinkStatus } from "next/link";
import { createPortal } from "react-dom";
import { EditorChrome } from "@/components/editor/editor-chrome";

/**
 * Inside a document card's `<Link>`: from the click until the document page is ready, the editor's empty
 * chrome covers the dashboard. The page is rendered on the server per request, so without this the
 * dashboard stayed on screen, unchanged, for the whole round trip (0.2 s on a desktop, a second or more on
 * a phone) and then the editor appeared at once. The boxes are the editor's own, so nothing moves when the
 * real page takes over.
 */
export function OpeningDocument() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return createPortal(
    <div className="fixed inset-0 z-50" data-testid="opening-document">
      <p className="sr-only" role="status">
        Opening the document…
      </p>
      <EditorChrome decorative aria-hidden />
    </div>,
    document.body,
  );
}
