"use client";

import { useSyncExternalStore } from "react";
import { PREVIEW_FONTS, isPreviewFont, previewFontStore, setPreviewFont } from "@/lib/preview-font";

/** The preview's font choice: a small native select beside the Preview label, saved in this browser. */
export function PreviewFontSelect() {
  const font = useSyncExternalStore(previewFontStore.subscribe, previewFontStore.getSnapshot, previewFontStore.getServerSnapshot);
  return (
    <select
      className="preview-font-select"
      value={font}
      onChange={(e) => isPreviewFont(e.target.value) && setPreviewFont(e.target.value)}
      aria-label="Preview font"
      data-testid="preview-font-select"
    >
      {PREVIEW_FONTS.map((f) => (
        <option key={f.id} value={f.id}>
          {f.label}
        </option>
      ))}
    </select>
  );
}
