"use client";

import { ChevronDown } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/primitives";
import { PREVIEW_FONTS, isPreviewFont, previewFontStore, setPreviewFont } from "@/lib/preview-font";
import { previewCodeWrapStore, setPreviewCodeWrap } from "@/lib/preview-code-wrap";

/** Display preferences only: shared by this browser's previews, never written to a document. */
export function PreviewMenu() {
  const font = useSyncExternalStore(previewFontStore.subscribe, previewFontStore.getSnapshot, previewFontStore.getServerSnapshot);
  const wrap = useSyncExternalStore(previewCodeWrapStore.subscribe, previewCodeWrapStore.getSnapshot, previewCodeWrapStore.getServerSnapshot);
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-label="Wrap code blocks"
        aria-checked={wrap}
        className="preview-wrap-toggle"
        onClick={() => setPreviewCodeWrap(!wrap)}
      >
        Wrap code
        <span className="preview-wrap-track" aria-hidden />
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="preview-menu-trigger" aria-label="Preview font" data-testid="preview-menu-trigger">
            Font
            <ChevronDown size={13} aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent className="w-64 max-w-[calc(100vw-16px)] p-1.5" data-testid="preview-menu">
          <MenuLabel>Preview font</MenuLabel>
          <MenuRadioGroup value={font} onValueChange={(value) => isPreviewFont(value) && setPreviewFont(value)}>
            {PREVIEW_FONTS.map((f) => (
              <MenuRadioItem key={f.id} value={f.id} data-testid={`preview-font-${f.id}`}>
                <span className="font-semibold" style={{ fontFamily: f.family }}>
                  {f.label}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </>
  );
}
